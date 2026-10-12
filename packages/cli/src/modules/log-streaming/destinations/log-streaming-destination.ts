import type { Logger } from '@n8n/backend-common';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import type { AbstractEventPayload } from '@/eventbus/event-message-classes/abstract-event-payload';

import { CircuitBreaker } from './circuit-breaker';
import { DeliveryQueue } from './delivery-queue';
import { isSubscribed, type DestinationOptions } from './destination-options';
import {
	AUDIT_EVENT_PREFIX,
	FAILURE_LOG_INTERVAL_MS,
	MAX_WAITING_DELIVERIES,
	SHUTDOWN_TIMEOUT_MS,
} from '../log-streaming.constants';

/** An event as a destination sends it. */
export interface SerializedEvent {
	__type: string;
	id: string;
	ts: string | undefined;
	eventName: string;
	message: string;
	payload?: AbstractEventPayload;
}

/** Events with these endings are errors. The other events are information. */
const ERROR_EVENT_SUFFIXES = ['.failed', '.crashed'];

export const isErrorEvent = (eventName: string) =>
	ERROR_EVENT_SUFFIXES.some((suffix) => eventName.endsWith(suffix));

/**
 * A log streaming destination. It delivers the events that it subscribes to. A circuit breaker
 * stops the deliveries for a time after repeated failures, and a queue limits the deliveries that
 * run at the same time.
 */
export abstract class LogStreamingDestination<O extends DestinationOptions = DestinationOptions> {
	private readonly breaker: CircuitBreaker;

	private readonly queue: DeliveryQueue;

	private lastFailureLogAt = 0;

	private unloggedFailures = 0;

	constructor(
		readonly options: O,
		protected readonly logger: Logger,
		concurrency: number,
	) {
		this.breaker = new CircuitBreaker(options.circuitBreaker);
		this.queue = new DeliveryQueue(concurrency, MAX_WAITING_DELIVERIES);
	}

	get id() {
		return this.options.id;
	}

	get label() {
		return this.options.label ?? this.options.id;
	}

	/** Whether the destination takes the event: it is on, and it subscribes to the event. */
	wants(eventName: string) {
		return this.options.enabled === true && isSubscribed(this.options.subscribedEvents, eventName);
	}

	/** Delivers an event. Resolves with `true` when the destination took it. Never rejects. */
	async deliver(message: EventMessageTypes): Promise<boolean> {
		try {
			return await this.queue.run(async () => {
				if (!this.breaker.tryStart()) {
					this.logFailure('the circuit breaker stops the deliveries for a time');
					return false;
				}
				try {
					await this.send(message);
					this.breaker.recordSuccess();
					return true;
				} catch (error) {
					this.breaker.recordFailure();
					this.logFailure(ensureError(error).message);
					return false;
				}
			});
		} catch (error) {
			this.logFailure(ensureError(error).message);
			return false;
		}
	}

	/** Sends a test event. The test ignores `enabled`, the subscriptions and the circuit breaker. */
	async sendTest(message: EventMessageTypes): Promise<boolean> {
		try {
			await this.send(message);
			return true;
		} catch (error) {
			this.logger.warn(
				`Log streaming destination "${this.label}" did not take the test event: ${ensureError(error).message}`,
			);
			return false;
		}
	}

	/** Waits for the open deliveries, then releases the connections of the destination. */
	async close() {
		await this.queue.idle(SHUTDOWN_TIMEOUT_MS);
		await this.dispose();
	}

	/** Sends one event. Rejects when the destination did not take it. */
	protected abstract send(message: EventMessageTypes): Promise<void>;

	/** Releases the connections of the destination. */
	protected async dispose(): Promise<void> {}

	/**
	 * The event as the destination sends it. When the destination anonymizes audit events, the
	 * values of the payload keys that start with `_` become `*`.
	 */
	protected serialize(message: EventMessageTypes, { withPayload = true } = {}): SerializedEvent {
		const { __type, id, eventName } = message;
		const event: SerializedEvent = {
			__type,
			id,
			ts: message.ts.toISO() ?? undefined,
			eventName,
			message: message.message,
		};
		if (!withPayload) return event;
		const anonymize =
			this.options.anonymizeAuditMessages === true && eventName.startsWith(AUDIT_EVENT_PREFIX);
		event.payload = anonymize ? message.anonymize() : message.payload;
		return event;
	}

	/** Logs a failed delivery at once, then at most once a minute with the count of failures. */
	private logFailure(reason: string) {
		this.unloggedFailures++;
		const now = Date.now();
		if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
		const count = this.unloggedFailures;
		this.lastFailureLogAt = now;
		this.unloggedFailures = 0;
		this.logger.warn(
			`Log streaming destination "${this.label}" did not take ${count === 1 ? 'an event' : `${count} events`}: ${reason}. The events stay unconfirmed in the event log.`,
		);
	}
}
