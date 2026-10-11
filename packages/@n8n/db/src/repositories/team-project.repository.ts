import { Service } from '@n8n/di';
import { DataSource, In } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { ExternalSecretsConnectionRepository } from './external-secrets-connection.repository';
import { ExternalSecretsProjectAccessRepository } from './external-secrets-project-access.repository';
import { Project, ProjectRelation } from '../entities';
import { TransactionRunner } from '../services/transaction';

/**
 * Fork repository (not in upstream n8n): the queries of the fork's project service
 * (`packages/cli/src/services/project.service.ts`) that need operators or a transaction.
 */
@Service()
export class TeamProjectRepository extends BaseRepository<Project> {
	constructor(
		dataSource: DataSource,
		txRunner: TransactionRunner,
		private readonly secretsProviderConnectionRepository: ExternalSecretsConnectionRepository,
		private readonly projectSecretsProviderAccessRepository: ExternalSecretsProjectAccessRepository,
	) {
		super(Project, dataSource.manager, txRunner);
	}

	/** Replace all relations of a project in one transaction. */
	async replaceRelations(projectId: string, relations: Array<{ userId: string; role: string }>) {
		await this.runInTransaction({}, async (trx) => {
			await trx.delete(ProjectRelation, { projectId });
			if (relations.length === 0) return;
			await trx.insert(
				ProjectRelation,
				relations.map(({ userId, role }) => ({ projectId, userId, role: { slug: role } })),
			);
		});
	}

	/**
	 * Delete a project. With `withSecretsProviderConnections`, the same transaction also deletes
	 * the secrets provider connections that the project owns, disables the connections that it
	 * uses, and removes its access rows. A connection without access rows is global, so a
	 * connection that the project used must not stay enabled.
	 */
	async deleteProject(projectId: string, { withSecretsProviderConnections = false } = {}) {
		await this.runInTransaction({}, async (trx) => {
			if (withSecretsProviderConnections) {
				// The repository targets keep the rollback testable: a test can replace them.
				const connections = this.secretsProviderConnectionRepository.target;
				const access = this.projectSecretsProviderAccessRepository.target;
				const rows = await trx.find(access, { where: { projectId } });
				const owned = rows
					.filter((row) => row.role === 'secretsProviderConnection:owner')
					.map((row) => row.secretsProviderConnectionId);
				const used = rows
					.filter((row) => row.role !== 'secretsProviderConnection:owner')
					.map((row) => row.secretsProviderConnectionId);
				await trx.delete(access, { projectId });
				if (owned.length > 0) await trx.delete(connections, { id: In(owned) });
				if (used.length > 0) await trx.update(connections, { id: In(used) }, { isEnabled: false });
			}
			await trx.delete(Project, { id: projectId });
		});
	}
}
