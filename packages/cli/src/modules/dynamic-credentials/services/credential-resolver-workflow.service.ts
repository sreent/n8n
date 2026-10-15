import { WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { ActiveWorkflowManager } from '@/active-workflow-manager';

/** The workflows that select a resolver in their settings (`credentialResolverId`). */
@Service()
export class CredentialResolverWorkflowService {
	constructor(
		private readonly workflowRepository: WorkflowRepository,
		private readonly activeWorkflowManager: ActiveWorkflowManager,
	) {}

	private async workflowsOf(resolverId: string) {
		const workflows = await this.workflowRepository.find({
			select: ['id', 'name', 'settings', 'activeVersionId'],
			order: { createdAt: 'ASC' },
		});
		return workflows.filter((workflow) => workflow.settings?.credentialResolverId === resolverId);
	}

	/** The id and the name of each workflow that uses the resolver. */
	async findAffectedWorkflows(resolverId: string) {
		return (await this.workflowsOf(resolverId)).map(({ id, name }) => ({ id, name }));
	}

	/**
	 * Removes the resolver from the settings of the workflows that use it. An active workflow
	 * is activated again, so that its triggers use the new settings.
	 */
	async clearResolverFromWorkflows(resolverId: string) {
		for (const workflow of await this.workflowsOf(resolverId)) {
			const { credentialResolverId: _removed, ...settings } = workflow.settings ?? {};
			await this.workflowRepository.update(workflow.id, { settings });
			if (workflow.activeVersionId) {
				await this.activeWorkflowManager.remove(workflow.id);
				await this.activeWorkflowManager.add(workflow.id, 'update');
			}
		}
	}
}
