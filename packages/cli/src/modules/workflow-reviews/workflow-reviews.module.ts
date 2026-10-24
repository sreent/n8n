import { LicenseState } from '@n8n/backend-common';
import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { WorkflowMutationHooksProxy, WorkflowPublishGuardProxy } from '@n8n/backend-services';

/**
 * Fork module (not in upstream n8n): workflow reviews, in place of the enterprise module
 * `workflow-reviews.ee`. It starts only with the licence value `feat:workflowReviews`, which the
 * fork switch gives. See `README.md` in this folder.
 */
@BackendModule({
	name: 'workflow-reviews',
	licenseFlag: 'feat:workflowReviews',
	instanceTypes: ['main'],
})
export class WorkflowReviewsModule implements ModuleInterface {
	async init() {
		await import('./workflow-reviews.controller.js');

		const { WorkflowReviewLifecycleService } = await import(
			'./workflow-review-lifecycle.service.js'
		);
		const lifecycle = Container.get(WorkflowReviewLifecycleService);
		Container.get(WorkflowPublishGuardProxy).registerProvider(lifecycle);
		Container.get(WorkflowMutationHooksProxy).registerProvider(lifecycle);

		await this.registerInboxSource();

		await lifecycle.closeUnreviewableRequests();
	}

	/** Puts the reviews in the inbox of the editor. The inbox module reads them from here. */
	private async registerInboxSource() {
		const [{ InboxSourceRegistry }, { WorkflowReviewReadService }, { WorkflowReviewService }] =
			await Promise.all([
				import('../inbox/inbox-source.registry.js'),
				import('./workflow-review-read.service.js'),
				import('./workflow-review.service.js'),
			]);
		const reads = Container.get(WorkflowReviewReadService);
		const reviews = Container.get(WorkflowReviewService);
		const licenseState = Container.get(LicenseState);
		Container.get(InboxSourceRegistry).register({
			type: 'workflow_review',
			isEnabled: async () =>
				licenseState.isWorkflowReviewsLicensed() && (await reviews.isEnabled()),
			list: async (user, query) => await reads.listForInbox(user, query),
			count: async (user) => await reads.countForInbox(user),
		});
	}
}
