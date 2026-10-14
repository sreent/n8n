import type { PromotionConnectionScope } from '@n8n/api-types';
import { isUniqueConstraintError } from '@n8n/db';
import { Service } from '@n8n/di';
import type { FindOptionsWhere } from '@n8n/typeorm';
import { DataSource, Repository } from '@n8n/typeorm';

import { PromotionConnection } from '../entities/promotion-connection.entity';
import { PromotionRowConflictError } from '../promotion-row-conflict.error';

@Service()
export class PromotionConnectionRepository extends Repository<PromotionConnection> {
	constructor(dataSource: DataSource) {
		super(PromotionConnection, dataSource.manager);
	}

	/** A connection with its provider. */
	async findWithProvider(id: string) {
		return await this.findOne({ where: { id }, relations: { provider: true } });
	}

	/** The instance connection, when there is one. */
	async findInstanceConnection() {
		return await this.findOne({ where: { scope: 'instance' }, relations: { provider: true } });
	}

	/** A page of connections with their providers, in the order of their ids. */
	async findPage(
		offset: number,
		limit: number,
		filter: { scope?: PromotionConnectionScope; providerId?: string },
	) {
		const where: FindOptionsWhere<PromotionConnection> = {};
		if (filter.scope) where.scope = filter.scope;
		if (filter.providerId) where.providerId = filter.providerId;
		const count = await this.count({ where });
		if (limit === 0) return { data: [], count };
		const data = await this.find({
			where,
			relations: { provider: true },
			order: { id: 'ASC' },
			skip: offset,
			take: limit,
		});
		return { data, count };
	}

	async isProviderInUse(providerId: string) {
		return await this.existsBy({ providerId });
	}

	/** Adds a connection. A second instance connection makes the unique index refuse it. */
	async insertConnection(connection: PromotionConnection) {
		try {
			return await this.save(connection);
		} catch (error) {
			if (isUniqueConstraintError(error)) throw new PromotionRowConflictError();
			throw error;
		}
	}
}
