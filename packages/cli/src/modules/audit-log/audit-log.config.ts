import { CommaSeparatedStringArray, Config, Env } from '@n8n/config';

@Config
export class AuditLogConfig {
	/** Days to keep an audit event. `0` keeps all events. */
	@Env('N8N_AUDIT_LOG_RETENTION_DAYS')
	retentionDays: number = 90;

	/** Hours between two runs of the task that deletes old audit events. */
	@Env('N8N_AUDIT_LOG_PRUNE_INTERVAL_HOURS')
	pruneIntervalHours: number = 24;

	/**
	 * Audit events not to store: event names, or prefixes that end with a dot. For example
	 * `n8n.audit.workflow.executed` (one event for each execution) or `n8n.audit.user.`.
	 */
	@Env('N8N_AUDIT_LOG_EXCLUDED_EVENTS')
	excludedEvents: CommaSeparatedStringArray<string> = [];
}
