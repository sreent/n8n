import { mockLogger } from '@n8n/backend-test-utils';
import type { HttpRequestClient } from '@n8n/backend-network';
import { DateTime } from 'luxon';
import { hostname } from 'node:os';
import { mock } from 'vitest-mock-extended';

import { EventMessageWorkflow } from '@/eventbus/event-message-classes/event-message-workflow';

import {
	buildDestinationOptions,
	type SentryDestinationOptions,
} from '../destinations/destination-options';
import { SentryDestination, sentryEndpoint } from '../destinations/sentry.destination';

const ID = '3f1b8a52-6e7c-4f0e-9a51-2d9c7f8e1a20';

const failedEvent = () =>
	new EventMessageWorkflow({
		id: 'b1d6a3a2-8f0c-4d3e-9c1b-7a6e5f4d3c2b',
		eventName: 'n8n.workflow.failed',
		ts: DateTime.fromISO('2026-10-01T10:00:00.000Z', { zone: 'utc' }),
		payload: { workflowId: 'workflow-1' },
	});

function sentryOptions(input: Partial<SentryDestinationOptions> = {}): SentryDestinationOptions {
	const options = buildDestinationOptions(
		{
			__type: '$$MessageEventBusDestinationSentry',
			dsn: 'https://public@sentry.example.com/42',
			enabled: true,
			subscribedEvents: ['*'],
			...input,
		},
		ID,
	);
	if (options?.__type !== '$$MessageEventBusDestinationSentry') throw new Error('Invalid options');
	return options;
}

describe('sentryEndpoint', () => {
	it.each([
		['https://public@sentry.example.com/42', 'https://sentry.example.com/api/42/envelope/'],
		['https://public@o1.ingest.sentry.io/4507', 'https://o1.ingest.sentry.io/api/4507/envelope/'],
		[
			'http://public:secret@sentry.internal:9000/prefix/7',
			'http://sentry.internal:9000/prefix/api/7/envelope/',
		],
	])('gives the envelope endpoint of %s', (dsn, url) => {
		expect(sentryEndpoint(dsn)).toEqual({ url, key: 'public' });
	});

	it('rejects a DSN without a key or a project', () => {
		expect(() => sentryEndpoint('https://sentry.example.com/42')).toThrow(
			'must contain a public key and a project id',
		);
		expect(() => sentryEndpoint('https://public@sentry.example.com/')).toThrow(
			'must contain a public key and a project id',
		);
		expect(() => sentryEndpoint('not a url')).toThrow('not a valid URL');
	});
});

describe('SentryDestination', () => {
	const client = mock<HttpRequestClient>();

	beforeEach(() => {
		vi.resetAllMocks();
		client.request.mockResolvedValue({ statusCode: 200, headers: {}, body: '' });
	});

	it('gives an envelope with an event whose id comes from the message id', () => {
		const destination = new SentryDestination(sentryOptions(), mockLogger(), client);

		const [envelopeHeader, itemHeader, item] = destination.envelope(failedEvent()).split('\n');

		expect(JSON.parse(envelopeHeader)).toMatchObject({
			event_id: 'b1d6a3a28f0c4d3e9c1b7a6e5f4d3c2b',
		});
		expect(JSON.parse(itemHeader)).toEqual({
			type: 'event',
			content_type: 'application/json',
			length: Buffer.byteLength(item),
		});
		expect(JSON.parse(item)).toEqual({
			event_id: 'b1d6a3a28f0c4d3e9c1b7a6e5f4d3c2b',
			timestamp: '2026-10-01T10:00:00.000Z',
			platform: 'node',
			level: 'error',
			logger: 'n8n',
			server_name: hostname(),
			message: { formatted: 'n8n.workflow.failed' },
			tags: { event: 'n8n.workflow.failed' },
			extra: {
				__type: '$$EventMessageWorkflow',
				id: 'b1d6a3a2-8f0c-4d3e-9c1b-7a6e5f4d3c2b',
				ts: '2026-10-01T10:00:00.000Z',
				eventName: 'n8n.workflow.failed',
				message: 'n8n.workflow.failed',
				payload: { workflowId: 'workflow-1' },
			},
		});
	});

	it('leaves out the payload when asked', () => {
		const destination = new SentryDestination(
			sentryOptions({ sendPayload: false }),
			mockLogger(),
			client,
		);

		const item = JSON.parse(destination.envelope(failedEvent()).split('\n')[2]);

		expect(item.extra).not.toHaveProperty('payload');
	});

	it('posts the envelope with the key of the DSN, and fails on a status code that is not 2xx', async () => {
		const destination = new SentryDestination(sentryOptions(), mockLogger(), client);

		await expect(destination.deliver(failedEvent())).resolves.toBe(true);
		expect(client.request).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://sentry.example.com/api/42/envelope/',
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-sentry-envelope',
					'X-Sentry-Auth':
						'Sentry sentry_version=7, sentry_key=public, sentry_client=n8n-log-streaming/1.0',
				},
				body: expect.stringContaining('"event_id":"b1d6a3a28f0c4d3e9c1b7a6e5f4d3c2b"'),
			}),
		);

		client.request.mockResolvedValue({ statusCode: 429, headers: {}, body: '' });
		await expect(destination.deliver(failedEvent())).resolves.toBe(false);
	});
});
