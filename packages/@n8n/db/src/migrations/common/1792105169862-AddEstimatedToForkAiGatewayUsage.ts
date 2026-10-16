import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'fork_ai_gateway_usage';
const COLUMN = 'estimated';

/**
 * Fork migration (not in upstream n8n): marks the calls of the AI gateway module
 * (`packages/cli/src/modules/ai-gateway`) whose tokens the gateway estimated, because the answer
 * did not report them all. No other table refers to this table, so the rebuild of the table on
 * SQLite deletes no rows elsewhere. The calls that the table holds already get `false`.
 */
export class AddEstimatedToForkAiGatewayUsage1792105169862 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns(
			TABLE,
			[
				column(COLUMN)
					.bool.notNull.default(false)
					.comment('Whether the gateway estimated the tokens of the call'),
			],
			{ recreatesOnSqlite: true },
		);
	}

	async down({ schemaBuilder: { dropColumns } }: MigrationContext) {
		await dropColumns(TABLE, [COLUMN], { recreatesOnSqlite: true });
	}
}
