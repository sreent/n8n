import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Fork module (not in upstream n8n): the publish check of triggers without authentication, and the
 * list of the open triggers of published workflows. The check does nothing until
 * `N8N_OPEN_TRIGGERS_NEED_APPROVAL` is true. `README.md` describes it.
 */
@BackendModule({ name: 'open-triggers' })
export class OpenTriggersModule implements ModuleInterface {
	async init() {
		await import('./open-triggers.controller.js');

		// Side-effecting import: `@PolicyCheck` registers the check on class definition.
		await import('./open-trigger.check.js');
	}

	async settings() {
		const { OpenTriggersConfig } = await import('./open-triggers.config.js');
		return { needApproval: Container.get(OpenTriggersConfig).needApproval };
	}
}
