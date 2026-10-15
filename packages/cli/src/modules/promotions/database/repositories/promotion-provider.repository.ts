import { isForeignKeyConstraintError } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { PromotionProvider } from '../entities/promotion-provider.entity';
import { PromotionRowConflictError } from '../promotion-row-conflict.error';

@Service()
export class PromotionProviderRepository extends Repository<PromotionProvider> {
	constructor(dataSource: DataSource) {
		super(PromotionProvider, dataSource.manager);
	}

	async findById(id: string) {
		return await this.findOneBy({ id });
	}

	/** A page of providers in the order of their ids, and the number of all providers. */
	async findPage(offset: number, limit: number) {
		const count = await this.count();
		if (limit === 0) return { data: [], count };
		const data = await this.find({ order: { id: 'ASC' }, skip: offset, take: limit });
		return { data, count };
	}

	/** Deletes a provider. A connection that uses it makes the delete fail. */
	async deleteProvider(id: string) {
		try {
			await this.delete({ id });
		} catch (error) {
			if (isForeignKeyConstraintError(error)) throw new PromotionRowConflictError();
			throw error;
		}
	}
}
