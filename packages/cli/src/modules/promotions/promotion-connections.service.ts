import type {
	CreatePromotionConnectionDto,
	PromotionApplyConfigPublicDto,
	PromotionConfigSettings,
	PromotionConnectionConfigsPublic,
	PromotionConnectionConfigsSummary,
	PromotionConnectionScope,
	PromotionDirection,
	PromotionPromoteConfigPublicDto,
	UpdatePromotionConnectionDto,
} from '@n8n/api-types';
import { EventService } from '@n8n/backend-services';
import type { User } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, ConflictError, NotFoundError } from '@n8n/errors';
import { scrubSecretsInText } from '@n8n/utils/scrub-secrets';

import type { ForkGovernanceEventMap } from '@/events/maps/fork-governance.event-map';

import type { PromotionConfig } from './database/entities/promotion-config.entity';
import type { PromotionConnection } from './database/entities/promotion-connection.entity';
import { PromotionRowConflictError } from './database/promotion-row-conflict.error';
import { PromotionConfigRepository } from './database/repositories/promotion-config.repository';
import { PromotionConnectionProjectRepository } from './database/repositories/promotion-connection-project.repository';
import { PromotionConnectionRepository } from './database/repositories/promotion-connection.repository';
import { PromotionCheckouts } from './promotion-checkouts';
import { PromotionGitRunner } from './promotion-git';
import { PromotionProvidersService, toProviderSummary } from './promotion-providers.service';
import { checkRemoteUrl } from './promotion-remote-url';

const DEFAULT_CONFIG_NAMES: Record<PromotionDirection, string> = {
	apply: 'Apply',
	promote: 'Promote',
};

type ApplySettings = Extract<PromotionConfigSettings, { branchName: string }>;
type PromoteSettings = Extract<PromotionConfigSettings, { baseBranchName: string }>;

/** The settings of the apply direction, and its name. */
interface ApplyConfigInput {
	config: { direction: 'apply'; settings: ApplySettings };
	name?: string;
}

/** The settings of the promote direction, and its name. */
interface PromoteConfigInput {
	config: { direction: 'promote'; settings: PromoteSettings };
	name?: string;
}

export type PromotionConfigInput = ApplyConfigInput | PromoteConfigInput;

function toConfigFields(config: PromotionConfig) {
	return {
		id: config.id,
		name: config.name,
		createdAt: config.createdAt.toISOString(),
		updatedAt: config.updatedAt.toISOString(),
	};
}

/** The configurations of a connection by direction, without the state of their checkouts. */
function toConfigsSummary(configs: PromotionConfig[]): PromotionConnectionConfigsSummary {
	const result: PromotionConnectionConfigsSummary = {};
	for (const config of configs) {
		const { settings } = config;
		if (config.direction === 'apply' && 'branchName' in settings) {
			result.apply = { ...toConfigFields(config), settings };
		} else if (config.direction === 'promote' && 'baseBranchName' in settings) {
			result.promote = { ...toConfigFields(config), settings };
		}
	}
	return result;
}

/**
 * Fork code (not in upstream n8n): the connections of Git connections, their configurations and
 * their project links. See `README.md`.
 */
@Service()
export class PromotionConnectionsService {
	constructor(
		private readonly connectionRepository: PromotionConnectionRepository,
		private readonly configRepository: PromotionConfigRepository,
		private readonly linkRepository: PromotionConnectionProjectRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly providersService: PromotionProvidersService,
		private readonly checkouts: PromotionCheckouts,
		private readonly git: PromotionGitRunner,
		private readonly eventService: EventService,
	) {}

