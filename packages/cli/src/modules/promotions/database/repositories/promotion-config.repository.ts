import type { PromotionDirection } from '@n8n/api-types';
import { isUniqueConstraintError } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';

import { PromotionConfig } from '../entities/promotion-config.entity';
import { PromotionRowConflictError } from '../promotion-row-conflict.error';

@Service()
export class PromotionConfigRepository extends Repository<PromotionConfig> {
	constructor(dataSource: DataSource) {
		super(PromotionConfig, dataSource.manager);
	}

	async findByConnectionAndDirection(connectionId: string, direction: PromotionDirection) {
		return await this.findOneBy({ connectionId, direction });
	}

	async findByConnectionIds(connectionIds: string[]) {
		if (connectionIds.length === 0) return [];
		return await this.findBy({ connectionId: In(connectionIds) });
	}

	/** Adds a configuration. A second one for the same direction makes the unique index refuse it. */
	async insertConfig(config: PromotionConfig) {
		try {
			return await this.save(config);
		} catch (error) {
			if (isUniqueConstraintError(error)) throw new PromotionRowConflictError();
			throw error;
		}
	}
}
