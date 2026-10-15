import { Service } from '@n8n/di';
import { DataSource, Not, Repository } from '@n8n/typeorm';

import { SYSTEM_RESOLVER_ID } from '../../constants';
import { DynamicCredentialResolver } from '../entities/credential-resolver';

@Service()
export class DynamicCredentialResolverRepository extends Repository<DynamicCredentialResolver> {
	constructor(dataSource: DataSource) {
		super(DynamicCredentialResolver, dataSource.manager);
	}

	/** The resolvers, oldest first. The system resolver only when `includeSystem` is true. */
	async findResolvers(includeSystem: boolean): Promise<DynamicCredentialResolver[]> {
		return await this.find({
			...(includeSystem ? {} : { where: { id: Not(SYSTEM_RESOLVER_ID) } }),
			order: { createdAt: 'ASC' },
		});
	}

	async findResolverById(id: string): Promise<DynamicCredentialResolver | null> {
		return await this.findOneBy({ id });
	}

	async existsResolver(id: string): Promise<boolean> {
		return await this.existsBy({ id });
	}
}
