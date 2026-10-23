import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Fork module (not in upstream n8n): stores the audit events of the event bus (`n8n.audit.*`),
 * deletes them after the retention, and gives them to the owner and admins in the REST API. Each
 * instance type stores the audit events that its own event bus sends. It starts with the licence
 * value of log streaming, `feat:logStreaming`, which the fork switch gives. `README.md` describes
 * it.
 */
@BackendModule({ name: 'audit-log', licenseFlag: 'feat:logStreaming' })
export class AuditLogModule implements ModuleInterface {
	async init() {
		await import('./audit-log.controller.js');

		const { AuditLogCollectionService } = await import('./audit-log-collection.service.js');
		Container.get(AuditLogCollectionService).init();
	}

	async systemTasks() {
		const { AuditLogPruningTask } = await import('./audit-log-pruning.task.js');
		return [AuditLogPruningTask];
	}

	async entities() {
		const { AuditLogEvent } = await import('./database/audit-log-event.entity.js');
		return [AuditLogEvent];
	}

	async settings() {
		const { AuditLogConfig } = await import('./audit-log.config.js');
		return { retentionDays: Container.get(AuditLogConfig).retentionDays };
	}

	@OnShutdown()
	async shutdown() {
		const { AuditLogCollectionService } = await import('./audit-log-collection.service.js');
		await Container.get(AuditLogCollectionService).shutdown();
	}
}
