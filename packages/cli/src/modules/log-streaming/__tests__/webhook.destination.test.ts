import { mockLogger } from '@n8n/backend-test-utils';
import type { HttpRequestClient } from '@n8n/backend-network';
import { DateTime } from 'luxon';
import { mock } from 'vitest-mock-extended';

import { EventMessageAudit } from '@/eventbus/event-message-classes/event-message-audit';

import type { DestinationCredentials } from '../destinations/destination-credentials';
import {
	buildDestinationOptions,
	type DestinationInput,
	type WebhookDestinationOptions,
} from '../destinations/destination-options';
import { validateWebhookOptions, WebhookDestination } from '../destinations/webhook.destination';

const ID = '3f1b8a52-6e7c-4f0e-9a51-2d9c7f8e1a20';

const loginEvent = () =>
	new EventMessageAudit({
		id: 'b1d6a3a2-8f0c-4d3e-9c1b-7a6e5f4d3c2b',
		eventName: 'n8n.audit.user.login.success',
		ts: DateTime.fromISO('2026-10-01T10:00:00.000Z', { zone: 'utc' }),
		payload: { userId: 'user-1', _email: 'ann@example.com' },
	});

function webhookOptions(
	input: Partial<Extract<DestinationInput, { __type: '$$MessageEventBusDestinationWebhook' }>> = {},
): WebhookDestinationOptions {
	const options = buildDestinationOptions(
		{
			__type: '$$MessageEventBusDestinationWebhook',
			url: 'https://siem.example.com/events',
			enabled: true,
			subscribedEvents: ['*'],
			...input,
		},
		ID,
	);
	if (options?.__type !== '$$MessageEventBusDestinationWebhook') throw new Error('Invalid options');
	return options;
}