	async create(input: CreatePromotionConnectionDto, user: User) {
		const provider = await this.providersService.getEntity(input.providerId);
		checkRemoteUrl(input.target.remoteUrl, provider.authType);
		const configs: PromotionConfigInput[] = [];
		if (input.configs?.apply) {
			const { name, settings } = input.configs.apply;
			configs.push({ config: { direction: 'apply', settings }, name });
		}
		if (input.configs?.promote) {
			const { name, settings } = input.configs.promote;
			configs.push({ config: { direction: 'promote', settings }, name });
		}
		for (const { config } of configs) await this.checkBranchNames(config.settings);
		if (input.scope === 'instance' && (await this.connectionRepository.findInstanceConnection())) {
			throw new ConflictError('An instance promotion connection already exists');
		}

		let connection: PromotionConnection;
		try {
			connection = await this.connectionRepository.insertConnection(
				this.connectionRepository.create({
					name: input.name,
					providerId: provider.id,
					scope: input.scope,
					target: input.target,
				}),
			);
		} catch (error) {
			if (error instanceof PromotionRowConflictError) {
				throw new ConflictError('An instance promotion connection already exists');
			}
			throw error;
		}
		for (const { config, name } of configs) {
			await this.configRepository.insertConfig(
				this.configRepository.create({
					connectionId: connection.id,
					direction: config.direction,
					name: name ?? DEFAULT_CONFIG_NAMES[config.direction],
					settings: config.settings,
				}),
			);
		}
		this.eventService.emit('git-connection-created', {
			user,
			connectionId: connection.id,
			connectionName: connection.name,
			scope: connection.scope,
			remoteUrl: scrubSecretsInText(connection.target.remoteUrl),
		});
		return await this.findOne(connection.id);
	}

	async list(
		offset: number,
		limit: number,
		filter: { scope?: PromotionConnectionScope; providerId?: string },
	) {
		const { data, count } = await this.connectionRepository.findPage(offset, limit, filter);
		const configs = await this.configRepository.findByConnectionIds(data.map(({ id }) => id));
		return {
			data: data.map((connection) => ({
				...this.toConnectionBase(connection),
				configs: toConfigsSummary(
					configs.filter(({ connectionId }) => connectionId === connection.id),
				),
			})),
			count,
		};
	}

	/** A connection with its provider and its configurations, with the state of their checkouts. */
	async findOne(id: string) {
		const connection = await this.getConnection(id);
		const configs = await this.configRepository.findByConnectionIds([id]);
		const result: PromotionConnectionConfigsPublic = {};
		for (const config of configs) {
			const { settings } = config;
			const fields = await this.toConfigPublicFields(connection, config);
			if (config.direction === 'apply' && 'branchName' in settings) {
				result.apply = { ...fields, settings };
			} else if (config.direction === 'promote' && 'baseBranchName' in settings) {
				result.promote = { ...fields, settings };
			}
		}
		return { ...this.toConnectionBase(connection), configs: result };
	}

	/** Changes the name, the remote or the provider. A new provider or remote checks the URL again. */
	async update(id: string, input: UpdatePromotionConnectionDto, user: User) {
		const connection = await this.getConnection(id);
		const provider =
			input.providerId !== undefined
				? await this.providersService.getEntity(input.providerId)
				: connection.provider;
		if (!provider) throw new NotFoundError('Promotion provider not found');
		const target = input.target ?? connection.target;
		if (input.providerId !== undefined || input.target !== undefined) {
			checkRemoteUrl(target.remoteUrl, provider.authType);
		}
		if (input.name !== undefined) connection.name = input.name;
		connection.target = target;
		connection.providerId = provider.id;
		connection.provider = provider;
		await this.connectionRepository.save(connection);
		this.emitUpdated(user, connection, { change: 'settings' });
		return await this.findOne(id);
	}

	/** Deletes a connection with its configurations, its project links and its checkouts. */
	async delete(id: string, user: User) {
		const connection = await this.getConnection(id);
		const configs = await this.configRepository.findByConnectionIds([id]);
		await this.connectionRepository.delete({ id });
		for (const config of configs) await this.checkouts.remove(config.id);
		this.eventService.emit('git-connection-deleted', {
			user,
			connectionId: connection.id,
			connectionName: connection.name,
		});
	}

	/** Replaces the configuration of a direction. A new configuration gets an id. */
	async upsertConfig(
		connectionId: string,
		input: ApplyConfigInput,
		user: User,
	): Promise<PromotionApplyConfigPublicDto>;
	async upsertConfig(
		connectionId: string,
		input: PromoteConfigInput,
		user: User,
	): Promise<PromotionPromoteConfigPublicDto>;
	async upsertConfig(connectionId: string, input: PromotionConfigInput, user: User) {
		const connection = await this.getConnection(connectionId);
		const { direction, settings } = input.config;
		await this.checkBranchNames(settings);
		const name = input.name ?? DEFAULT_CONFIG_NAMES[direction];
		let config = await this.configRepository.findByConnectionAndDirection(connectionId, direction);
		if (config) {
			config.name = name;
			config.settings = settings;
			config = await this.configRepository.save(config);
		} else {
			try {
				config = await this.configRepository.insertConfig(
					this.configRepository.create({ connectionId, direction, name, settings }),
				);
			} catch (error) {
				if (error instanceof PromotionRowConflictError) {
					throw new ConflictError(
						`The ${direction} configuration of this connection was created at the same time. Try again.`,
					);
				}
				throw error;
			}
		}
		this.emitUpdated(user, connection, { change: 'configuration', direction });
		return { ...(await this.toConfigPublicFields(connection, config)), settings: config.settings };
	}

