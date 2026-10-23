import type {
	CreateSecretsProviderConnectionDto,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';
import { EventService } from '@n8n/backend-services';
import {
	SecretsProviderConnectionRepository,
	ProjectSecretsProviderAccessRepository,
	ProjectRelationRepository,
	type SecretsProviderAccessRole,
	type SecretsProviderConnection,
	type User,
} from '@n8n/db';
import { Container, Service } from '@n8n/di';
import { BadRequestError, ForbiddenError, NotFoundError } from '@n8n/errors';
import {
	combineScopes,
	getAuthPrincipalScopes,
	getRoleScopes,
	type Resource,
	type Scope,
} from '@n8n/permissions';

import { ExternalSecretsConfig } from './external-secrets.config';
import { ExternalSecretsManager } from './external-secrets-manager';
import { ExternalSecretsProviderConnectionManager } from './external-secrets-provider-connection-manager';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';
import { mergeBlankedValues, redactSettings } from './redaction';

/** The resources of the scopes that the project API gives for a connection. */
const SCOPE_RESOURCES: Resource[] = ['externalSecretsProvider', 'externalSecret'];

/** The role of a project that uses a connection, and of the projects of a global connection. */
const USER_ROLE: SecretsProviderAccessRole = 'secretsProviderConnection:user';

/** The role of the project that a connection belongs to. */
const OWNER_ROLE: SecretsProviderAccessRole = 'secretsProviderConnection:owner';

/**
 * Fork code (not in upstream n8n). The connections API of external secrets
 * (`/secret-providers`): the connections of the instance and of the projects, the completions of
 * the secrets, and the provider types. The manager comes from the container at each call, because
 * tests replace it.
 */
@Service()
export class SecretsProvidersConnectionsService {
	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly connectionRepository: SecretsProviderConnectionRepository,
		private readonly accessRepository: ProjectSecretsProviderAccessRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly connectionManager: ExternalSecretsProviderConnectionManager,
		private readonly registry: ExternalSecretsProviderRegistry,
		private readonly eventService: EventService,
	) {}

	private get manager() {
		return Container.get(ExternalSecretsManager);
	}

	// #region The views

	private listItem(connection: SecretsProviderConnection) {
		const provider = this.registry.get(connection.providerKey);
		return {
			id: String(connection.id),
			name: connection.providerKey,
			type: connection.type,
			state: provider?.state ?? 'initializing',
			isEnabled: connection.isEnabled,
			projects: connection.projectAccess.map(({ project, role }) => ({
				id: project.id,
				name: project.name,
				role,
			})),
			secretsCount: provider?.getSecretNames().length ?? 0,
			createdAt: connection.createdAt.toISOString(),
			updatedAt: connection.updatedAt.toISOString(),
		};
	}

	private async detail(connection: SecretsProviderConnection, scopes?: Scope[]) {
		const provider = this.registry.get(connection.providerKey);
		const properties = (provider ?? this.manager.createProvider(connection.type))?.properties ?? [];
		return {
			...this.listItem(connection),
			settings: redactSettings(
				await this.connectionManager.decryptSettings(connection),
				properties,
			),
			secrets: (provider?.getSecretNames() ?? []).map((name) => ({ name })),
			...(scopes && { scopes }),
		};
	}

	/**
	 * The scopes of the user for the connection in the project: the global scopes, and the scopes
	 * of the project role that the role of the project for the connection allows. A global
	 * connection allows the scopes of a project that uses it.
	 */
	private async scopesInProject(
		user: User,
		projectId: string,
		connection: SecretsProviderConnection,
	) {
		const relations = await this.projectRelationRepository.findAllByUser(user.id);
		const projectRole = relations.find((relation) => relation.projectId === projectId)?.role;
		const access = connection.projectAccess.find((row) => row.projectId === projectId);
		const scopes = combineScopes(
			{
				global: getAuthPrincipalScopes(user, SCOPE_RESOURCES),
				project: projectRole?.scopes.map(({ slug }) => slug) ?? [],
			},
			{ sharing: getRoleScopes(access?.role ?? USER_ROLE) },
		);
		return [...scopes]
			.filter((scope) => SCOPE_RESOURCES.some((resource) => scope.startsWith(`${resource}:`)))
			.sort();
	}

	private eventPayload(connection: SecretsProviderConnection, user: User) {
		return {
			userId: user.id,
			userRole: user.role.slug,
			providerKey: connection.providerKey,
			vaultType: connection.type,
			projects: connection.projectAccess.map(({ project }) => ({
				id: project.id,
				name: project.name,
			})),
		};
	}

	// #endregion

	// #region Finding connections

	private async findConnection(providerKey: string) {
		const connection = await this.connectionRepository.findWithAccessByProviderKey(providerKey);
		if (!connection) throw new NotFoundError(`Connection with key "${providerKey}" not found`);
		return connection;
	}

	/** A connection that a project uses or owns, or a global connection. */
	private async findVisibleInProject(providerKey: string, projectId: string) {
		const connection = await this.findConnection(providerKey);
		const { projectAccess } = connection;
		if (projectAccess.length > 0 && !projectAccess.some((row) => row.projectId === projectId)) {
			throw new NotFoundError(`Connection with key "${providerKey}" not found`);
		}
		return connection;
	}

	/** A connection that a project uses or owns. */
	private async findOfProject(providerKey: string, projectId: string) {
		const connection = await this.connectionRepository.findWithAccessByProviderKey(providerKey);
		if (!connection?.projectAccess.some((row) => row.projectId === projectId)) {
			throw new NotFoundError(
				`Connection with key "${providerKey}" not found in project "${projectId}"`,
			);
		}
		return connection;
	}

	// #endregion

	// #region The connections of the instance

	async listConnections() {
		const connections = await this.connectionRepository.listWithAccess();
		return connections.map((connection) => this.listItem(connection));
	}

	async getConnection(providerKey: string) {
		return await this.detail(await this.findConnection(providerKey));
	}

	async createConnection(dto: CreateSecretsProviderConnectionDto, user: User) {
		if (dto.projectIds.length > 0 && !this.config.externalSecretsForProjects) {
			throw new ForbiddenError(
				'Tried to create a project-scoped external secret connection without feature flag enabled',
			);
		}
		const connection = await this.create(dto, dto.projectIds, USER_ROLE, user);
		return await this.detail(connection);
	}

	async updateConnection(providerKey: string, dto: UpdateSecretsProviderConnectionDto, user: User) {
		const connection = await this.update(await this.findConnection(providerKey), dto, user, true);
		return await this.detail(connection);
	}

	async deleteConnection(providerKey: string, user: User) {
		const connection = await this.findConnection(providerKey);
		await this.delete(connection);
		this.eventService.emit(
			'external-secrets-connection-deleted',
			this.eventPayload(connection, user),
		);
	}

	async testConnection(providerKey: string, user: User) {
		return await this.test(await this.findConnection(providerKey), user);
	}

	/** Read the secrets of the provider of the connection again. */
	async reloadConnection(providerKey: string, user: User) {
		const connection = await this.findConnection(providerKey);
		if (!this.registry.has(providerKey)) {
			throw new NotFoundError(`Provider "${providerKey}" not found`);
		}
		const success = await this.manager.syncProvider(providerKey);
		if (success) {
			this.eventService.emit(
				'external-secrets-connection-reloaded',
				this.eventPayload(connection, user),
			);
		}
		return { success };
	}

	// #endregion

	// #region The connections of a project

	/** The connections of the project, then the global connections. */
	async listProjectConnections(projectId: string) {
		const connections = await this.connectionRepository.listWithAccess();
		const ofProject = connections.filter(({ projectAccess }) =>
			projectAccess.some((row) => row.projectId === projectId),
		);
		const global = connections.filter(({ projectAccess }) => projectAccess.length === 0);
		return [...ofProject, ...global].map((connection) => this.listItem(connection));
	}

	async getProjectConnection(projectId: string, providerKey: string, user: User) {
		const connection = await this.findVisibleInProject(providerKey, projectId);
		return await this.detail(connection, await this.scopesInProject(user, projectId, connection));
	}

	/** Create a connection that the project owns. The project IDs of the body do not count. */
	async createProjectConnection(
		projectId: string,
		dto: CreateSecretsProviderConnectionDto,
		user: User,
	) {
		const connection = await this.create(dto, [projectId], OWNER_ROLE, user);
		return await this.detail(connection, await this.scopesInProject(user, projectId, connection));
	}

	/** Update a connection of the project. The project IDs of the body do not count. */
	async updateProjectConnection(
		projectId: string,
		providerKey: string,
		dto: UpdateSecretsProviderConnectionDto,
		user: User,
	) {
		const connection = await this.update(
			await this.findOfProject(providerKey, projectId),
			dto,
			user,
			false,
		);
		return await this.detail(connection, await this.scopesInProject(user, projectId, connection));
	}

	async deleteProjectConnection(projectId: string, providerKey: string) {
		await this.delete(await this.findOfProject(providerKey, projectId));
	}

	async testProjectConnection(projectId: string, providerKey: string, user: User) {
		return await this.test(await this.findOfProject(providerKey, projectId), user);
	}

	// #endregion

	// #region The completions and the types

	/** The names of the secrets of each enabled global connection that has a provider. */
	async getGlobalCompletions() {
		const connections = await this.connectionRepository.findEnabledGlobalConnections();
		return this.secretNames(connections.map(({ providerKey }) => providerKey));
	}

	/** The names of the secrets of each enabled connection of the project that has a provider. */
	async getProjectCompletions(projectId: string) {
		const connections = await this.connectionRepository.findEnabledByProjectId(projectId);
		return this.secretNames(connections.map(({ providerKey }) => providerKey));
	}

	private secretNames(providerKeys: string[]) {
		const completions: Record<string, string[]> = {};
		for (const providerKey of providerKeys) {
			const provider = this.registry.get(providerKey);
			if (provider) completions[providerKey] = provider.getSecretNames();
		}
		return completions;
	}

	/** The provider types, with the fields of their forms. */
	getTypes() {
		return this.manager.getProviderTypes().map((type) => this.typeView(type));
	}

	getType(type: string) {
		if (!this.manager.hasProviderType(type)) {
			throw new NotFoundError(`Provider type "${type}" not found`);
		}
		return this.typeView(type);
	}

	private typeView(type: string) {
		const provider = this.manager.createProvider(type);
		return {
			type,
			displayName: provider?.displayName ?? type,
			icon: type,
			properties: provider?.properties ?? [],
		};
	}

	// #endregion

	// #region The changes

	/**
	 * Store a new connection and the access of its projects, load its provider, and tell the other
	 * instances. The access rows come after the connection: when they fail, the connection stays.
	 */
	private async create(
		dto: CreateSecretsProviderConnectionDto,
		projectIds: string[],
		role: SecretsProviderAccessRole,
		user: User,
	) {
		if (await this.connectionRepository.findIdByProviderKey(dto.providerKey)) {
			throw new BadRequestError(`Connection with key "${dto.providerKey}" already exists`);
		}
		const { id } = await this.connectionRepository.save(
			this.connectionRepository.create({
				providerKey: dto.providerKey,
				type: dto.type,
				encryptedSettings: await this.connectionManager.encryptSettings(dto.settings),
				isEnabled: true,
			}),
		);
		await this.accessRepository.grantAccess(id, projectIds, role);
		const connection = await this.findConnection(dto.providerKey);
		await this.manager.loadConnection(connection);
		await this.manager.broadcastReload();
		this.eventService.emit(
			'external-secrets-connection-created',
			this.eventPayload(connection, user),
		);
		return connection;
	}

	/**
	 * Store the changes of a connection, load its provider again (or remove it when the connection
	 * is disabled), and tell the other instances. New settings replace the stored ones; a blanked
	 * value keeps the stored value.
	 */
	private async update(
		connection: SecretsProviderConnection,
		dto: UpdateSecretsProviderConnectionDto,
		user: User,
		withProjects: boolean,
	) {
		if (dto.type !== undefined && dto.settings === undefined) {
			throw new BadRequestError(
				'When changing the connection type, new settings must be provided as well',
			);
		}
		if (withProjects && dto.projectIds?.length && !this.config.externalSecretsForProjects) {
			throw new ForbiddenError(
				'Tried to create a project-scoped external secret connection without feature flag enabled',
			);
		}
		const changes: Partial<SecretsProviderConnection> = {};
		if (dto.type !== undefined) changes.type = dto.type;
		if (dto.settings !== undefined) {
			const stored = await this.connectionManager.decryptSettings(connection);
			changes.encryptedSettings = await this.connectionManager.encryptSettings(
				mergeBlankedValues(dto.settings, stored),
			);
		}
		if (dto.isEnabled !== undefined) changes.isEnabled = dto.isEnabled;
		await this.connectionRepository.update({ id: connection.id }, changes);
		if (withProjects && dto.projectIds !== undefined) {
			await this.accessRepository.revokeAllAccess(connection.id);
			await this.accessRepository.grantAccess(connection.id, dto.projectIds, USER_ROLE);
		}
		const updated = await this.findConnection(connection.providerKey);
		if (updated.isEnabled) await this.manager.loadConnection(updated);
		else await this.manager.removeProvider(updated.providerKey);
		await this.manager.broadcastReload();
		this.eventService.emit('external-secrets-connection-updated', this.eventPayload(updated, user));
		return updated;
	}

	/** Delete the connection and its access rows, remove its provider, and tell the other instances. */
	private async delete(connection: SecretsProviderConnection) {
		await this.connectionRepository.delete({ id: connection.id });
		await this.manager.removeProvider(connection.providerKey);
		await this.manager.broadcastReload();
	}

	/** Test the stored settings of the connection with a new provider. */
	private async test(connection: SecretsProviderConnection, user: User) {
		const settings = await this.connectionManager.decryptSettings(connection);
		const { success, error } = await this.manager.testProvider(connection.type, settings);
		this.eventService.emit('external-secrets-connection-tested', {
			...this.eventPayload(connection, user),
			isValid: success,
			...(error !== undefined && { errorMessage: error }),
		});
		return {
			success,
			testState: success ? ('tested' as const) : ('error' as const),
			...(error !== undefined && { error }),
		};
	}

	// #endregion
}
