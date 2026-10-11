import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'fork_audit_log_event';

/**
 * Fork migration (not in upstream n8n): the table of the audit log module
 * (`packages/cli/src/modules/audit-log`). The prefix `fork_` keeps the name apart from tables that
 * upstream may add later.
 */
export class CreateForkAuditLogEventTable1791734727111 implements ReversibleMigration {
	async up({ schemaBuilder: { createTable, column } }: MigrationContext) {
		await createTable(TABLE)
			.withColumns(
				column('id').varchar(36).primary.comment('The id of the event message'),
				column('eventName').varchar(128).notNull,
				column('timestamp').timestampTimezone().notNull,
				column('userId').varchar(36),
				column('userEmail').varchar(254),
				column('payload').json.notNull,
			)
			.withIndexOn('timestamp')
			.withIndexOn(['eventName', 'timestamp'])
			.withIndexOn(['userId', 'timestamp']);
	}

	async down({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(TABLE);
	}
}
