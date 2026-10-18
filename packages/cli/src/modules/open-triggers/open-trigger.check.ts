import {
	OPEN_TRIGGER_CHECK_ID,
	OPEN_TRIGGER_VIOLATION_KIND,
	type OpenTriggerKind,
} from '@n8n/api-types';
import type {
	PolicyCheckResult,
	PolicyViolation,
	RegisteredPolicyCheck,
	WorkflowPublishContext,
} from '@n8n/decorators';
import { PolicyCheck } from '@n8n/decorators';

import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';

import { openTriggerKey, type OpenTrigger } from './open-trigger.detector';
import { OpenTriggersConfig } from './open-triggers.config';
import { OpenTriggersService } from './open-triggers.service';

const NO_VIOLATIONS: PolicyCheckResult = { violations: [] };

const DESCRIPTION: Record<OpenTriggerKind, (name: string) => string> = {
	webhook: (name) => `The webhook "${name}" accepts calls without authentication`,
	form: (name) => `The form "${name}" is open without sign-in`,
	chat: (name) => `The public chat "${name}" is open without sign-in`,
	mcp: (name) => `The MCP server "${name}" accepts calls without authentication`,
};

function toViolation(trigger: OpenTrigger, reviewsEnabled: boolean): PolicyViolation {
	const next = reviewsEnabled
		? 'Add authentication, or get an approval in a workflow review.'
		: 'Add authentication.';

	return {
		kind: OPEN_TRIGGER_VIOLATION_KIND,
		checkId: OPEN_TRIGGER_CHECK_ID,
		message: `${DESCRIPTION[trigger.kind](trigger.nodeName)}. ${next}`,
		subject: trigger.nodeId,
		subjectType: 'node',
	};
}

/**
 * Stops the publish of a version with a new trigger that accepts calls without authentication.
 * A trigger of the published version and a trigger that a workflow review approved may publish.
 * The check reads `N8N_OPEN_TRIGGERS_NEED_APPROVAL` for each publish, so it does nothing while
 * that variable is false. See `README.md`.
 */
@PolicyCheck()
export class OpenTriggerCheck implements RegisteredPolicyCheck {
	readonly id = OPEN_TRIGGER_CHECK_ID;

	constructor(
		private readonly config: OpenTriggersConfig,
		private readonly service: OpenTriggersService,
		private readonly reviewPolicyService: WorkflowReviewPolicyService,
	) {}

	async onWorkflowPublish({ workflow }: WorkflowPublishContext): Promise<PolicyCheckResult> {
		if (!this.config.needApproval) return NO_VIOLATIONS;

		const open = this.service.findOpenTriggers(workflow.nodes);
		if (open.length === 0) return NO_VIOLATIONS;

		const allowed = workflow.id ? await this.service.allowedTriggerKeys(workflow.id) : new Set();
		const blocked = open.filter((trigger) => !allowed.has(openTriggerKey(trigger)));
		if (blocked.length === 0) return NO_VIOLATIONS;

		const { enabled: reviewsEnabled } = await this.reviewPolicyService.get();
		return { violations: blocked.map((trigger) => toViolation(trigger, reviewsEnabled)) };
	}
}
