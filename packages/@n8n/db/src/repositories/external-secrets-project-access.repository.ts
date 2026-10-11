import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { ProjectSecretsProviderAccess } from '../entities';
import { TransactionRunner } from '../services/transaction';

/**
 * Fork repository (not in upstream n8n): the access rows that give projects the use of secrets
 * provider connections. Ordinary code uses it in place of the enterprise
 * `ProjectSecretsProviderAccessRepository`, which the enterprise module still uses.
 */
@Service()
export class ExternalSecretsProjectAccessRepository extends BaseRepository<ProjectSecretsProviderAccess> {
	constructor(dataSource: DataSource, txRunner: TransactionRunner) {
		super(ProjectSecretsProviderAccess, dataSource.manager, txRunner);
	}
}
