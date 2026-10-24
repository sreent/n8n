import type { DataTableCreateColumnSchema, SourceControlledFile } from '@n8n/api-types';
import { EventService, WorkflowMutationHooksProxy } from '@n8n/backend-services';
import type { Project, User } from '@n8n/db';
import {
	CredentialsRepository,
	FolderRepository,
	ProjectRelationRepository,
	ProjectRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
	TagRepository,
	VariablesRepository,
	WorkflowRepository,
	WorkflowTagMappingRepository,
} from '@n8n/db';
import type { PolicyCleared } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { Cipher } from 'n8n-core';

import { VariablesService } from '@/environments/variables/variables.service';
import { WorkflowPublishBlockedError } from '@/errors/response-errors/workflow-publish-blocked.error';
import { DataTableColumnRepository } from '@/modules/data-table/data-table-column.repository';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import { PolicyEnforcementService } from '@/policy/policy-enforcement.service';
import { PolicyViolationError } from '@/policy/policy-violation.error';
import { WorkflowHistoryService } from '@/workflows/workflow-history/workflow-history.service';
import { WorkflowService } from '@/workflows/workflow.service';

import { SourceControlResourcesService } from './source-control-resources.service';
import type {
	ExportableCredential,
	ExportableDataTable,
	ExportableFolder,
	ExportableProject,
	ExportableTags,
	ExportableVariable,
	ExportableWorkflow,
} from './types/exportable';

export type AutoPublishMode = 'none' | 'all' | 'published';

type OwnerContext = Awaited<ReturnType<SourceControlResourcesService['getProjectOwners']>>;

/**
 * Fork code (not in upstream n8n): writes the resources of the work folder to the database on a
 * pull. A resource that the branch does not have is deleted, except a project. See `README.md`
 * in this folder.
 */
@Service()
export class SourceControlImportService {
	constructor(
		private readonly resources: SourceControlResourcesService,
		private readonly workflowRepository: WorkflowRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly variablesRepository: VariablesRepository,
		private readonly variablesService: VariablesService,
		private readonly tagRepository: TagRepository,
		private readonly tagMappingRepository: WorkflowTagMappingRepository,
		private readonly folderRepository: FolderRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly dataTableRepository: DataTableRepository,
		private readonly dataTableColumnRepository: DataTableColumnRepository,
		private readonly workflowHistoryService: WorkflowHistoryService,
		private readonly workflowService: WorkflowService,
		private readonly workflowMutationHooks: WorkflowMutationHooksProxy,
		private readonly policyEnforcementService: PolicyEnforcementService,
		private readonly eventService: EventService,
		private readonly cipher: Cipher,
	) {}

	// #region Owners

	/** The project of a new resource: the owner in the file when it is known here, else the puller. */
	private async targetProject(
		owner: Parameters<SourceControlResourcesService['resolveRemoteOwner']>[0],
		user: User,
		context: OwnerContext,
		usersByEmail: Map<string, User>,
	): Promise<Project> {
		const project = await this.resources.resolveRemoteOwner(owner, context, usersByEmail);
		if (project) return project;
		return await this.projectRepository.getPersonalProjectForUserOrFail(user.id);
	}

	// #endregion

	// #region Projects

	/** Creates the team projects that the instance does not have, and updates the others. */
	async importProjects(projects: ExportableProject[], user: User) {
		for (const remote of projects) {
			const existing = await this.projectRepository.findOneBy({ id: remote.id });
			if (existing) {
				await this.projectRepository.update(remote.id, {
					name: remote.name,
					icon: this.projectIcon(remote.icon),
					description: remote.description ?? null,
				});
			} else {
				await this.projectRepository.save(
					this.projectRepository.create({
						id: remote.id,
						name: remote.name,
						type: 'team',
						icon: this.projectIcon(remote.icon),
						description: remote.description ?? null,
					}),
				);
				await this.projectRelationRepository.save(
					this.projectRelationRepository.create({
						projectId: remote.id,
						userId: user.id,
						role: { slug: 'project:admin' },
					}),
				);
			}
			for (const stub of remote.variableStubs ?? []) {
				const variable = await this.variablesRepository.findOneBy({ id: stub.id });
				if (variable) continue;
				await this.variablesRepository.save({
					id: stub.id,
					key: stub.key,
					type: stub.type ?? 'string',
					value: '',
					project: { id: remote.id },
				});
			}
		}
		if (projects.some((project) => (project.variableStubs ?? []).length > 0)) {
			await this.variablesService.updateCache();
		}
	}

