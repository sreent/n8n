import { PublicCreateDestinationDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { CredentialsFinderService } from '@n8n/backend-services';
import { InstanceSettingsLoaderConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@n8n/errors';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { InstanceSettings } from 'n8n-core';
import { jsonParse, type JsonObject } from 'n8n-workflow';
import { isDeepStrictEqual } from 'node:util';
import { v4 as uuid, v5 as uuidV5, validate as isUuid } from 'uuid';
import { z } from 'zod';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { EventMessageConfirmSource } from '@/eventbus/event-message-classes/event-message-confirm';
import {
	EventMessageGeneric,
	eventMessageGenericDestinationTestEvent,
} from '@/eventbus/event-message-classes/event-message-generic';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';
import { InstanceBootstrappingError } from '@/instance-settings-loader/instance-bootstrapping.error';
import { Publisher } from '@/scaling/pubsub/publisher.service';

import { EventDestinationRepository } from './database/event-destination.repository';
import { DestinationCredentials } from './destinations/destination-credentials';
import {
	buildDestinationOptions,
	fromPublicDestination,
	parseDestinationOptions,
	type DestinationInput,
	type DestinationOptions,
} from './destinations/destination-options';
import { DestinationFactory } from './destinations/destination.factory';
import type { LogStreamingDestination } from './destinations/log-streaming-destination';
import { sentryEndpoint } from './destinations/sentry.destination';
import { validateWebhookOptions, webhookCredential } from './destinations/webhook.destination';
import {
	CONFIRM_SOURCE,
	ENV_DESTINATION_ID_NAMESPACE,
	TEST_MESSAGE_TEXT,
} from './log-streaming.constants';

type ConfirmCallback = (message: EventMessageTypes, source: EventMessageConfirmSource) => void;

/** The event of the event bus that hands each sent message to the destinations. */
const MESSAGE_EVENT = 'message';

const ENV_VARIABLE = 'N8N_LOG_STREAMING_DESTINATIONS';

/** The stored form of the options. */
const toJsonObject = (options: DestinationOptions) =>
	jsonParse<JsonObject>(JSON.stringify(options));

/**
 * Delivers the events of the event bus of this process to the log streaming destinations, and
 * manages the stored destinations. The event bus confirms a message when all destinations that
 * take it delivered it. A message that a destination did not take stays unconfirmed in the event
 * log, and the event bus sends it again.
 */
@Service()
export class LogStreamingService {
	private destinations = new Map<string, LogStreamingDestination>();

	private loading: Promise<void> = Promise.resolve();

	private readonly onMessage = (message: EventMessageTypes, confirm: ConfirmCallback) => {
		void this.handleMessage(message, confirm);
	};

	constructor(
		private readonly logger: Logger,
		private readonly eventBus: MessageEventBus,
		private readonly repository: EventDestinationRepository,
		private readonly factory: DestinationFactory,
		private readonly credentials: DestinationCredentials,
		private readonly credentialsFinder: CredentialsFinderService,
		private readonly publisher: Publisher,
		private readonly instanceSettings: InstanceSettings,
		private readonly loaderConfig: InstanceSettingsLoaderConfig,
	) {
		this.logger = this.logger.scoped('log-streaming');
	}

	get managedByEnv() {
		return this.loaderConfig.logStreamingManagedByEnv;
	}

	/**
	 * Loads the destinations and listens to the event bus. When the environment manages the
	 * destinations, a main instance first replaces the stored destinations with those of the
	 * environment.
	 */
	async init() {
		if (this.managedByEnv && this.instanceSettings.instanceType === 'main') {
			await this.applyEnvironmentDestinations();
		}
		await this.loadDestinations();
		this.eventBus.on(MESSAGE_EVENT, this.onMessage);
	}

	async shutdown() {
		this.eventBus.off(MESSAGE_EVENT, this.onMessage);
		const destinations = [...this.destinations.values()];
		this.destinations = new Map();
		await Promise.all(destinations.map(async (destination) => await destination.close()));
	}

	/** Delivers a message to the destinations that take it, and confirms it when all delivered it. */
	async handleMessage(message: EventMessageTypes, confirm: ConfirmCallback) {
		const targets = [...this.destinations.values()].filter((destination) =>
			destination.wants(message.eventName),
		);
		const delivered = await Promise.all(
			targets.map(async (destination) => await destination.deliver(message)),
		);
		if (delivered.every(Boolean)) confirm(message, CONFIRM_SOURCE);
	}

	// #region Loading

	/** Loads the stored destinations again, after a change on another instance. */
	@OnPubSubEvent('restart-event-bus')
	async loadDestinations() {
		const load = this.loading.catch(() => {}).then(async () => await this.load());
		this.loading = load;
		await load;
	}

	/** Makes the destinations of the stored options. Keeps a destination whose options are the same. */
	private async load() {
		const next = new Map<string, LogStreamingDestination>();
		for (const options of await this.storedDestinations()) {
			const current = this.destinations.get(options.id);
			const destination =
				current && isDeepStrictEqual(current.options, options)
					? current
					: this.createDestination(options);
			if (destination) next.set(options.id, destination);
		}
		const previous = [...this.destinations.values()].filter(
			(destination) => next.get(destination.id) !== destination,
		);
		this.destinations = next;
		this.credentials.clear();
		await Promise.all(previous.map(async (destination) => await destination.close()));
	}

	private createDestination(options: DestinationOptions) {
		try {
			return this.factory.create(options);
		} catch (error) {
			this.logger.warn(
				`Skipped the log streaming destination "${options.label ?? options.id}": ${ensureError(error).message}`,
			);
			return undefined;
		}
	}

	/** The stored destinations with valid options, oldest first. */
	private async storedDestinations(): Promise<DestinationOptions[]> {
		const rows = await this.repository.findAllDestinations();
		return rows.flatMap((row) => {
			const options = parseDestinationOptions({ ...row.destination, id: row.id });
			if (!options) {
				this.logger.warn(
					`Skipped the stored log streaming destination "${row.id}", because its options are not valid`,
				);
				return [];
			}
			return [options];
		});
	}

	// #endregion

	// #region Destinations from the environment

	/** Replaces the stored destinations with those of `N8N_LOG_STREAMING_DESTINATIONS`. */
	private async applyEnvironmentDestinations() {
		const destinations = this.environmentDestinations();
		await this.repository.replaceAll(
			destinations.map((options) => ({ id: options.id, destination: toJsonObject(options) })),
		);
		this.logger.info(
			`Applied ${destinations.length} log streaming destinations from ${ENV_VARIABLE}`,
		);
		await this.broadcastReload();
	}

	/**
	 * The destinations of `N8N_LOG_STREAMING_DESTINATIONS`, in the format of the public API. A
	 * destination is on unless it sets `enabled: false`. The id of a destination comes from its
	 * position in the list, so that each main instance gives the same ids.
	 */
	environmentDestinations(): DestinationOptions[] {
		const value = this.loaderConfig.logStreamingDestinations.trim();
		if (!value) return [];

		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new InstanceBootstrappingError(`${ENV_VARIABLE} is not valid JSON`);
		}
		const result = z.array(PublicCreateDestinationDto).safeParse(parsed);
		if (!result.success) {
			const issues = result.error.issues.map(
				({ path, message }) => `${path.join('.')}: ${message}`,
			);
			throw new InstanceBootstrappingError(`${ENV_VARIABLE} is not valid: ${issues.join('; ')}`);
		}

		return result.data.map((input, index) => {
			const id = uuidV5(String(index), ENV_DESTINATION_ID_NAMESPACE);
			const options = buildDestinationOptions(fromPublicDestination(input), id, undefined, {
				enabledByDefault: true,
			});
			if (!options) {
				throw new InstanceBootstrappingError(
					`Destination ${index} of ${ENV_VARIABLE} is not valid`,
				);
			}
			try {
				this.validate(options);
			} catch (error) {
				throw new InstanceBootstrappingError(
					`Destination ${index} of ${ENV_VARIABLE} is not valid: ${ensureError(error).message}`,
				);
			}
			return options;
		});
	}

	// #endregion

	// #region Changes from the REST API

	/** The stored destinations, or the one with the id. */
	async findDestinations(id?: string): Promise<DestinationOptions[]> {
		const destinations = await this.storedDestinations();
		return id === undefined ? destinations : destinations.filter((options) => options.id === id);
	}

	/**
	 * Adds a destination, or changes the destination with the id of the input. The input changes
	 * the stored options. A new destination is off until the input turns it on.
	 */
	async saveDestination(input: DestinationInput, user: User): Promise<DestinationOptions> {
		this.assertNotManagedByEnv();
		const id = input.id ?? uuid();
		if (!isUuid(id)) throw new BadRequestError('The id of a destination must be a UUID');

		const [stored] = await this.findDestinations(id);
		const options = buildDestinationOptions(input, id, stored);
		if (!options) throw new BadRequestError('The options of the destination are not valid');
		try {
			this.validate(options);
		} catch (error) {
			throw new BadRequestError(ensureError(error).message);
		}
		await this.assertCredentialAccess(options, user);

		await this.repository.saveDestination({ id, destination: toJsonObject(options) });
		await this.reloadEverywhere();
		return options;
	}

	/** Deletes a destination, and gives its options. */
	async deleteDestination(id: string): Promise<DestinationOptions> {
		this.assertNotManagedByEnv();
		const options = await this.findDestinationOrFail(id);
		if (!(await this.repository.deleteDestination(id))) throw this.notFound(id);
		await this.reloadEverywhere();
		return options;
	}

	/**
	 * Sends a test event to a destination, and tells if the destination took it. The test ignores
	 * `enabled`, the subscriptions and the circuit breaker. The test sends the data of the
	 * credential of the destination, so the user must have access to the credential.
	 */
	async testDestination(id: string, user: User): Promise<boolean> {
		const options = await this.findDestinationOrFail(id);
		await this.assertCredentialAccess(options, user);
		let destination: LogStreamingDestination;
		try {
			destination = this.factory.create(options);
		} catch (error) {
			throw new BadRequestError(ensureError(error).message);
		}
		try {
			return await destination.sendTest(
				new EventMessageGeneric({
					eventName: eventMessageGenericDestinationTestEvent,
					message: TEST_MESSAGE_TEXT,
					payload: { msg: TEST_MESSAGE_TEXT },
				}),
			);
		} finally {
			await destination.close();
		}
	}

	async findDestinationOrFail(id: string): Promise<DestinationOptions> {
		const [options] = await this.findDestinations(id);
		if (!options) throw this.notFound(id);
		return options;
	}

	private notFound(id: string) {
		return new NotFoundError(`There is no log streaming destination with the id "${id}"`);
	}

	/** Throws a 409 error while the environment manages the destinations. */
	assertNotManagedByEnv() {
		if (this.managedByEnv) {
			throw new ConflictError(
				`Environment variables manage the log streaming destinations. Change ${ENV_VARIABLE} instead.`,
			);
		}
	}

	/** Checks the options that the deliveries use. Throws a `UserError`. */
	private validate(options: DestinationOptions) {
		switch (options.__type) {
			case '$$MessageEventBusDestinationWebhook':
				validateWebhookOptions(options);
				return;
			case '$$MessageEventBusDestinationSentry':
				sentryEndpoint(options.dsn);
				return;
			case '$$MessageEventBusDestinationSyslog':
				return;
		}
	}

	/**
	 * A webhook destination sends the data of its credential to its URL. Thus the user must have
	 * access to the credential.
	 */
	private async assertCredentialAccess(options: DestinationOptions, user: User) {
		if (options.__type !== '$$MessageEventBusDestinationWebhook') return;
		const id = webhookCredential(options)?.id;
		if (!id) return;
		const credential = await this.credentialsFinder.findCredentialForUser(id, user, [
			'credential:read',
		]);
		if (!credential) throw new ForbiddenError(`You do not have access to the credential "${id}"`);
	}

	/** Loads the destinations on this instance, and asks the other instances to load them too. */
	private async reloadEverywhere() {
		await this.loadDestinations();
		await this.broadcastReload();
	}

	private async broadcastReload() {
		try {
			await this.publisher.publishCommand({ command: 'restart-event-bus' });
		} catch (error) {
			this.logger.warn(
				`Could not ask the other instances to load the log streaming destinations again: ${ensureError(error).message}`,
			);
		}
	}

	// #endregion
}