	/** Deletes the configuration of a direction and its checkout. Nothing changes in Git. */
	async deleteConfig(connectionId: string, direction: PromotionDirection, user: User) {
		const connection = await this.getConnection(connectionId);
		const config = await this.configRepository.findByConnectionAndDirection(
			connectionId,
			direction,
		);
		if (!config) throw new NotFoundError('Promotion configuration not found');
		await this.configRepository.delete({ id: config.id });
		await this.checkouts.remove(config.id);
		this.emitUpdated(user, connection, { change: 'configuration-removed', direction });
	}

	async listProjects(connectionId: string) {
		await this.getConnection(connectionId);
		return { projectIds: await this.linkRepository.findProjectIds(connectionId) };
	}

	/** Links a team project to a `projects` connection. A link that exists gives the same answer. */
	async addProject({
		user,
		connectionId,
		projectId,
	}: {
		user: User;
		connectionId: string;
		projectId: string;
	}) {
		const connection = await this.getConnection(connectionId);
		if (connection.scope !== 'projects') {
			throw new BadRequestError('Only a project-scoped connection can have project links');
		}
		const project = await this.projectRepository.findOneBy({ id: projectId });
		if (!project) throw new NotFoundError('Project not found');
		if (project.type !== 'team') {
			throw new BadRequestError('Only team projects can be linked to a promotion connection');
		}
		const link = await this.linkRepository.findByProjectId(projectId);
		if (!link) {
			try {
				await this.linkRepository.insertLink(projectId, connectionId);
				this.emitUpdated(user, connection, { change: 'project-linked', projectId });
				return { projectId, connectionId };
			} catch (error) {
				if (!(error instanceof PromotionRowConflictError)) throw error;
			}
		}
		const current = link ?? (await this.linkRepository.findByProjectId(projectId));
		if (current?.connectionId !== connectionId) {
			throw new ConflictError('This project is linked to another promotion connection');
		}
		return { projectId, connectionId };
	}

	/** Removes the link of a project. A project without a link gives no error. */
	async removeProject({
		user,
		connectionId,
		projectId,
	}: {
		user: User;
		connectionId: string;
		projectId: string;
	}) {
		const connection = await this.getConnection(connectionId);
		const link = await this.linkRepository.findByProjectId(projectId);
		if (!link) return;
		if (link.connectionId !== connectionId) {
			throw new ConflictError('This project is linked to another promotion connection');
		}
		await this.linkRepository.delete({ projectId });
		this.emitUpdated(user, connection, { change: 'project-unlinked', projectId });
	}

	private emitUpdated(
		user: User,
		connection: PromotionConnection,
		details: Pick<
			ForkGovernanceEventMap['git-connection-updated'],
			'change' | 'direction' | 'projectId'
		>,
	) {
		this.eventService.emit('git-connection-updated', {
			user,
			connectionId: connection.id,
			connectionName: connection.name,
			...details,
		});
	}

	async getConnection(id: string) {
		const connection = await this.connectionRepository.findWithProvider(id);
		if (!connection) throw new NotFoundError('Promotion connection not found');
		return connection;
	}

	private async toConfigPublicFields(connection: PromotionConnection, config: PromotionConfig) {
		return {
			...toConfigFields(config),
			checkout: await this.checkouts.state(connection, config),
		};
	}

	private toConnectionBase(connection: PromotionConnection) {
		if (!connection.provider) throw new NotFoundError('Promotion provider not found');
		return {
			id: connection.id,
			name: connection.name,
			scope: connection.scope,
			target: connection.target,
			provider: toProviderSummary(connection.provider),
			createdAt: connection.createdAt.toISOString(),
			updatedAt: connection.updatedAt.toISOString(),
		};
	}

	/** Git checks each branch name of the settings. */
	private async checkBranchNames(settings: PromotionConfigSettings) {
		const name = 'branchName' in settings ? settings.branchName : settings.baseBranchName;
		if (!(await this.git.isValidBranchName(name))) {
			throw new BadRequestError(`Invalid Git branch name: ${name}`);
		}
	}
}