	private projectIcon(icon: unknown): Project['icon'] {
		if (icon === null || typeof icon !== 'object' || !('type' in icon) || !('value' in icon)) {
			return null;
		}
		const { type, value } = icon;
		if (typeof value !== 'string') return null;
		if (type === 'icon') return { type: 'icon', value };
		if (type === 'emoji') return { type: 'emoji', value };
		return null;
	}

	// #endregion

	// #region Folders

	/** Creates or updates the folders, parents first. A folder of an unknown project is skipped. */
	async importFolders(folders: ExportableFolder[]) {
		const byId = new Map(folders.map((folder) => [folder.id, folder]));
		const depth = (folder: ExportableFolder): number => {
			let level = 0;
			let parent = folder.parentFolderId;
			const seen = new Set<string>();
			while (parent && byId.has(parent) && !seen.has(parent)) {
				seen.add(parent);
				level++;
				parent = byId.get(parent)?.parentFolderId ?? null;
			}
			return level;
		};
		for (const folder of [...folders].sort((left, right) => depth(left) - depth(right))) {
			const project = await this.projectRepository.findOneBy({ id: folder.homeProjectId });
			if (!project) continue;
			const existing = await this.folderRepository.findOneBy({ id: folder.id });
			if (existing) {
				await this.folderRepository.update(folder.id, {
					name: folder.name,
					parentFolderId: folder.parentFolderId,
				});
			} else {
				await this.folderRepository.save(
					this.folderRepository.create({
						id: folder.id,
						name: folder.name,
						parentFolderId: folder.parentFolderId,
						homeProject: { id: project.id },
					}),
				);
			}
		}
	}

	/** Deletes the folders. A workflow that is still in one of them moves to the project root. */
	async deleteFolders(ids: string[]) {
		for (const id of ids) {
			const workflows = await this.workflowRepository.find({
				select: { id: true },
				where: { parentFolder: { id } },
			});
			for (const workflow of workflows) {
				await this.workflowRepository.update(workflow.id, { parentFolder: null });
			}
			await this.folderRepository.delete({ id });
		}
	}

	// #endregion

	// #region Tags

	async importTags(tags: ExportableTags['tags']) {
		for (const tag of tags) {
			const existing = await this.tagRepository.findOneBy({ id: tag.id });
			if (existing) {
				if (existing.name !== tag.name) await this.tagRepository.update(tag.id, { name: tag.name });
			} else {
				await this.tagRepository.save(this.tagRepository.create({ id: tag.id, name: tag.name }));
			}
		}
	}

	async deleteTags(ids: string[]) {
		for (const id of ids) await this.tagRepository.delete({ id });
	}

	/** Each workflow of the branch gets the tags of the branch. */
	async importTagMappings(mappings: ExportableTags['mappings'], workflowIds: string[]) {
		const knownTags = new Set((await this.tagRepository.find()).map((tag) => tag.id));
		const existingWorkflows = new Set(
			(await this.workflowRepository.find({ select: { id: true } })).map((workflow) => workflow.id),
		);
		for (const workflowId of workflowIds) {
			if (!existingWorkflows.has(workflowId)) continue;
			await this.tagMappingRepository.delete({ workflowId });
			const wanted = mappings.filter(
				(mapping) => mapping.workflowId === workflowId && knownTags.has(mapping.tagId),
			);
			if (wanted.length > 0) {
				await this.tagMappingRepository.insert(wanted.map(({ tagId }) => ({ workflowId, tagId })));
			}
		}
	}

	// #endregion

	// #region Workflows

