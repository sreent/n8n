import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { ProjectSecretsProviderAccess, type SecretsProviderAccessRole } from '../entities';
import { TransactionRunner } from '../services/transaction';

/**
 * Fork repository (not in upstream n8n): the access rows that give projects the use of secrets
 * provider connections. It has the name of the upstream repository, so ordinary code and the
 * upstream tests use it unchanged.
 */
@Service()
export class ProjectSecretsProviderAccessRepository extends BaseRepository<ProjectSecretsProviderAccess> {
	constructor(dataSource: DataSource, txRunner: TransactionRunner) {
		super(ProjectSecretsProviderAccess, dataSource.manager, txRunner);
	}

	/**
	 * Give the projects access to the connection, with the role. This is one insert: a project
	 * that is twice in the list, or that does not exist, makes it fail without rows.
	 */
	async grantAccess(
		secretsProviderConnectionId: number,
		projectIds: string[],
		role: SecretsProviderAccessRole,
	) {
		if (projectIds.length === 0) return;
		await this.insert(
			projectIds.map((projectId) => ({ secretsProviderConnectionId, projectId, role })),
		);
	}

	/** Remove the access of all projects to the connection. */
	async revokeAllAccess(secretsProviderConnectionId: number) {
		await this.delete({ secretsProviderConnectionId });
	}
}
