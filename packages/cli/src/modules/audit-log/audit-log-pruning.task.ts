import { Time } from '@n8n/constants';
import { clusterTarget, intervalFromSeconds, SystemTask } from '@n8n/decorators';
import type { SystemTaskSchedule } from '@n8n/decorators';

import { AuditLogPruningService } from './audit-log-pruning.service';
import { AuditLogConfig } from './audit-log.config';

/** Deletes the audit events older than the retention, on one main instance of the cluster. */
@SystemTask()
export class AuditLogPruningTask implements SystemTask {
	readonly name = 'audit-log-pruning';

	readonly schedule: SystemTaskSchedule = intervalFromSeconds(
		this.config.pruneIntervalHours * Time.hours.toSeconds,
	);

	readonly target = clusterTarget({
		/** An event is older than the retention or not, so a repeated run deletes nothing new. */
		scheduler: { retryOnFailure: true },
	});

	constructor(
		private readonly config: AuditLogConfig,
		private readonly pruningService: AuditLogPruningService,
	) {}

	async run(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		await this.pruningService.prune();
	}
}
