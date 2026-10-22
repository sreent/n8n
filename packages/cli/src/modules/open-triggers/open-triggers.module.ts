import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { TestWebhookCallGuards } from '@/webhooks/test-webhook-call-guards';

/**
 * Fork module (not in upstream n8n): the publish check of triggers without authentication, the
 * guard of their test URLs, and the list of the open triggers of published workflows. The check
 * and the guard do nothing until `N8N_OPEN_TRIGGERS_NEED_APPROVAL` is true. `README.md` describes
 * them.
 */
@BackendModule({ name: 'open-triggers' })
export class OpenTriggersModule implements ModuleInterface {
	async init() {
		await import('./open-triggers.controller.js');

		// Side-effecting import: `@PolicyCheck` registers the check on class definition.
		await import('./open-trigger.check.js');

		const { OpenTriggerTestCallGuard } = await import('./open-trigger-test-call.guard.js');
		Container.get(TestWebhookCallGuards).register(Container.get(OpenTriggerTestCallGuard));
	}

	async settings() {
		const { OpenTriggersConfig } = await import('./open-triggers.config.js');
		return { needApproval: Container.get(OpenTriggersConfig).needApproval };
	}
}
