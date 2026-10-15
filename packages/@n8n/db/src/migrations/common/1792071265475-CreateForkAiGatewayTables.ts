import type { MigrationContext, ReversibleMigration } from '../migration-types';

const USAGE = 'fork_ai_gateway_usage';
const TOP_UP = 'fork_ai_gateway_top_up';
const WALLET = 'fork_ai_gateway_wallet';

/**
 * Fork migration (not in upstream n8n): the tables of the AI gateway module
 * (`packages/cli/src/modules/ai-gateway`). The prefix `fork_` keeps the names apart from tables
 * that upstream may add later. Amounts are US dollars.
 */
export class CreateForkAiGatewayTables1792071265475 implements ReversibleMigration {
	async up({ schemaBuilder: { createTable, column } }: MigrationContext) {
		await createTable(USAGE)
			.withColumns(
				column('id').varchar(36).primary,
				column('createdAt').timestampTimezone().notNull,
				column('userId').varchar(36),
				column('projectId').varchar(36),
				column('workflowId').varchar(36),
				column('executionId').varchar(36),
				column('agentId').varchar(36),
				column('provider').varchar(64).notNull,
				column('model').varchar(255).notNull,
				column('inputTokens').int.notNull.default(0),
				column('outputTokens').int.notNull.default(0),
				column('cachedInputTokens').int.notNull.default(0),
				column('cost').double.notNull.default(0),
				column('costFromTopUp').double.notNull.default(0),
			)
			.withIndexOn('createdAt')
			.withIndexOn(['projectId', 'createdAt'])
			.withIndexOn(['userId', 'createdAt']);

		await createTable(TOP_UP).withColumns(
			column('id').varchar(36).primary,
			column('createdAt').timestampTimezone().notNull,
			column('amount').double.notNull,
			column('createdById').varchar(36),
			column('note').varchar(255),
		);

		await createTable(WALLET).withColumns(
			column('id').int.primary,
			column('topUpBalance').double.notNull.default(0),
		);
	}

	async down({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(WALLET);
		await dropTable(TOP_UP);
		await dropTable(USAGE);
	}
}