	/**
	 * Writes each workflow of the branch to the database, with a version in the history. A new
	 * workflow belongs to its owner in the file when the instance knows the owner, else to the
	 * puller. The content import policy checks each workflow: a refused workflow is skipped, and
	 * its entry gets the violations. With automatic publishing, the workflow is published after
	 * the import; an error of the publication goes to `publishingError` of its entry.
	 */
	async importWorkflows(
		files: Array<{ entry: SourceControlledFile; content: ExportableWorkflow }>,
		user: User,
		autoPublish: AutoPublishMode,
	) {
		const context = await this.resources.getProjectOwners();
		const usersByEmail = await this.resources.getUsersByEmail();
		const ownerProjects = await this.resources.getWorkflowOwnerProjects();
		const knownFolders = new Set((await this.folderRepository.find()).map((folder) => folder.id));
		const authors = `import by ${user.firstName} ${user.lastName}`;

		for (const { entry, content } of files) {
			const existing = await this.workflowRepository.findOneBy({ id: content.id });
			const project =
				(existing ? ownerProjects.get(content.id) : undefined) ??
				(await this.targetProject(content.owner, user, context, usersByEmail));
			const nodes = content.nodes ?? [];

			let cleared: PolicyCleared<'contentImport'>;
			try {
				cleared = await this.policyEnforcementService.enforceContentImport(
					{
						workflow: { id: content.id, name: content.name, nodes },
						projectId: project.id,
						transport: 'source-control',
					},
					{ kind: 'user', user },
				);
			} catch (error) {
				// A refused workflow is skipped; the rest of the pull lands.
				if (!(error instanceof PolicyViolationError)) throw error;
				entry.contentImportPolicy = { violations: error.violations, checkErrors: [] };
				continue;
			}

			const wasPublished = !!existing?.activeVersionId;
			const publish = autoPublish === 'all' || (autoPublish === 'published' && wasPublished);
			// A workflow to publish comes off the active workflows first, without a user.
			if (publish && wasPublished) {
				await this.workflowService.deactivateWorkflowAsSystem(content.id);
			}

			const values = {
				name: content.name,
				description: content.description ?? null,
				nodes,
				connections: content.connections ?? {},
				settings: content.settings ?? {},
				triggerCount: content.triggerCount ?? 0,
				versionId: content.versionId,
				parentFolder:
					content.parentFolderId && knownFolders.has(content.parentFolderId)
						? { id: content.parentFolderId }
						: null,
				isArchived: content.isArchived ?? false,
				nodeGroups: content.nodeGroups ?? [],
			};
			// The insert part of the upsert needs `active`: a published workflow stays published,
			// unless it is published again below.
			await this.workflowRepository.upsertImportedContent(
				{ id: content.id, active: wasPublished && !publish, ...values },
				{ policyCleared: cleared },
			);
			if (!existing) {
				await this.sharedWorkflowRepository.insert({
					workflowId: content.id,
					projectId: project.id,
					role: 'workflow:owner',
				});
			}
			if (content.versionId) {
				await this.workflowHistoryService.saveVersion(
					authors,
					{
						versionId: content.versionId,
						nodes: values.nodes,
						connections: values.connections,
						nodeGroups: values.nodeGroups,
					},
					content.id,
				);
			}
			this.eventService.emit('workflow-imported', { workflowId: content.id });
			if (existing && !existing.isArchived && values.isArchived) {
				await this.workflowMutationHooks.afterWorkflowArchived(content.id, null);
			}

			if (publish && !values.isArchived && content.versionId) {
				try {
					await this.workflowService.activateWorkflow(user, content.id, {
						versionId: content.versionId,
					});
				} catch (error) {
					entry.publishingError = ensureError(error).message;
					if (error instanceof WorkflowPublishBlockedError) {
						entry.publishingErrorDetails = error.details;
					}
				}
			}
		}
	}

	/** Deletes the workflows, with their versions. A published workflow comes off first. */
	async deleteWorkflows(ids: string[]) {
		const deleted: string[] = [];
		for (const id of ids) {
			const workflow = await this.workflowRepository.findOneBy({ id });
			if (!workflow) continue;
			if (workflow.activeVersionId) {
				await this.workflowService.deactivateWorkflowAsSystem(id);
			}
			await this.workflowMutationHooks.beforeWorkflowDeleted(id, null);
			await this.workflowRepository.delete({ id });
			deleted.push(id);
		}
		if (deleted.length > 0) await this.workflowMutationHooks.afterWorkflowsDeleted(deleted);
	}

	// #endregion

	// #region Credentials