describe('WebhookDestination', () => {
	const client = mock<HttpRequestClient>();
	const credentials = mock<DestinationCredentials>();

	const destination = (input: Parameters<typeof webhookOptions>[0] = {}) =>
		new WebhookDestination(webhookOptions(input), mockLogger(), client, credentials);

	beforeEach(() => {
		vi.resetAllMocks();
		client.request.mockResolvedValue({ statusCode: 200, headers: {}, body: 'ok' });
	});

	describe('request', () => {
		it('sends the event as JSON with the method of the options', async () => {
			const request = await destination({ method: 'put' }).request(loginEvent());

			expect(request).toEqual({
				url: 'https://siem.example.com/events',
				method: 'PUT',
				headers: {},
				qs: {},
				json: true,
				timeout: 5_000,
				body: {
					__type: '$$EventMessageAudit',
					id: 'b1d6a3a2-8f0c-4d3e-9c1b-7a6e5f4d3c2b',
					ts: '2026-10-01T10:00:00.000Z',
					eventName: 'n8n.audit.user.login.success',
					message: 'n8n.audit.user.login.success',
					payload: { userId: 'user-1', _email: 'ann@example.com' },
				},
			});
		});

		it('anonymizes an audit event, and leaves out the payload when asked', async () => {
			const anonymized = await destination({ anonymizeAuditMessages: true }).request(loginEvent());
			expect(anonymized.body).toMatchObject({ payload: { userId: 'user-1', _email: '*' } });

			const withoutPayload = await destination({ sendPayload: false }).request(loginEvent());
			expect(withoutPayload.body).not.toHaveProperty('payload');
		});

		it('adds the headers and the query parameters of the options', async () => {
			const fromPairs = await destination({
				sendHeaders: true,
				specifyHeaders: 'keypair',
				headerParameters: { parameters: [{ name: 'X-Source', value: 'n8n' }] },
				sendQuery: true,
				specifyQuery: 'keypair',
				queryParameters: { parameters: [{ name: 'channel', value: 7 }] },
			}).request(loginEvent());
			expect(fromPairs).toMatchObject({ headers: { 'X-Source': 'n8n' }, qs: { channel: 7 } });

			const fromJson = await destination({
				sendHeaders: true,
				specifyHeaders: 'json',
				jsonHeaders: '{"X-Source":"n8n","X-Tags":["a"]}',
				sendQuery: true,
				specifyQuery: 'json',
				jsonQuery: '{"channel":"audit"}',
			}).request(loginEvent());
			expect(fromJson).toMatchObject({
				headers: { 'X-Source': 'n8n', 'X-Tags': '["a"]' },
				qs: { channel: 'audit' },
			});
		});

		it('ignores the headers and the query parameters when sending them is off', async () => {
			const request = await destination({
				sendHeaders: false,
				specifyHeaders: 'json',
				jsonHeaders: '{"X-Source":"n8n"}',
			}).request(loginEvent());

			expect(request.headers).toEqual({});
		});

		it('passes the request options', async () => {
			const request = await destination({
				options: {
					allowUnauthorizedCerts: true,
					queryParameterArrays: 'brackets',
					redirect: { redirect: { followRedirects: false, maxRedirects: 3 } },
					proxy: { proxy: { protocol: 'http', host: 'proxy.internal', port: 3128 } },
					timeout: 1_000,
				},
			}).request(loginEvent());

			expect(request).toMatchObject({
				skipSslCertificateValidation: true,
				arrayFormat: 'brackets',
				disableFollowRedirect: true,
				maxRedirects: 3,
				proxy: { protocol: 'http', host: 'proxy.internal', port: 3128 },
				timeout: 1_000,
			});
		});

		it.each([
			[
				'httpBasicAuth',
				{ user: 'ann', password: 'secret' },
				{ auth: { username: 'ann', password: 'secret' } },
			],
			['httpBearerAuth', { token: 't0k3n' }, { headers: { Authorization: 'Bearer t0k3n' } }],
			['httpHeaderAuth', { name: 'X-Api-Key', value: 'k3y' }, { headers: { 'X-Api-Key': 'k3y' } }],
			['httpQueryAuth', { name: 'api_key', value: 'k3y' }, { qs: { api_key: 'k3y' } }],
			[
				'httpCustomAuth',
				{ json: '{"headers":{"X-A":"1"},"qs":{"b":"2"},"body":{"tenant":"acme"}}' },
				{
					headers: { 'X-A': '1' },
					qs: { b: '2' },
					body: expect.objectContaining({ tenant: 'acme' }),
				},
			],
		])('adds the values of a %s credential', async (type, data, expected) => {
			credentials.load.mockResolvedValue(data);

			const request = await destination({
				authentication: 'genericCredentialType',
				genericAuthType: type,
				credentials: { [type]: { id: 'credential-1', name: 'Credential' } },
			}).request(loginEvent());

			expect(credentials.load).toHaveBeenCalledWith('credential-1', type);
			expect(request).toMatchObject(expected);
		});
	});

	describe('delivery', () => {
		it('takes a 2xx status code as a success', async () => {
			client.request.mockResolvedValue({ statusCode: 204, headers: {}, body: '' });

			await expect(destination().deliver(loginEvent())).resolves.toBe(true);
			expect(client.request).toHaveBeenCalledWith(
				expect.objectContaining({ returnFullResponse: true, ignoreHttpStatusErrors: true }),
			);
		});

		it('takes another status code, or an error, as a failure', async () => {
			client.request.mockResolvedValueOnce({ statusCode: 500, headers: {}, body: '' });
			await expect(destination().deliver(loginEvent())).resolves.toBe(false);

			client.request.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
			await expect(destination().deliver(loginEvent())).resolves.toBe(false);
		});

		it('takes only the expected status code when the code must match', async () => {
			const strict = destination({ responseCodeMustMatch: true, expectedStatusCode: 202 });

			client.request.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: '' });
			await expect(strict.deliver(loginEvent())).resolves.toBe(false);
			client.request.mockResolvedValueOnce({ statusCode: 202, headers: {}, body: '' });
			await expect(strict.deliver(loginEvent())).resolves.toBe(true);
		});

		it('stops the deliveries after the maximum failures, but not the test event', async () => {
			client.request.mockResolvedValue({ statusCode: 503, headers: {}, body: '' });
			const failing = destination({ circuitBreaker: { maxFailures: 2 } });

			await failing.deliver(loginEvent());
			await failing.deliver(loginEvent());
			client.request.mockClear();
			await expect(failing.deliver(loginEvent())).resolves.toBe(false);
			expect(client.request).not.toHaveBeenCalled();

			client.request.mockResolvedValue({ statusCode: 200, headers: {}, body: '' });
			await expect(failing.sendTest(loginEvent())).resolves.toBe(true);
		});
	});

	it('takes only the events that it subscribes to while it is on', () => {
		expect(destination({ subscribedEvents: ['n8n.audit'] }).wants('n8n.audit.user.deleted')).toBe(
			true,
		);
		expect(destination({ subscribedEvents: ['n8n.audit'] }).wants('n8n.workflow.success')).toBe(
			false,
		);
		expect(destination({ enabled: false }).wants('n8n.audit.user.deleted')).toBe(false);
	});
});

describe('validateWebhookOptions', () => {
	it('accepts valid options', () => {
		expect(() =>
			validateWebhookOptions(
				webhookOptions({
					authentication: 'genericCredentialType',
					genericAuthType: 'httpHeaderAuth',
					credentials: { httpHeaderAuth: { id: 'credential-1', name: 'Header' } },
				}),
			),
		).not.toThrow();
	});

	it.each([
		[{ method: 'TRACE' }, 'The method "TRACE" is not supported'],
		[
			{ sendHeaders: true, specifyHeaders: 'json', jsonHeaders: '{' },
			'The JSON of the headers is not valid',
		],
		[
			{ sendQuery: true, specifyQuery: 'json', jsonQuery: '[1]' },
			'The JSON of the query must be an object',
		],
		[
			{ authentication: 'predefinedCredentialType', nodeCredentialType: 'slackApi' },
			'Log streaming supports only generic credential types',
		],
		[
			{ authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' },
			'Log streaming does not support the credential type "oAuth2Api"',
		],
		[
			{ authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth' },
			'Select a credential for the authentication',
		],
	] as const)('rejects %j', (input, message) => {
		expect(() => validateWebhookOptions(webhookOptions(input))).toThrow(message);
	});
});
