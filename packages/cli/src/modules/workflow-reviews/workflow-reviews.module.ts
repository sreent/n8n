import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { WorkflowMutationHooksProxy } from '@/workflows/workflow-mutation-hooks-proxy.service';
import { WorkflowPublishGuardProxy } from '@/workflows/workflow-publish-guard-proxy.service';

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

		await lifecycle.closeUnreviewableRequests();
	}
}
