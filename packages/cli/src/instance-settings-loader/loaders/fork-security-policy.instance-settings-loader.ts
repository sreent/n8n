import { redactionFloorSchema, type RedactionFloor } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { Config, Env, InstanceSettingsLoaderConfig } from '@n8n/config';
import { Service } from '@n8n/di';

import { InstanceRedactionEnforcementService } from '@/modules/redaction/instance-redaction-enforcement.service';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';

/**
 * Fork: the settings of Settings > Security & policies that the upstream loader leaves out. With
 * `N8N_SECURITY_POLICY_MANAGED_BY_ENV=true` the page is read-only, so without these variables
 * workflow reviews and the redaction floor could not change at all.
 */
@Config
export class ForkSecurityPolicyConfig {
	/** Lets users ask for a review before a workflow is published. */
	@Env('N8N_WORKFLOW_REVIEWS_ENABLED')
	workflowReviewsEnabled: boolean = false;

	/** The data of executions that n8n hides for all workflows: `off`, `production` or `all`. */
	@Env('N8N_REDACTION_ENFORCEMENT_FLOOR', redactionFloorSchema)
	redactionEnforcementFloor: RedactionFloor = 'off';
}

/** Fork: sets workflow reviews and the redaction floor from the environment at each start. */
@Service()
export class ForkSecurityPolicyInstanceSettingsLoader {
	constructor(
		private readonly instanceSettingsLoaderConfig: InstanceSettingsLoaderConfig,
		private readonly forkSecurityPolicyConfig: ForkSecurityPolicyConfig,
		private readonly workflowReviewPolicyService: WorkflowReviewPolicyService,
		private readonly instanceRedactionEnforcementService: InstanceRedactionEnforcementService,
		private logger: Logger,
	) {
		this.logger = this.logger.scoped('instance-settings-loader');
	}

	async run(): Promise<'created' | 'skipped'> {
		if (!this.instanceSettingsLoaderConfig.securityPolicyManagedByEnv) {
			this.logger.debug('Security policy is not managed by environment variables, skipping');
			return 'skipped';
		}

		const { workflowReviewsEnabled, redactionEnforcementFloor } = this.forkSecurityPolicyConfig;
		await this.workflowReviewPolicyService.set(workflowReviewsEnabled);
		await this.instanceRedactionEnforcementService.set(redactionEnforcementFloor);

		return 'created';
	}
}
