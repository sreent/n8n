import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Fork module (not in upstream n8n): sends the events of the event bus to log streaming
 * destinations (webhook, syslog and Sentry), and manages the destinations in the REST API. Each
 * instance type sends the events of its own event bus. `README.md` describes it.
 */
@BackendModule({ name: 'log-streaming' })
export class LogStreamingModule implements ModuleInterface {
	async init() {
		await import('./log-streaming.controller.js');

		const { LogStreamingService } = await import('./log-streaming.service.js');
		await Container.get(LogStreamingService).init();
	}

	async entities() {
		const { EventDestination } = await import('./database/event-destination.entity.js');
		return [EventDestination];
	}

	@OnShutdown()
	async shutdown() {
		const { LogStreamingService } = await import('./log-streaming.service.js');
		await Container.get(LogStreamingService).shutdown();
	}
}
