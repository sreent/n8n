// Fork code (not in upstream n8n): the inventory of workflows for reviews. See README.md.
import type { WorkflowInventoryItemPublic } from '@n8n/api-types';
import { RoleService } from '@n8n/backend-services';
import {
	ExecutionRepository,
	ProjectRelationRepository,
	type User,
	type WorkflowEntity,
} from '@n8n/db';
import { Service } from '@n8n/di';
import type { Scope } from '@n8n/permissions';
import { isTriggerNode, isTriggerNodeType, type INode } from 'n8n-workflow';

import { NodeTypes } from '@/node-types';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

type RecentExecution = WorkflowInventoryItemPublic['recentExecutions'][number];

type InventoryUser = NonNullable<WorkflowInventoryItemPublic['owner']>;

export interface WorkflowInventoryOptions {
	projectId?: string;
	/** How many of the newest executions to give for each workflow. */
	executions: number;
	offset: number;
	limit: number;
}

/** The scope that a user needs on a workflow to find it in the inventory. */
const READ_SCOPES: Scope[] = ['workflow:read'];

/** How many workflows read their executions at the same time. */
const EXECUTION_QUERY_BATCH = 10;

const toIso = (value: Date | string | null | undefined) => {
	if (!value) return null;
	return value instanceof Date ? value.toISOString() : value;
};

/** The credentials that the nodes use, each once, sorted by name. */
function credentialsOf(nodes: INode[]) {
	const credentials = new Map<string, WorkflowInventoryItemPublic['credentials'][number]>();
	for (const node of nodes) {
		for (const [type, details] of Object.entries(node.credentials ?? {})) {
			const id = details.id ?? null;
			credentials.set(id ?? `${type}:${details.name}`, { id, name: details.name, type });
		}
	}
	return [...credentials.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lists the workflows that a user can read, with what a review needs in one call: the owner, the
 * status, the node types, the credentials, the triggers and the newest executions.
 */
@Service()
export class WorkflowInventoryService {
	constructor(
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly executionRepository: ExecutionRepository,
		private readonly roleService: RoleService,
		private readonly nodeTypes: NodeTypes,
	) {}

	/** One page of the workflows that the user can read, sorted by id, and their number. */
	async list(user: User, options: WorkflowInventoryOptions) {
		const { workflows, count } = await this.workflowFinderService.findWorkflowsForUser(
			user,
			READ_SCOPES,
			{
				filters: { projectId: options.projectId },
				offset: options.offset,
				limit: options.limit,
				includeProjects: true,
				includeTags: true,
			},
		);

		const [owners, executions] = await Promise.all([
			this.personalSpaceOwners(workflows),
			this.recentExecutions(user, workflows, options.executions),
		]);
		const isTrigger = this.triggerCheck();

		return {
			count,
			workflows: workflows.map((workflow) => {
				const homeShare = workflow.shared?.find((shared) => shared.role === 'workflow:owner');
				const homeProject = homeShare?.project ?? null;
				const nodes = workflow.nodes ?? [];
				return {
					id: workflow.id,
					name: workflow.name,
					status: workflow.isArchived
						? 'archived'
						: workflow.activeVersionId
							? 'published'
							: 'unpublished',
					hasUnpublishedChanges:
						workflow.activeVersionId !== null && workflow.activeVersionId !== workflow.versionId,
					createdAt: workflow.createdAt.toISOString(),
					updatedAt: workflow.updatedAt.toISOString(),
					tags: (workflow.tags ?? []).map((tag) => tag.name),
					homeProject: homeProject
						? { id: homeProject.id, name: homeProject.name, type: homeProject.type }
						: null,
					owner: homeProject?.type === 'personal' ? (owners.get(homeProject.id) ?? null) : null,
					sharedWith: (workflow.shared ?? [])
						.filter((shared) => shared !== homeShare && shared.project)
						.map((shared) => ({
							id: shared.project.id,
							name: shared.project.name,
							type: shared.project.type,
							role: shared.role,
						})),
					nodeCount: nodes.length,
					nodeTypes: [...new Set(nodes.map((node) => node.type))].sort(),
					credentials: credentialsOf(nodes),
					triggers: nodes.filter(isTrigger).map((node) => ({
						name: node.name,
						type: node.type,
						disabled: node.disabled === true,
					})),
					recentExecutions: executions.get(workflow.id) ?? [],
				} satisfies WorkflowInventoryItemPublic;
			}),
		};
	}

	/** The users of the personal spaces that own the workflows, by project id. */
	private async personalSpaceOwners(workflows: WorkflowEntity[]) {
		const projectIds = new Set<string>();
		for (const workflow of workflows) {
			const home = workflow.shared?.find((shared) => shared.role === 'workflow:owner')?.project;
			if (home?.type === 'personal') projectIds.add(home.id);
		}
		const owners = new Map<string, InventoryUser>();
		if (projectIds.size === 0) return owners;

		const relations = await this.projectRelationRepository.getPersonalProjectOwners([
			...projectIds,
		]);
		for (const { projectId, user } of relations) {
			owners.set(projectId, {
				id: user.id,
				email: user.email ?? null,
				firstName: user.firstName ?? null,
				lastName: user.lastName ?? null,
			});
		}
		return owners;
	}

	/**
	 * The newest executions of each workflow. One query for each workflow, a few at a time: one
	 * query for all workflows would let a busy workflow push out the others.
	 */
	private async recentExecutions(user: User, workflows: WorkflowEntity[], perWorkflow: number) {
		const executions = new Map<string, RecentExecution[]>();
		if (perWorkflow === 0 || workflows.length === 0) return executions;

		const [projectRoles, workflowRoles] = await Promise.all([
			this.roleService.rolesWithScope('project', READ_SCOPES),
			this.roleService.rolesWithScope('workflow', READ_SCOPES),
		]);
		for (let start = 0; start < workflows.length; start += EXECUTION_QUERY_BATCH) {
			const batch = workflows.slice(start, start + EXECUTION_QUERY_BATCH);
			await Promise.all(
				batch.map(async ({ id }) => {
					const summaries = await this.executionRepository.findManyByRangeQuery({
						kind: 'range',
						range: { limit: perWorkflow },
						workflowId: id,
						user,
						sharingOptions: { scopes: READ_SCOPES, projectRoles, workflowRoles },
					});
					executions.set(
						id,
						summaries.map((summary) => ({
							id: summary.id,
							status: summary.status,
							mode: summary.mode,
							startedAt: toIso(summary.startedAt),
							stoppedAt: toIso(summary.stoppedAt),
						})),
					);
				}),
			);
		}
		return executions;
	}

	/**
	 * A check for trigger nodes. The description of the node type decides. A node type that this
	 * instance does not have falls back to the name of the type.
	 */
	private triggerCheck() {
		const known = new Map<string, boolean>();
		return (node: INode) => {
			const key = `${node.type}@${node.typeVersion}`;
			let isTrigger = known.get(key);
			if (isTrigger === undefined) {
				try {
					isTrigger = isTriggerNode(
						this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion).description,
					);
				} catch {
					isTrigger = isTriggerNodeType(node.type);
				}
				known.set(key, isTrigger);
			}
			return isTrigger;
		};
	}
}