	/**
	 * Creates the stubs of new credentials. An existing credential gets the name of the branch.
	 * The content import policy checks each new credential: a refused one is skipped, and its
	 * entry gets the violations.
	 */
	async importCredentials(
		stubs: Array<{ entry: SourceControlledFile; content: ExportableCredential }>,
		user: User,
	) {
		const context = await this.resources.getProjectOwners();
		const usersByEmail = await this.resources.getUsersByEmail();
		for (const { entry, content: stub } of stubs) {
			const existing = await this.credentialsRepository.findOneBy({ id: stub.id });
			if (existing) {
				if (existing.name !== stub.name) {
					await this.credentialsRepository.update(stub.id, { name: stub.name });
				}
				continue;
			}
			const project = await this.targetProject(stub.ownedBy, user, context, usersByEmail);
			let cleared: PolicyCleared<'contentImport'>;
			try {
				cleared = await this.policyEnforcementService.enforceContentImport(
					{
						credential: { id: stub.id, type: stub.type },
						projectId: project.id,
						transport: 'source-control',
					},
					{ kind: 'user', user },
				);
			} catch (error) {
				if (!(error instanceof PolicyViolationError)) throw error;
				entry.contentImportPolicy = { violations: error.violations, checkErrors: [] };
				continue;
			}
			await this.credentialsRepository.upsertImportedContent(
				{
					id: stub.id,
					name: stub.name,
					type: stub.type,
					data: await this.cipher.encryptV2(stub.data ?? {}),
					isGlobal: stub.isGlobal ?? false,
					isResolvable: stub.isResolvable ?? false,
					resolvableAllowFallback: stub.resolvableAllowFallback ?? false,
				},
				{ policyCleared: cleared },
			);
			await this.sharedCredentialsRepository.insert({
				credentialsId: stub.id,
				projectId: project.id,
				role: 'credential:owner',
			});
		}
	}

	async deleteCredentials(ids: string[]) {
		for (const id of ids) await this.credentialsRepository.delete({ id });
	}

	// #endregion

	// #region Variables

	/** Creates new variables without a value. An existing variable gets the key of the branch. */
	async importVariables(variables: ExportableVariable[]) {
		for (const stub of variables) {
			const existing = await this.variablesRepository.findOneBy({ id: stub.id });
			if (existing) {
				if (existing.key !== stub.key)
					await this.variablesRepository.update(stub.id, { key: stub.key });
				continue;
			}
			await this.variablesRepository.save({
				id: stub.id,
				key: stub.key,
				type: stub.type ?? 'string',
				value: '',
			});
		}
		await this.variablesService.updateCache();
	}

	async deleteVariables(ids: string[]) {
		for (const id of ids) await this.variablesRepository.delete({ id });
		await this.variablesService.updateCache();
	}

	// #endregion

	// #region Data tables

	/** Creates or changes the data tables: the columns of the branch, the rows stay. */
	async importDataTables(tables: ExportableDataTable[], user: User) {
		const context = await this.resources.getProjectOwners();
		const usersByEmail = await this.resources.getUsersByEmail();
		for (const table of tables) {
			const existing = await this.dataTableRepository.findOneBy({ id: table.id });
			if (!existing) {
				const project = await this.targetProject(table.ownedBy, user, context, usersByEmail);
				await this.dataTableRepository.createDataTable(
					project.id,
					table.name,
					[],
					undefined,
					table.id,
				);
				for (const column of [...table.columns].sort((left, right) => left.index - right.index)) {
					await this.addColumn(table.id, column);
				}
				continue;
			}
			if (existing.name !== table.name) {
				await this.dataTableRepository.update(table.id, { name: table.name });
			}
			const columns = await this.dataTableColumnRepository.getColumns(table.id);
			const wanted = new Map(table.columns.map((column) => [column.id, column]));
			for (const column of columns) {
				const remote = wanted.get(column.id);
				if (!remote || remote.type !== column.type) {
					await this.dataTableColumnRepository.deleteColumn(table.id, column);
				} else if (remote.name !== column.name) {
					await this.dataTableColumnRepository.renameColumn(table.id, column, remote.name);
				}
			}
			const remaining = new Set(
				(await this.dataTableColumnRepository.getColumns(table.id)).map((column) => column.id),
			);
			for (const column of [...table.columns].sort((left, right) => left.index - right.index)) {
				if (!remaining.has(column.id)) await this.addColumn(table.id, column);
			}
		}
	}

	/** Adds a column with the id of the file. */
	private async addColumn(tableId: string, column: ExportableDataTable['columns'][number]) {
		const schema: DataTableCreateColumnSchema & { id: string } = {
			id: column.id,
			name: column.name,
			type: this.columnType(column.type),
			index: column.index,
		};
		await this.dataTableColumnRepository.addColumn(tableId, schema);
	}

	private columnType(type: string): DataTableCreateColumnSchema['type'] {
		return type === 'number' || type === 'boolean' || type === 'date' ? type : 'string';
	}

	async deleteDataTables(ids: string[]) {
		for (const id of ids) await this.dataTableRepository.deleteDataTable(id);
	}

	// #endregion
}
