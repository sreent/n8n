// Fork service (not in upstream n8n): the workflow sharing service of the fork, in place of the
// enterprise `workflow.service.ee.ts` for ordinary code. packages/cli/src/workflows/FORK.md
// describes its behaviour.
import { CredentialsFinderService } from '@n8n/backend-services';
import type {
	CredentialUsedByWorkflow,
	EntityManager,
	User,
	WorkflowEntity,
	WorkflowWithSharingsAndCredentials,
	WorkflowWithSharingsMetaDataAndCredentials,
} from '@n8n/db';
import {
	chunkIds,
	CredentialsRepository,
	FolderRepository,
	SharedWorkflowRepository,
	SharingRepository,
	WorkflowPublishHistoryRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, NotFoundError, UserError } from '@n8n/errors';
import type {
	INode,
	INodeCredentials,
	INodeCredentialsDetails,
	INodeParameters,
} from 'n8n-workflow';
import {
	EXECUTE_WORKFLOW_NODE_TYPE,
	jsonParse,
	PROJECT_ROOT,
	RETRIEVER_WORKFLOW_LANGCHAIN_NODE_TYPE,
	WORKFLOW_TOOL_LANGCHAIN_NODE_TYPE,
	WorkflowActivationError,
} from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { isCredSharingEnabled } from '@/constants/credential-sharing';
import { CredentialsService } from '@/credentials/credentials.service';
import { FolderNotFoundError } from '@/errors/folder-not-found.error';
import { TransferWorkflowError } from '@/errors/response-errors/transfer-workflow.error';
import { FolderService } from '@/services/folder.service';
import { PolicyEnforcementService } from '@/policy/policy-enforcement.service';
import { OwnershipService } from '@/services/ownership.service';
import { ProjectService } from '@/services/project.service';

import { WorkflowFinderService } from './workflow-finder.service';
import { WorkflowMutationHooksProxy } from './workflow-mutation-hooks-proxy.service';

