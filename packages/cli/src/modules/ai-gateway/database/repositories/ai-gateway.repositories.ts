import { CredentialsEntity } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';
import type { SelectQueryBuilder } from '@n8n/typeorm';

import { AiGatewayTopUp, AiGatewayUsage, AiGatewayWallet } from '../entities/ai-gateway.entities';

/** The id of the one row of the wallet table. */
const WALLET_ID = 1;

export type AiGatewayUsageRow = Pick<
	AiGatewayUsage,
	| 'id'
	| 'createdAt'
	| 'userId'
	| 'projectId'
	| 'workflowId'
	| 'executionId'
	| 'agentId'
	| 'provider'
	| 'model'
	| 'inputTokens'
	| 'outputTokens'
	| 'cachedInputTokens'
	| 'cost'
	| 'costFromTopUp'
>;

/** The filters of a list of calls. All of them are optional. */
export interface AiGatewayUsageFilter {
	from?: Date;
	to?: Date;
	userId?: string;
	projectId?: string;
	provider?: string;
	model?: string;
}

/** The sums of the calls that match. */
export interface AiGatewaySpend {
	cost: number;
	costFromTopUp: number;
}

/** Rounds an amount of dollars to 1/1,000,000 dollar, so that sums stay readable. */
export const roundDollars = (dollars: number) => Math.round(dollars * 1e6) / 1e6;

const toNumber = (value: unknown) => {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
};

@Service()
export class AiGatewayUsageRepository extends Repository<AiGatewayUsage> {
	constructor(dataSource: DataSource) {
		super(AiGatewayUsage, dataSource.manager);
	}

	/** The sums of the calls that match. */
	async spend(filter: AiGatewayUsageFilter): Promise<AiGatewaySpend> {
		const raw = await this.matching(filter)
			.select('COALESCE(SUM(usage.cost), 0)', 'cost')
			.addSelect('COALESCE(SUM(usage.costFromTopUp), 0)', 'costFromTopUp')
			.getRawOne<{ cost: unknown; costFromTopUp: unknown }>();
		return { cost: toNumber(raw?.cost), costFromTopUp: toNumber(raw?.costFromTopUp) };
	}

	/** The cost of the calls that match, for each project. */
	async spendByProject(filter: AiGatewayUsageFilter) {
		const rows = await this.matching(filter)
			.select('usage.projectId', 'projectId')
			.addSelect('COALESCE(SUM(usage.cost), 0)', 'cost')
			.groupBy('usage.projectId')
			.getRawMany<{ projectId: string | null; cost: unknown }>();
		return rows.map((row) => ({ projectId: row.projectId, cost: toNumber(row.cost) }));
	}

	/** One page of the calls that match, newest first, and the number of all calls that match. */
	async findPage(filter: AiGatewayUsageFilter, skip: number, take: number) {
		const [rows, count] = await this.matching(filter)
			.orderBy('usage.createdAt', 'DESC')
			.addOrderBy('usage.id', 'DESC')
			.skip(skip)
			.take(take)
			.getManyAndCount();
		return { rows, count };
	}

	private matching(filter: AiGatewayUsageFilter): SelectQueryBuilder<AiGatewayUsage> {
		const query = this.createQueryBuilder('usage');
		if (filter.from) query.andWhere('usage.createdAt >= :from', { from: filter.from });
		if (filter.to) query.andWhere('usage.createdAt < :to', { to: filter.to });
		if (filter.userId) query.andWhere('usage.userId = :userId', { userId: filter.userId });
		if (filter.projectId) {
			query.andWhere('usage.projectId = :projectId', { projectId: filter.projectId });
		}
		if (filter.provider) {
			query.andWhere('usage.provider = :provider', { provider: filter.provider });
		}
		if (filter.model) query.andWhere('usage.model = :model', { model: filter.model });
		return query;
	}
}

@Service()
export class AiGatewayTopUpRepository extends Repository<AiGatewayTopUp> {
	constructor(dataSource: DataSource) {
		super(AiGatewayTopUp, dataSource.manager);
	}

	async newestFirst(take: number) {
		return await this.find({ order: { createdAt: 'DESC', id: 'DESC' }, take });
	}
}

@Service()
export class AiGatewayWalletRepository extends Repository<AiGatewayWallet> {
	constructor(dataSource: DataSource) {
		super(AiGatewayWallet, dataSource.manager);
	}

	/** The balance of the top-ups. */
	async topUpBalance() {
		const wallet = await this.findOneBy({ id: WALLET_ID });
		return wallet?.topUpBalance ?? 0;
	}

	/** Adds a top-up and its amount to the balance, in one transaction. */
	async addTopUp(
		topUp: Pick<AiGatewayTopUp, 'id' | 'createdAt' | 'amount' | 'createdById' | 'note'>,
	) {
		await this.manager.transaction(async (manager) => {
			await manager.insert(AiGatewayTopUp, topUp);
			await manager
				.createQueryBuilder()
				.insert()
				.into(AiGatewayWallet)
				.values({ id: WALLET_ID, topUpBalance: 0 })
				.orIgnore()
				.execute();
			await manager.increment(AiGatewayWallet, { id: WALLET_ID }, 'topUpBalance', topUp.amount);
		});
	}

	/**
	 * Records a call in one transaction. The top-ups pay the part of the cost that `budgetLeft`
	 * does not cover, as far as their balance goes. Gives the amount that the top-ups paid.
	 */
	async recordCall(row: Omit<AiGatewayUsageRow, 'costFromTopUp'>, budgetLeft: number) {
		return await this.manager.transaction(async (manager) => {
			const wallet = await manager.findOneBy(AiGatewayWallet, { id: WALLET_ID });
			const balance = Math.max(0, wallet?.topUpBalance ?? 0);
			const costFromTopUp = roundDollars(Math.min(balance, Math.max(0, row.cost - budgetLeft)));
			if (costFromTopUp > 0) {
				const column = manager.connection.driver.escape('topUpBalance');
				// The balance does not go below zero when calls end at the same time.
				await manager
					.createQueryBuilder()
					.update(AiGatewayWallet)
					.set({
						topUpBalance: () => `CASE WHEN ${column} > :taken THEN ${column} - :taken ELSE 0 END`,
					})
					.where({ id: WALLET_ID })
					.setParameters({ taken: costFromTopUp })
					.execute();
			}
			await manager.insert(AiGatewayUsage, { ...row, costFromTopUp });
			return costFromTopUp;
		});
	}
}

/** The credentials that the settings page offers for the providers. */
@Service()
export class AiGatewayCredentialOptionsRepository {
	constructor(private readonly dataSource: DataSource) {}

	/** The id, the name and the type of each credential of the given types, by name. */
	async ofTypes(types: string[]) {
		if (types.length === 0) return [];
		return await this.dataSource.manager.find(CredentialsEntity, {
			select: { id: true, name: true, type: true },
			where: { type: In(types) },
			order: { name: 'ASC' },
		});
	}
}
