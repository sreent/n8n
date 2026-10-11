import { Time } from '@n8n/constants';
import { intervalFromSeconds, SystemTask } from '@n8n/decorators';
import type { SystemTaskEffects, SystemTaskPlacement, SystemTaskSchedule } from '@n8n/decorators';

import { AuditLogPruningService } from './audit-log-pruning.service';
import { AuditLogConfig } from './audit-log.config';

/** Deletes the audit events older than the retention, on one main instance of the cluster. */
@SystemTask()
export class AuditLogPruningTask implements SystemTask {
	readonly name = 'audit-log-pruning';

	readonly schedule: SystemTaskSchedule = intervalFromSeconds(
		this.config.pruneIntervalHours * Time.hours.toSeconds,
	);

	readonly effects: SystemTaskEffects = 'idempotent';

	readonly placement: SystemTaskPlacement = { scope: 'cluster', durable: true };

	constructor(
		private readonly config: AuditLogConfig,
		private readonly pruningService: AuditLogPruningService,
	) {}

	async run(): Promise<void> {
		await this.pruningService.prune();
	}
}