/** The ids of the credentials that the nodes reference. References by name only have no id. */
function credentialIdsOf(nodes: INode[] = []) {
	const ids = new Set<string>();
	for (const node of nodes) {
		for (const credential of Object.values(node.credentials ?? {})) {
			if (typeof credential === 'object' && credential?.id) ids.add(credential.id);
		}
	}
	return [...ids];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseObject(value: unknown) {
	if (isObject(value)) return value;
	if (typeof value !== 'string') return undefined;
	const parsed = jsonParse<unknown>(value, { fallbackValue: null });
	return isObject(parsed) ? parsed : undefined;
}

/** The parts of a node that hold credential references. */
interface NodeReferences {
	type?: string;
	parameters?: INodeParameters;
	credentials?: INodeCredentials;
}

/** A node of an inline sub-workflow. The user writes its JSON, so only its shape is known. */
function isNodeReferences(value: unknown): value is NodeReferences {
	return (
		isObject(value) &&
		(value.type === undefined || typeof value.type === 'string') &&
		(value.parameters === undefined || isObject(value.parameters)) &&
		(value.credentials === undefined || isObject(value.credentials))
	);
}

/** The node types that can run an inline sub-workflow (`workflowJson`). */
const WORKFLOW_SELECTOR_TYPES: Array<string | undefined> = [
	EXECUTE_WORKFLOW_NODE_TYPE,
	WORKFLOW_TOOL_LANGCHAIN_NODE_TYPE,
	RETRIEVER_WORKFLOW_LANGCHAIN_NODE_TYPE,
];

/**
 * The credential references of a node that a sharing check must cover: the credentials of the
 * node, the credentials of an inline agent (`inlineAgent`), and the credentials of the nodes of an
 * inline sub-workflow. `null` is a reference without an id that n8n can check. A reference by
 * name only, and a Gateway credential that n8n manages, give nothing.
 */
function credentialReferencesOf(node: NodeReferences): Array<string | null> {
	const references: Array<string | null> = [];
	for (const credential of Object.values(node.credentials ?? {})) {
		const id: unknown = credential.id;
		if (id === undefined || (id === null && credential.__aiGatewayManaged === true)) continue;
		references.push(id ? String(id) : null);
	}

	// An inline agent references its credentials by id. Only a non-empty string is a reference.
	const config = parseObject(node.parameters?.inlineAgent)?.config;
	if (isObject(config)) {
		if (typeof config.credential === 'string' && config.credential) {
			references.push(config.credential);
		}
		for (const tool of Array.isArray(config.tools) ? config.tools : []) {
			const toolNode = isObject(tool) ? tool.node : undefined;
			const credentials = isObject(toolNode) ? toolNode.credentials : undefined;
			for (const credential of Object.values(isObject(credentials) ? credentials : {})) {
				const id = isObject(credential) ? credential.id : undefined;
				if (typeof id === 'string' && id) references.push(id);
			}
		}
	}

	const workflowJson = node.parameters?.workflowJson;
	if (WORKFLOW_SELECTOR_TYPES.includes(node.type) && typeof workflowJson === 'string') {
		const subWorkflow = parseObject(workflowJson);
		for (const subNode of Array.isArray(subWorkflow?.nodes) ? subWorkflow.nodes : []) {
			if (isNodeReferences(subNode)) references.push(...credentialReferencesOf(subNode));
		}
	}
	return references;
}

@Service()
export class EnterpriseWorkflowService {
	constructor(
		private readonly sharingRepository: SharingRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly folderRepository: FolderRepository,
		private readonly workflowPublishHistoryRepository: WorkflowPublishHistoryRepository,
		private readonly credentialsService: CredentialsService,
		private readonly credentialsFinderService: CredentialsFinderService,
		private readonly ownershipService: OwnershipService,
		private readonly projectService: ProjectService,
		private readonly folderService: FolderService,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly activeWorkflowManager: ActiveWorkflowManager,
		private readonly policyEnforcementService: PolicyEnforcementService,
		private readonly workflowMutationHooks: WorkflowMutationHooksProxy,
	) {}

	/**
	 * Share a workflow with projects, in the transaction of the caller. Only personal projects get
	 * the share, and the project that owns the workflow gets none.
	 */
	async shareWithProjects(
		workflowId: string,
		shareWithIds: string[],
		entityManager: EntityManager,
	) {
		const projects = await this.sharingRepository.findProjects(shareWithIds, entityManager);
		return await this.sharingRepository.shareWorkflow(
			workflowId,
			projects.filter(({ type }) => type === 'personal').map(({ id }) => id),
			entityManager,
		);
	}

	/** Add the home project, the projects that it is shared with, and an empty credential list. */
	addOwnerAndSharings(
		workflow: WorkflowWithSharingsAndCredentials,
	): WorkflowWithSharingsMetaDataAndCredentials {
		const { homeProject, sharedWithProjects } =
			this.ownershipService.addOwnedByAndSharedWith(workflow);
		return Object.assign(workflow, { homeProject, sharedWithProjects, usedCredentials: [] });
	}

	/** Describe the credentials that the workflow uses, and which of them the user can use in it. */
	async addCredentialsToWorkflow(
		workflow: WorkflowWithSharingsMetaDataAndCredentials,
		currentUser: User,
	) {
		const usable = await this.credentialIdsForUsedList(currentUser, { workflowId: workflow.id });
		workflow.usedCredentials = await this.describeCredentials(
			credentialIdsOf(workflow.nodes),
			usable,
		);
	}

	/**
	 * The ids of the credentials that the nodes reference, also in inline agents and inline
	 * sub-workflows. A reference that n8n cannot check sets `hasUnresolved`.
	 */
	collectCredentialReferences(workflow: Pick<WorkflowEntity, 'nodes'>) {
		const ids = new Set<string>();
		let hasUnresolved = false;
		for (const node of workflow.nodes ?? []) {
			for (const id of credentialReferencesOf(node)) {
				if (id === null) hasUnresolved = true;
				else ids.add(id);
			}
		}
		return { ids, hasUnresolved };
	}

	/** Throw when the workflow references a credential outside `allowedCredentialIds`. */
	validateCredentialPermissionsToUser(
		workflow: Pick<WorkflowEntity, 'nodes'>,
		allowedCredentialIds: Set<string>,
	) {
		const { ids, hasUnresolved } = this.collectCredentialReferences(workflow);
		if (hasUnresolved || [...ids].some((id) => !allowedCredentialIds.has(id))) {
			throw new UserError('The workflow contains credentials that you do not have access to');
		}
	}

	/** The ids of the workflows that use an end-user (resolvable) credential. */
	async getWorkflowIdsWithResolvableCredentials(workflowIds: string[]) {
		const workflows = await this.workflowRepository.findByIds(workflowIds, { fields: ['nodes'] });
		const credentialIds = [...new Set(workflows.flatMap(({ nodes }) => credentialIdsOf(nodes)))];
		const resolvable = new Set<string>();
		for (const chunk of chunkIds(credentialIds)) {
			for (const credential of await this.credentialsRepository.getManyByIds(chunk)) {
				if (credential.isResolvable) resolvable.add(credential.id);
			}
		}
		return new Set(
			workflows
				.filter(({ nodes }) => credentialIdsOf(nodes).some((id) => resolvable.has(id)))
				.map(({ id }) => id),
		);
	}

	/**
	 * Describe the credentials that the workflows in a folder and its subfolders use. Only the
	 * workflows that the user can read count.
	 */
	async getFolderUsedCredentials(
		user: User,
		folderId: string,
		projectId: string,
	): Promise<CredentialUsedByWorkflow[]> {
		await this.folderService.findFolderInProjectOrFail(folderId, projectId);
		const workflowIds = await this.workflowFinderService.findAllWorkflowIdsForUser(
			user,
			['workflow:read'],
			folderId,
			projectId,
		);
		const workflows = await this.workflowRepository.findByIds(workflowIds, { fields: ['nodes'] });
		const usable = await this.credentialIdsForUsedList(user, { projectId });
		return await this.describeCredentials(
			[...new Set(workflows.flatMap(({ nodes }) => credentialIdsOf(nodes)))],
			usable,
		);
	}

	/**
	 * Check the nodes of an update before it is saved, and change them in place. A node that uses
	 * only credentials that the user can use in the workflow stays as it is. A node that had a
	 * credential that the user cannot use gets its stored version back, with the new name, position
	 * and `disabled` flag. Another node with such a credential is an error.
	 */
	async preventTampering<T extends { nodes?: INode[] }>(
		workflow: T,
		workflowId: string,
		user: User,
	): Promise<T> {
		const previous = await this.workflowRepository.findOneBy({ id: workflowId });
		if (!previous) throw new NotFoundError('Workflow not found');
		if (!workflow.nodes) return workflow;

		const hasMissingCredential = workflow.nodes.some((node) =>
			Object.values(node.credentials ?? {}).some(
				(credential: INodeCredentialsDetails | null | undefined) =>
					credential === null || credential === undefined,
			),
		);
		if (hasMissingCredential) {
			throw new BadRequestError(
				'Invalid workflow credentials - make sure you have access to all credentials and try again.',
			);
		}

		const usable = await this.usableCredentialIds(user, { workflowId });
		const canUse = (node: INode) =>
			credentialReferencesOf(node).every((id) => id !== null && usable.has(id));

		// A stored node with a credential that the user cannot use is read-only. An update of it
		// gets the stored version back, when exactly one node of the update has its id.
		const readOnlyIds = new Set(previous.nodes.filter((node) => !canUse(node)).map(({ id }) => id));
		const idCounts = new Map<string | undefined, number>();
		for (const { id } of workflow.nodes) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);

		workflow.nodes = workflow.nodes.map((node) => {
			if (canUse(node)) return node;
			const previousNode = previous.nodes.find(({ id }) => id === node.id);
			if (previousNode && readOnlyIds.has(node.id) && idCounts.get(node.id) === 1) {
				// Only the keys that the update has, so that an unchanged node equals the stored one.
				return {
					...previousNode,
					name: node.name,
					position: node.position,
					...('disabled' in node ? { disabled: node.disabled } : {}),
				};
			}
			throw new BadRequestError(
				`You don't have access to the credentials in the '${node.name}' node. Ask the owner to share them with you.`,
			);
		});
		return workflow;
	}

	/**
	 * Move a workflow to another project, or to another folder of its project. The project becomes
	 * its owner, and all other shares go. The user needs `workflow:move` on the workflow and
	 * `workflow:create` in the destination project, and the transfer policy of that project must
	 * allow the workflow. The credentials in `shareCredentials` that the user may share are shared
	 * with the project. An active workflow is activated again, and an activation error is the
	 * result.
	 */
	async transferWorkflow(
		user: User,
		workflowId: string,
		destinationProjectId: string,
		shareCredentials: string[] = [],
		destinationParentFolderId?: string,
	) {
		const workflow = await this.workflowFinderService.findWorkflowForUser(
			workflowId,
			user,
			['workflow:move'],
			{ includeParentFolder: true },
		);
		if (!workflow) {
			throw new NotFoundError(
				`Could not find workflow with the id "${workflowId}". Make sure you have the permission to move it.`,
			);
		}

		const destinationProject = await this.findDestinationProject(user, destinationProjectId);

		if (destinationParentFolderId) {
			try {
				await this.folderService.findFolderInProjectOrFail(
					destinationParentFolderId,
					destinationProject.id,
				);
			} catch (error) {
				if (!(error instanceof FolderNotFoundError)) throw error;
				throw new TransferWorkflowError(
					`The destination folder with id "${destinationParentFolderId}" does not exist in the project "${destinationProject.name}".`,
				);
			}
		}

		const sourceProject = await this.sharedWorkflowRepository.getWorkflowOwningProject(workflowId);
		if (
			sourceProject?.id === destinationProject.id &&
			(workflow.parentFolder?.id ?? null) === (destinationParentFolderId ?? null)
		) {
			throw new TransferWorkflowError(
				"You can't transfer a workflow into the same destination it already belongs to.",
			);
		}

		await this.policyEnforcementService.enforceWorkflowTransfer(
			{ workflow, targetProjectId: destinationProject.id },
			{ kind: 'user', user },
		);

		const credentialIds = await this.shareableCredentialIds(user, shareCredentials);
		const { activeVersionId } = workflow;
		if (activeVersionId) await this.activeWorkflowManager.remove(workflowId);

		await this.sharingRepository.transferWorkflow(
			workflowId,
			destinationProject.id,
			destinationParentFolderId ?? null,
			credentialIds,
		);
		await this.ownershipService.invalidateWorkflowProjectCacheByIds([workflowId]);
		// A move inside the same project changes only the folder, not the owner.
		if (sourceProject?.id !== destinationProject.id) {
			await this.workflowMutationHooks.afterWorkflowsTransferred([workflowId], user.id);
		}

		if (activeVersionId) return await this.activateAgain(user, workflowId, activeVersionId);
		return undefined;
	}

	/**
	 * Move a folder, its subfolders and their workflows to another project. The project becomes the
	 * owner of the workflows, and all other shares go. A workflow that the project owns already is
	 * an error. The user needs `workflow:create` in the destination project. The caller checks the
	 * source project. The credentials in `shareCredentials` that the user may share are shared with
	 * the project. The active workflows are activated again. A workflow with an activation error
	 * stays inactive, and the transfer continues.
	 */
	async transferFolder(
		user: User,
		sourceProjectId: string,
		sourceFolderId: string,
		destinationProjectId: string,
		destinationParentFolderId: string,
		shareCredentials: string[] = [],
	) {
		const destinationProject = await this.findDestinationProject(user, destinationProjectId);
		if (destinationParentFolderId !== PROJECT_ROOT) {
			await this.folderRepository.findOneOrFailFolderInProject(
				destinationParentFolderId,
				destinationProject.id,
			);
		}
		await this.folderRepository.findOneOrFailFolderInProject(sourceFolderId, sourceProjectId);

		const folderIds = [
			sourceFolderId,
			...(await this.folderRepository.getAllFolderIdsInHierarchy(sourceFolderId, sourceProjectId)),
		];
		const workflowIds = await this.sharingRepository.findWorkflowIdsInFolders(folderIds);
		const owners = await this.sharedWorkflowRepository.findOwnerProjectsByWorkflowIds(workflowIds);
		if ([...owners.values()].some(({ id }) => id === destinationProject.id)) {
			throw new TransferWorkflowError(
				"You can't transfer a workflow into the project that's already owning it.",
			);
		}
		const activeWorkflows = (
			await this.workflowRepository.findByIds(workflowIds, { fields: ['activeVersionId'] })
		).flatMap(({ id, activeVersionId }) => (activeVersionId ? [{ id, activeVersionId }] : []));
		const credentialIds = await this.shareableCredentialIds(user, shareCredentials);

		for (const { id } of activeWorkflows) await this.activeWorkflowManager.remove(id);

		await this.sharingRepository.transferFolder(
			sourceFolderId,
			folderIds,
			destinationParentFolderId === PROJECT_ROOT ? null : destinationParentFolderId,
			workflowIds,
			destinationProject.id,
			credentialIds,
		);
		await this.ownershipService.invalidateWorkflowProjectCacheByIds(workflowIds);
		await this.workflowMutationHooks.afterWorkflowsTransferred(workflowIds, user.id);

		for (const { id, activeVersionId } of activeWorkflows) {
			await this.activateAgain(user, id, activeVersionId);
		}
	}

	private async findDestinationProject(user: User, projectId: string) {
		const project = await this.projectService.getProjectWithScope(user, projectId, [
			'workflow:create',
		]);
		if (!project) {
			throw new NotFoundError(
				`Could not find project with the id "${projectId}". Make sure you have the permission to create workflows in it.`,
			);
		}
		return project;
	}

	/** The credentials out of `credentialIds` that the user may share, in the same order. */
	private async shareableCredentialIds(user: User, credentialIds: string[]) {
		const shareable = await this.credentialsFinderService.findCredentialIdsWithScopeForUser(
			credentialIds,
			user,
			['credential:share'],
		);
		return credentialIds.filter((id) => shareable.has(id));
	}

	private async usableCredentialIds(
		user: User,
		options: { workflowId: string } | { projectId: string },
	) {
		const credentials = await this.credentialsService.getCredentialsAUserCanUseInAWorkflow(
			user,
			options,
		);
		return new Set(credentials.map(({ id }) => id));
	}

	/**
	 * The credentials that a list of used credentials marks as usable. With credential sharing
	 * (`N8N_ENV_FEAT_CRED_SHARING`), that is each credential that the user can read.
	 */
	private async credentialIdsForUsedList(
		user: User,
		options: { workflowId: string } | { projectId: string },
	) {
		if (!isCredSharingEnabled()) return await this.usableCredentialIds(user, options);
		const credentials = await this.credentialsFinderService.findCredentialsForUser(user, [
			'credential:read',
		]);
		return new Set(credentials.map(({ id }) => id));
	}

	private async describeCredentials(
		credentialIds: string[],
		usable: Set<string>,
	): Promise<CredentialUsedByWorkflow[]> {
		const result: CredentialUsedByWorkflow[] = [];
		for (const chunk of chunkIds(credentialIds)) {
			const credentials = await this.credentialsRepository.getManyByIds(chunk, {
				withSharings: true,
			});
			for (const credential of credentials) {
				const { id, name, type, homeProject, sharedWithProjects } =
					this.ownershipService.addOwnedByAndSharedWith(credential);
				result.push({
					id,
					name,
					type,
					currentUserCanUse: usable.has(id),
					homeProject,
					sharedWithProjects,
				});
			}
		}
		return result;
	}

	/**
	 * Activate a workflow again after a transfer. When that fails, the workflow stays inactive and
	 * the publish history records the deactivation by the user. An activation error is the result,
	 * because the transfer is done. Another error goes to the caller.
	 */
	private async activateAgain(user: User, workflowId: string, activeVersionId: string) {
		try {
			await this.activeWorkflowManager.add(workflowId, 'update', undefined, {
				actor: { kind: 'user', user: { id: user.id } },
			});
			return undefined;
		} catch (error) {
			await this.activeWorkflowManager.remove(workflowId);
			await this.workflowRepository.update(workflowId, { active: false, activeVersionId: null });
			await this.workflowPublishHistoryRepository.addRecord({
				workflowId,
				versionId: activeVersionId,
				event: 'deactivated',
				userId: user.id,
			});
			if (error instanceof WorkflowActivationError) return { error };
			throw error;
		}
	}
}
