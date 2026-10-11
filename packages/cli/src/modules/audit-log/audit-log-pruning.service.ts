import { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import { Service } from '@n8n/di';

import { AuditLogConfig } from './audit-log.config';
import { AuditLogEventRepository } from './database/audit-log-event.repository';

@Service()
export class AuditLogPruningService {
	constructor(
		private readonly logger: Logger,
		private readonly repository: AuditLogEventRepository,
		private readonly config: AuditLogConfig,
	) {
		this.logger = this.logger.scoped('audit-log');
	}

	/**
	 * Deletes the audit events older than the retention, and gives their number. A retention of 0
	 * days, or less, keeps all events. A failure goes to the caller.
	 */
	async prune(now = new Date()) {
		const { retentionDays } = this.config;
		if (!(retentionDays > 0)) return 0;

		const cutoff = new Date(now.getTime() - retentionDays * Time.days.toMilliseconds);
		const deleted = await this.repository.deleteOlderThan(cutoff);
		if (deleted > 0) this.logger.debug('Deleted old audit events', { count: deleted });
		return deleted;
	}
}
