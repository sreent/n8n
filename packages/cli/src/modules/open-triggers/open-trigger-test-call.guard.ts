import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { ForbiddenError } from '@n8n/errors';
import type { Request } from 'express';
import type { INode, IWorkflowBase } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { AUTH_COOKIE_NAME } from '@/constants';
import { userHasScopes } from '@/permissions/check-access';
import type { TestWebhookCallGuard } from '@/webhooks/test-webhook-call-guards';

import { openTriggerKey } from './open-trigger.detector';
import { OpenTriggersConfig } from './open-triggers.config';
import { OpenTriggersService } from './open-triggers.service';

export const TEST_CALL_REFUSED_MESSAGE =
	'This test URL takes calls only from n8n users who may run the workflow, because the trigger has no authentication. Sign in to n8n in this browser, add authentication to the trigger, or get an approval in a workflow review.';

/** One cookie of the raw header: the webhook routes run before the cookie parser of n8n. */
function cookieFromHeader(request: Request, name: string): string | undefined {
	const header = request.headers.cookie;
	if (typeof header !== 'string') return undefined;

	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
		try {
			return decodeURIComponent(part.slice(separator + 1).trim());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Refuses a call of a test URL to a trigger without authentication, unless an n8n user who may
 * run the workflow calls, or a workflow review approved the trigger. A refused call does not end
 * the test listener. It reads `N8N_OPEN_TRIGGERS_NEED_APPROVAL` for each call. See `README.md`.
 */
@Service()
export class OpenTriggerTestCallGuard implements TestWebhookCallGuard {
	constructor(
		private readonly config: OpenTriggersConfig,
		private readonly service: OpenTriggersService,
		private readonly authService: AuthService,
		private readonly logger: Logger,
	) {}

	async check(request: Request, workflow: IWorkflowBase, node: INode): Promise<void> {
		if (!this.config.needApproval || !workflow.id) return;

		const [trigger] = this.service.findOpenTriggers([node]);
		if (!trigger) return;

		if (await this.callerMayRun(request, workflow.id)) return;

		const allowed = await this.service.allowedTriggerKeys(workflow.id);
		if (allowed.has(openTriggerKey(trigger))) return;

		this.logger.debug('Refused a test call to a trigger without authentication', {
			workflowId: workflow.id,
			nodeId: node.id,
		});
		throw new ForbiddenError(TEST_CALL_REFUSED_MESSAGE);
	}

	/** The browser of the editor sends the session cookie, but not the browser id header. */
	private async callerMayRun(request: Request, workflowId: string): Promise<boolean> {
		const token = cookieFromHeader(request, AUTH_COOKIE_NAME);
		if (!token) return false;

		try {
			const user = await this.authService.authenticateUserByCookie(token);
			return await userHasScopes(user, ['workflow:execute'], false, { workflowId });
		} catch {
			return false;
		}
	}
}
