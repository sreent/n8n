import type { OpenTriggerItem } from '@n8n/api-types';
import { ChatTriggerConfig } from '@n8n/config';
import { ProjectRelationRepository, type User } from '@n8n/db';
import { Service } from '@n8n/di';
import type { INode } from 'n8n-workflow';

import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { OpenTriggerRepository } from './database/open-trigger.repository';
import { findOpenTriggers, openTriggerKey, type OpenTrigger } from './open-trigger.detector';

type Owner = NonNullable<OpenTriggerItem['owner']>;

/** Finds the open triggers of workflows, and the open triggers that may publish. */
@Service()
export class OpenTriggersService {
	constructor(
		private readonly repository: OpenTriggerRepository,
		private readonly chatTriggerConfig: ChatTriggerConfig,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly projectRelationRepository: ProjectRelationRepository,
	) {}

	findOpenTriggers(nodes: readonly INode[]): OpenTrigger[] {
		return findOpenTriggers(nodes, {
			publicChatDisabled: this.chatTriggerConfig.disablePublicChat,
		});
	}

	/**
	 * The keys of the open triggers that may publish: the open triggers of the published version,
	 * which were published before the check or approved, and of each version that an approved
	 * workflow review pins. Startup and the activation of a published version read the published
	 * version, so the check never stops a workflow that runs now.
	 */
	async allowedTriggerKeys(workflowId: string): Promise<Set<string>> {
		const [published, approved] = await Promise.all([
			this.repository.findPublishedVersionNodes(workflowId),
			this.repository.findApprovedVersionNodes([workflowId]),
		]);
		const keys = new Set<string>();
		for (const nodes of [published ?? [], ...approved.map((version) => version.nodes)]) {
			for (const trigger of this.findOpenTriggers(nodes)) keys.add(openTriggerKey(trigger));
		}
		return keys;
	}

	/**
	 * The open triggers of the published versions of the workflows that the user can read, sorted
	 * by the names of the workflows and of the nodes. The owner and the admins get all workflows.
	 */
	async listPublished(
		user: User,
		options: { projectId?: string } = {},
	): Promise<OpenTriggerItem[]> {
		const { workflows } = await this.workflowFinderService.findWorkflowsForUser(
			user,
			['workflow:read'],
			{
				filters: { active: true, projectId: options.projectId },
				includeProjects: true,
				includeActiveVersion: true,
			},
		);

		const found = workflows.flatMap((workflow) => {
			const triggers = this.findOpenTriggers(workflow.activeVersion?.nodes ?? []);
			if (triggers.length === 0) return [];
			const home = workflow.shared?.find((shared) => shared.role === 'workflow:owner')?.project;
			return [{ workflow, home: home ?? null, triggers }];
		});
		if (found.length === 0) return [];

		const [approvedKeys, owners] = await Promise.all([
			this.approvedKeysByWorkflow(found.map(({ workflow }) => workflow.id)),
			this.personalSpaceOwners(
				found.flatMap(({ home }) => (home?.type === 'personal' ? [home.id] : [])),
			),
		]);

		const items = found.flatMap(({ workflow, home, triggers }) =>
			triggers.map(
				(trigger): OpenTriggerItem => ({
					workflowId: workflow.id,
					workflowName: workflow.name,
					homeProject: home ? { id: home.id, name: home.name, type: home.type } : null,
					owner: home?.type === 'personal' ? (owners.get(home.id) ?? null) : null,
					...trigger,
					approved: approvedKeys.get(workflow.id)?.has(openTriggerKey(trigger)) ?? false,
				}),
			),
		);
		return items.sort(
			(a, b) =>
				a.workflowName.localeCompare(b.workflowName) ||
				a.workflowId.localeCompare(b.workflowId) ||
				a.nodeName.localeCompare(b.nodeName),
		);
	}

	private async approvedKeysByWorkflow(workflowIds: string[]) {
		const keys = new Map<string, Set<string>>();
		for (const { workflowId, nodes } of await this.repository.findApprovedVersionNodes(
			workflowIds,
		)) {
			const workflowKeys = keys.get(workflowId) ?? new Set<string>();
			for (const trigger of this.findOpenTriggers(nodes)) workflowKeys.add(openTriggerKey(trigger));
			keys.set(workflowId, workflowKeys);
		}
		return keys;
	}

	/** The users of the personal spaces, by project id. */
	private async personalSpaceOwners(projectIds: string[]) {
		const owners = new Map<string, Owner>();
		if (projectIds.length === 0) return owners;

		const relations = await this.projectRelationRepository.getPersonalProjectOwners([
			...new Set(projectIds),
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
}
