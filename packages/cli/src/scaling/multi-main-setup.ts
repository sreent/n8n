import { Logger, TypedEmitter } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Time } from '@n8n/constants';
import type { MultiMainEventHandler } from '@n8n/decorators';
import { MultiMainMetadata } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { ErrorReporter, InstanceSettings } from 'n8n-core';

import { LeaderElectionClient } from './leader-election-client';

type MultiMainEvents = {
	/** This main instance became the leader. */
	'leader-takeover': never;

	/** This main instance stopped being the leader. */
	'leader-stepdown': never;
};

/**
 * Fork code (not in upstream n8n): the multi-main setup. Each main instance tries to hold the
 * leader key in Redis. The leader renews the key at each check, and a follower takes the key when
 * it is free. A change of the role emits `leader-takeover` or `leader-stepdown`, which call the
 * handlers of `@OnLeaderTakeover` and `@OnLeaderStepdown`. It replaces the enterprise class of the
 * same name. See `./FORK.md`.
 */
@Service()
export class MultiMainSetup extends TypedEmitter<MultiMainEvents> {
	private leaderCheckInterval: NodeJS.Timeout | undefined;

	constructor(
		private readonly logger: Logger,
		private readonly instanceSettings: InstanceSettings,
		private readonly globalConfig: GlobalConfig,
		private readonly metadata: MultiMainMetadata,
		private readonly errorReporter: ErrorReporter,
		private readonly leaderElectionClient: LeaderElectionClient,
	) {
		super();
		this.logger = this.logger.scoped(['scaling', 'multi-main-setup']);
	}

	private get hostId() {
		return this.instanceSettings.hostId;
	}

	/** Takes the leader key when it is free, and starts the checks of the leadership. */
	async init() {
		const result = await this.leaderElectionClient.setLeaderIfNotExists();

		if (!result.ok) {
			this.logRedisCommandFailure('set leader key in Redis during init', result.error);
			this.instanceSettings.markAsFollower();
		} else if (result.result) {
			this.takeOverAsLeader();
		} else {
			this.instanceSettings.markAsFollower();
		}

		this.leaderCheckInterval = setInterval(() => {
			void this.checkLeader();
		}, this.globalConfig.multiMainSetup.interval * Time.seconds.toMilliseconds);
	}

	/** Stops the checks. A leader frees the leader key for another main instance. */
	async shutdown() {
		clearInterval(this.leaderCheckInterval);

		if (this.instanceSettings.isLeader) {
			const result = await this.leaderElectionClient.clearLeader();
			if (!result.ok) {
				this.logger.warn('Failed to clear leader key from Redis', { error: result.error });
			}
		}

		this.leaderElectionClient.destroy();
	}

	/** The host ID of the leader, or `null` when there is no leader or Redis fails. */
	async fetchLeaderKey() {
		const result = await this.leaderElectionClient.getLeader();
		return result.ok ? result.result : null;
	}

	/** Calls the handlers of `@OnLeaderTakeover` and `@OnLeaderStepdown` on the events. */
	registerEventHandlers() {
		this.metadata.subscribe((handler) => this.attachHandler(handler));
	}

	private attachHandler({ eventHandlerClass, methodName, eventName }: MultiMainEventHandler) {
		this.on(eventName, async () => {
			const instance = Container.get(eventHandlerClass);
			return await instance[methodName].call(instance);
		});
	}

	private async checkLeader() {
		if (this.instanceSettings.isLeader) {
			await this.checkAreWeStillLeader();
		} else {
			await this.checkCanBecomeLeader();
		}
	}

	private async checkAreWeStillLeader() {
		const result = await this.leaderElectionClient.tryRenewLeaderTtl();

		if (!result.ok) {
			this.logRedisCommandFailure('renew leader TTL', result.error);
			return;
		}

		const renewal = result.result;

		if (renewal.id === 'success') {
			this.logger.debug(`[Instance ID ${this.hostId}] Leader is this instance`);
			return;
		}

		this.logger.warn('[Multi-main setup] Leader failed to renew leader key');

		if (renewal.id === 'other-host-is-leader') {
			this.logger.debug(
				`[Instance ID ${this.hostId}] Leader is other instance "${renewal.currentLeaderId}"`,
			);
			this.stepDownToFollower();
			return;
		}

		// The key expired: take it again before another main instance does.
		const claim = await this.leaderElectionClient.setLeaderIfNotExists();

		if (!claim.ok) {
			this.logRedisCommandFailure('set leader key in Redis', claim.error);
			this.stepDownToFollower();
			return;
		}

		if (!claim.result) this.stepDownToFollower();
	}

	private async checkCanBecomeLeader() {
		const result = await this.leaderElectionClient.getLeader();

		if (!result.ok) {
			this.logRedisCommandFailure('get leader key from Redis', result.error);
			return;
		}

		const leaderId = result.result;

		if (leaderId === this.hostId) {
			this.errorReporter.info(
				`[Instance ID ${this.hostId}] Remote/Local leadership mismatch, marking self as leader`,
				{ shouldBeLogged: true, shouldReport: true },
			);
			this.takeOverAsLeader();
			return;
		}

		if (leaderId) {
			this.logger.debug(`[Instance ID ${this.hostId}] Leader is other instance "${leaderId}"`);
			return;
		}

		this.logger.debug(
			`[Instance ID ${this.hostId}] Leadership vacant, attempting to become leader...`,
		);

		const claim = await this.leaderElectionClient.setLeaderIfNotExists();

		if (!claim.ok) {
			this.logger.warn('Failed to try leader key set in Redis', { error: claim.error });
			return;
		}

		if (claim.result) this.takeOverAsLeader();
	}

	private takeOverAsLeader() {
		this.logger.info(`[Instance ID ${this.hostId}] Leader is now this instance`);
		this.instanceSettings.markAsLeader();
		this.emit('leader-takeover');
	}

	private stepDownToFollower() {
		this.logger.info(`[Instance ID ${this.hostId}] This is now a follower instance`);
		this.instanceSettings.markAsFollower();
		this.emit('leader-stepdown');
	}

	private logRedisCommandFailure(action: string, error: Error) {
		this.logger.warn(`Failed to ${action}: ${error.message}`, { error });
	}
}
