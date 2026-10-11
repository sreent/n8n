import { Service } from '@n8n/di';
import { DataSource, In } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import {
	ProjectSecretsProviderAccess,
	SecretsProviderConnection,
	SharedCredentials,
} from '../entities';
import { TransactionRunner } from '../services/transaction';

/**
 * Limits a query to the connections with these provider keys. An empty list matches none, without
 * a query: `IN ()` is not valid SQL for PostgreSQL.
 */
interface ProviderKeysFilter {
	providerKeys?: string[];
}

/**
 * Fork repository (not in upstream n8n): the connections to external secrets providers. Ordinary
 * code uses it in place of the enterprise `SecretsProviderConnectionRepository`, which the
 * enterprise module still uses. A connection without project access rows is global. The queries
 * order the connections by ID. packages/cli/src/modules/external-secrets/FORK.md describes them.
 */
@Service()
export class ExternalSecretsConnectionRepository extends BaseRepository<SecretsProviderConnection> {
	constructor(dataSource: DataSource, txRunner: TransactionRunner) {
		super(SecretsProviderConnection, dataSource.manager, txRunner);
	}

	/** The connection with the provider key, with its access rows and their projects. */
	async findWithAccessByProviderKey(providerKey: string) {
		return await this.findOne({ where: { providerKey } });
	}

	/** All connections, with their access rows and their projects. */
	async listWithAccess() {
		return await this.find({ order: { id: 'ASC' } });
	}

	/** The enabled connections, without their relations. */
	async findEnabledConnections() {
		return await this.find({
			where: { isEnabled: true },
			order: { id: 'ASC' },
			loadEagerRelations: false,
		});
	}

	/** The ID of the connection with the provider key, as text. A disabled connection counts. */
	async findIdByProviderKey(providerKey: string): Promise<string | null> {
		const connection = await this.findOne({
			select: { id: true },
			where: { providerKey },
			loadEagerRelations: false,
		});
		return connection ? String(connection.id) : null;
	}

	/** The IDs of the connections with the provider keys, as text. Disabled connections count. */
	async findIdsByProviderKeys(providerKeys: string[]): Promise<string[]> {
		if (providerKeys.length === 0) return [];
		const connections = await this.find({
			select: { id: true },
			where: { providerKey: In(providerKeys) },
			order: { id: 'ASC' },
			loadEagerRelations: false,
		});
		return connections.map(({ id }) => String(id));
	}

	/** The enabled global connections, without their relations. */
	async findEnabledGlobalConnections({ providerKeys }: ProviderKeysFilter = {}) {
		if (providerKeys?.length === 0) return [];
		const query = this.createQueryBuilder('conn');
		const access = query
			.subQuery()
			.select('1')
			.from(ProjectSecretsProviderAccess, 'access')
			.where('access.secretsProviderConnectionId = conn.id')
			.getQuery();
		query
			.where('conn.isEnabled = :isEnabled', { isEnabled: true })
			.andWhere(`NOT EXISTS ${access}`)
			.orderBy('conn.id', 'ASC');
		if (providerKeys) query.andWhere('conn.providerKey IN (:...providerKeys)', { providerKeys });
		return await query.getMany();
	}

	/**
	 * The enabled connections that the project can use. Each connection has only the access row of
	 * this project, with the project.
	 */
	async findEnabledByProjectId(projectId: string, { providerKeys }: ProviderKeysFilter = {}) {
		if (providerKeys?.length === 0) return [];
		const query = this.createQueryBuilder('conn')
			.innerJoinAndSelect('conn.projectAccess', 'access', 'access.projectId = :projectId', {
				projectId,
			})
			.innerJoinAndSelect('access.project', 'project')
			.where('conn.isEnabled = :isEnabled', { isEnabled: true })
			.orderBy('conn.id', 'ASC');
		if (providerKeys) query.andWhere('conn.providerKey IN (:...providerKeys)', { providerKeys });
		return await query.getMany();
	}

	/**
	 * The provider keys of the enabled connections that a credential can use: the global
	 * connections, and the connections of the project that owns the credential. A project that the
	 * credential is only shared with does not count.
	 */
	async findAllAccessibleProviderKeysByCredentialId(credentialId: string): Promise<string[]> {
		const query = this.createQueryBuilder('conn');
		const anyAccess = query
			.subQuery()
			.select('1')
			.from(ProjectSecretsProviderAccess, 'access')
			.where('access.secretsProviderConnectionId = conn.id')
			.getQuery();
		const ownerAccess = query
			.subQuery()
			.select('1')
			.from(ProjectSecretsProviderAccess, 'owneraccess')
			.innerJoin(SharedCredentials, 'shared', 'shared.projectId = owneraccess.projectId')
			.where('owneraccess.secretsProviderConnectionId = conn.id')
			.andWhere('shared.credentialsId = :credentialId')
			.andWhere('shared.role = :ownerRole')
			.getQuery();
		const connections = await query
			.select(['conn.id', 'conn.providerKey'])
			.where('conn.isEnabled = :isEnabled', { isEnabled: true })
			.andWhere(`(NOT EXISTS ${anyAccess} OR EXISTS ${ownerAccess})`, {
				credentialId,
				ownerRole: 'credential:owner',
			})
			.orderBy('conn.id', 'ASC')
			.getMany();
		return connections.map(({ providerKey }) => providerKey);
	}
}
