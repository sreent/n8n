import type { PromotionDirection } from '@n8n/api-types';
import { ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, NotFoundError } from '@n8n/errors';

import type { PromotionConfig } from './database/entities/promotion-config.entity';
import type { PromotionConnection } from './database/entities/promotion-connection.entity';
import { PromotionConfigRepository } from './database/repositories/promotion-config.repository';
import { PromotionConnectionProjectRepository } from './database/repositories/promotion-connection-project.repository';
import { PromotionConnectionRepository } from './database/repositories/promotion-connection.repository';
import { PromotionCheckouts } from './promotion-checkouts';

const OPERATION_NAMES: Record<PromotionDirection, string> = {
	apply: 'Apply',
	promote: 'Promote',
};

/** The verb of the error of a configuration without a checkout. */
type CheckoutUse = 'operation' | 'branch files';

/**
 * Fork code (not in upstream n8n): finds the connection and the configuration of an operation, and
 * checks them in the order of the original: the connection, the configuration, the scope of the
 * connection, and the checkout.
 */
@Service()
export class PromotionTargets {
	constructor(
		private readonly connectionRepository: PromotionConnectionRepository,
		private readonly configRepository: PromotionConfigRepository,
		private readonly linkRepository: PromotionConnectionProjectRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly checkouts: PromotionCheckouts,
	) {}

	/** The connection that an operation names, with the configuration of the direction. */
	async forConnection(connectionId: string, direction: PromotionDirection) {
		const connection = await this.connectionRepository.findWithProvider(connectionId);
		if (!connection) throw new NotFoundError('Promotion connection not found');
		const config = await this.configRepository.findByConnectionAndDirection(
			connectionId,
			direction,
		);
		if (!config) throw new NotFoundError(`This connection has no ${direction} configuration`);
		return { connection, config };
	}

	/**
	 * The connection of a team project: its own connection, else the instance connection, with the
	 * configuration of the direction.
	 */
	async forProject(projectId: string, direction: PromotionDirection) {
		const project = await this.projectRepository.findOneBy({ id: projectId });
		if (!project) throw new NotFoundError('Project not found');
		if (project.type !== 'team') {
			throw new BadRequestError('Only team projects can use a promotion connection');
		}
		const link = await this.linkRepository.findByProjectId(projectId);
		const connection = link
			? await this.connectionRepository.findWithProvider(link.connectionId)
			: await this.connectionRepository.findInstanceConnection();
		if (!connection) {
			throw new NotFoundError('No promotion connection is configured for this instance');
		}
		const config = await this.configRepository.findByConnectionAndDirection(
			connection.id,
			direction,
		);
		if (!config) {
			throw new BadRequestError(
				link
					? `The promotion connection for this project has no ${direction} configuration`
					: `The instance promotion connection has no ${direction} configuration`,
			);
		}
		return { project, connection, config };
	}

	/** Promote and Apply work on the instance connection only. */
	assertInstanceConnection(connection: PromotionConnection, direction: PromotionDirection) {
		if (connection.scope !== 'instance') {
			throw new BadRequestError(
				`${OPERATION_NAMES[direction]} is only available on the instance connection. Project connections are not supported yet.`,
			);
		}
	}

	/** An operation needs a checkout with the remote and the branch of the configuration. */
	async assertCloned(
		connection: PromotionConnection,
		config: PromotionConfig,
		use: CheckoutUse = 'operation',
	) {
		const { matchesConfig } = await this.checkouts.state(connection, config);
		if (matchesConfig) return;
		const action =
			use === 'branch files'
				? 'listing branch files'
				: config.direction === 'apply'
					? 'applying'
					: 'promoting';
		throw new BadRequestError(
			`This ${config.direction} configuration is not cloned. Clone it before ${action}.`,
		);
	}
}
