import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

/**
 * Lets users send an independent copy of a workflow to colleagues. Each copy goes
 * to the personal project of the recipient. This is not live sharing.
 */
@BackendModule({ name: 'send-copy', instanceTypes: ['main'] })
export class SendCopyModule implements ModuleInterface {
	async init() {
		await import('./send-copy.controller.js');
	}
}
