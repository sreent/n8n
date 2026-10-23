import { LicenseState } from '@n8n/backend-common';
import { WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { ForkFeaturesConfig } from '@/fork-features';
import { License } from '@/license';

// Fork: the fork does not register the Community Edition, request a trial, or activate or renew a
// licence key, so the service only reads the licence data (the owner chose this on 2026-10-13).
// packages/cli/src/license/FORK.md describes the change.
@Service()
export class LicenseService {
	constructor(
		private readonly license: License,
		private readonly licenseState: LicenseState,
		private readonly workflowRepository: WorkflowRepository,
		private readonly forkFeaturesConfig: ForkFeaturesConfig,
	) {}

	async getLicenseData() {
		const triggerCount = await this.workflowRepository.getActiveTriggerCount();
		const workflowsWithEvaluationsCount =
			await this.workflowRepository.getWorkflowsWithEvaluationCount();
		const mainPlan = this.license.getMainPlan();

		return {
			usage: {
				activeWorkflowTriggers: {
					value: triggerCount,
					// oxlint-disable-next-line typescript/no-deprecated - Tech debt, tests fail if we move to this.licenseState.getMaxActiveWorkflows
					limit: this.license.getTriggerLimit(),
					warningThreshold: 0.8,
				},
				workflowsHavingEvaluations: {
					value: workflowsWithEvaluationsCount,
					limit: this.licenseState.getMaxWorkflowsWithEvaluations(),
				},
			},
			license: {
				planId: mainPlan?.productId ?? '',
				planName: this.license.getPlanName(),
				// The page Settings > Usage and plan tells that the fork switch turns the features on.
				forkFeaturesEnabled: this.forkFeaturesConfig.enabled,
			},
		};
	}
}
