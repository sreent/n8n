import type { Logger } from '@n8n/backend-common';
import type { HttpRequestClient } from '@n8n/backend-network';
import { OperationalError, UserError } from 'n8n-workflow';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';

import type { SentryDestinationOptions } from './destination-options';
import { isErrorEvent, LogStreamingDestination } from './log-streaming-destination';
import { DEFAULT_REQUEST_TIMEOUT_MS, DELIVERY_CONCURRENCY } from '../log-streaming.constants';

const SENTRY_CLIENT = 'n8n-log-streaming/1.0';

/** The envelope endpoint and the public key of a Sentry DSN. Throws for a DSN that is not valid. */
export function sentryEndpoint(dsn: string) {
	let url: URL;
	try {
		url = new URL(dsn);
	} catch {
		throw new UserError('The DSN of the Sentry destination is not a valid URL');
	}
	const key = decodeURIComponent(url.username);
	const segments = url.pathname.split('/').filter(Boolean);
	const projectId = segments.pop();
	if (!key || !projectId) {
		throw new UserError(
			'The DSN of the Sentry destination must contain a public key and a project id',
		);
	}
	const path = segments.map((segment) => `/${segment}`).join('');
	return { url: `${url.protocol}//${url.host}${path}/api/${projectId}/envelope/`, key };
}

/** The id of the Sentry event of a message: the message id without dashes, 32 hex characters. */
function sentryEventId(messageId: string) {
	const id = messageId.replace(/-/g, '').toLowerCase();
	return /^[0-9a-f]{32}$/.test(id) ? id : randomUUID().replace(/-/g, '');
}

/**
 * Sends each event as a Sentry message, in an envelope to the endpoint of the DSN. The Sentry event
 * id comes from the message id, so Sentry drops an event that n8n sends again.
 */
export class SentryDestination extends LogStreamingDestination<SentryDestinationOptions> {
	private readonly endpoint: ReturnType<typeof sentryEndpoint>;

	constructor(
		options: SentryDestinationOptions,
		logger: Logger,
		private readonly client: HttpRequestClient,
	) {
		super(options, logger, DELIVERY_CONCURRENCY.sentry);
		this.endpoint = sentryEndpoint(options.dsn);
	}

	protected async send(message: EventMessageTypes) {
		const { statusCode } = await this.client.request({
			url: this.endpoint.url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${this.endpoint.key}, sentry_client=${SENTRY_CLIENT}`,
			},
			body: this.envelope(message),
			timeout: DEFAULT_REQUEST_TIMEOUT_MS,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
		if (statusCode < 200 || statusCode >= 300) {
			throw new OperationalError(`Sentry answered with the status code ${statusCode}`);
		}
	}

	/** The envelope with the Sentry event of a message. */
	envelope(message: EventMessageTypes) {
		const eventId = sentryEventId(message.id);
		const event = this.serialize(message, { withPayload: this.options.sendPayload !== false });
		const item = JSON.stringify({
			event_id: eventId,
			timestamp: message.ts.toUTC().toISO() ?? new Date().toISOString(),
			platform: 'node',
			level: isErrorEvent(message.eventName) ? 'error' : 'info',
			logger: 'n8n',
			server_name: hostname(),
			message: { formatted: message.message },
			tags: { event: message.eventName },
			extra: event,
		});
		return [
			JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
			JSON.stringify({
				type: 'event',
				content_type: 'application/json',
				length: Buffer.byteLength(item),
			}),
			item,
		].join('\n');
	}
}
