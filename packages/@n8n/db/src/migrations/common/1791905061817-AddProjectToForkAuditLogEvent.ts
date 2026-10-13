import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'fork_audit_log_event';
const COLUMNS = ['projectId', 'projectType'];

/**
 * Fork migration (not in upstream n8n): the project of an audit event of the audit log module
 * (`packages/cli/src/modules/audit-log`), for example the home project of the workflow that the
 * event names. Both columns are nullable, so a raw ALTER adds them without a rebuild of the table
 * on SQLite. The events that the table holds already keep null.
 */
export class AddProjectToForkAuditLogEvent1791905061817 implements ReversibleMigration {
	async up({ runQuery, escape, schemaBuilder: { createIndex } }: MigrationContext) {
		const tableName = escape.tableName(TABLE);
		for (const column of COLUMNS) {
			await runQuery(
				`ALTER TABLE ${tableName} ADD COLUMN ${escape.columnName(column)} varchar(36)`,
			);
		}
		await createIndex(TABLE, ['projectId', 'timestamp']);
		await createIndex(TABLE, ['projectType', 'timestamp']);
	}

	async down({ schemaBuilder: { dropColumns, dropIndex } }: MigrationContext) {
		await dropIndex(TABLE, ['projectType', 'timestamp']);
		await dropIndex(TABLE, ['projectId', 'timestamp']);
		await dropColumns(TABLE, COLUMNS, { recreatesOnSqlite: true });
	}
}
