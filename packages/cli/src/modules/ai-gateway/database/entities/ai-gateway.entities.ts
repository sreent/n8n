import { DateTimeColumn } from '@n8n/db';
import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** One call that the gateway priced. Amounts are US dollars. */
@Entity({ name: 'fork_ai_gateway_usage' })
export class AiGatewayUsage extends BaseEntity {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	id: string;

	@DateTimeColumn()
	createdAt: Date;

	/** The user that the call counts for (see the attribution in `README.md`). */
	@Column({ type: 'varchar', length: 36, nullable: true })
	userId: string | null;

	@Column({ type: 'varchar', length: 36, nullable: true })
	projectId: string | null;

	@Column({ type: 'varchar', length: 36, nullable: true })
	workflowId: string | null;

	@Column({ type: 'varchar', length: 36, nullable: true })
	executionId: string | null;

	@Column({ type: 'varchar', length: 36, nullable: true })
	agentId: string | null;

	/** The provider slug, for example `openai`. */
	@Column({ type: 'varchar', length: 64 })
	provider: string;

	@Column({ type: 'varchar', length: 255 })
	model: string;

	@Column({ type: 'int', default: 0 })
	inputTokens: number;

	@Column({ type: 'int', default: 0 })
	outputTokens: number;

	@Column({ type: 'int', default: 0 })
	cachedInputTokens: number;

	@Column({ type: 'double precision', default: 0 })
	cost: number;

	/** The part of the cost that came from the top-ups, after the monthly budget was spent. */
	@Column({ type: 'double precision', default: 0 })
	costFromTopUp: number;
}

/** An amount that an admin added to the balance of the instance. It does not expire. */
@Entity({ name: 'fork_ai_gateway_top_up' })
export class AiGatewayTopUp extends BaseEntity {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	id: string;

	@DateTimeColumn()
	createdAt: Date;

	@Column({ type: 'double precision' })
	amount: number;

	@Column({ type: 'varchar', length: 36, nullable: true })
	createdById: string | null;

	@Column({ type: 'varchar', length: 255, nullable: true })
	note: string | null;
}

/** The balance of the top-ups, in one row with the id 1. */
@Entity({ name: 'fork_ai_gateway_wallet' })
export class AiGatewayWallet extends BaseEntity {
	@PrimaryColumn({ type: 'int' })
	id: number;

	@Column({ type: 'double precision', default: 0 })
	topUpBalance: number;
}
