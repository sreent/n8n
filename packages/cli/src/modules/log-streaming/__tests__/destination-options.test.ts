import {
	buildDestinationOptions,
	fromPublicDestination,
	isSubscribed,
	parseDestinationOptions,
} from '../destinations/destination-options';

const ID = '3f1b8a52-6e7c-4f0e-9a51-2d9c7f8e1a20';

describe('isSubscribed', () => {
	it.each([
		[['*'], 'n8n.audit.user.login.success', true],
		[['n8n.audit'], 'n8n.audit.user.login.success', true],
		[['n8n.audit.'], 'n8n.audit.user.login.success', true],
		[['n8n.workflow.success'], 'n8n.workflow.success', true],
		[['n8n.workflow'], 'n8n.audit.workflow.created', false],
		[['n8n.work'], 'n8n.workflow.success', false],
		[['n8n.workflow.success'], 'n8n.workflow.started', false],
		[[], 'n8n.workflow.started', false],
		[undefined, 'n8n.workflow.started', false],
	])('subscriptions %j take %s: %s', (subscribedEvents, eventName, expected) => {
		expect(isSubscribed(subscribedEvents, eventName)).toBe(expected);
	});
});

describe('buildDestinationOptions', () => {
	it('gives a new destination the defaults of its kind, and keeps it off', () => {
		const options = buildDestinationOptions(
			{ __type: '$$MessageEventBusDestinationWebhook', url: 'https://example.com/hook' },
			ID,
		);

		expect(options).toMatchObject({
			__type: '$$MessageEventBusDestinationWebhook',
			id: ID,
			url: 'https://example.com/hook',
			enabled: false,
			method: 'POST',
			subscribedEvents: ['n8n.audit', 'n8n.workflow'],
			sendPayload: true,
		});
	});

	it('turns a new destination on when the input or the caller asks for it', () => {
		const syslog = { __type: '$$MessageEventBusDestinationSyslog', host: 'logs' } as const;

		expect(buildDestinationOptions({ ...syslog, enabled: true }, ID)?.enabled).toBe(true);
		expect(
			buildDestinationOptions(syslog, ID, undefined, { enabledByDefault: true }),
		).toMatchObject({ enabled: true, port: 514, protocol: 'tcp', facility: 16, app_name: 'n8n' });
	});

	it('changes only the given options of a stored destination of the same kind', () => {
		const stored = buildDestinationOptions(
			{
				__type: '$$MessageEventBusDestinationSyslog',
				host: 'logs',
				port: 6514,
				enabled: true,
			},
			ID,
		);

		const changed = buildDestinationOptions(
			{ __type: '$$MessageEventBusDestinationSyslog', host: 'logs', label: 'SIEM' },
			ID,
			stored,
		);

		expect(changed).toMatchObject({ label: 'SIEM', port: 6514, enabled: true });
	});

	it('uses the defaults when the kind of a stored destination changes', () => {
		const stored = buildDestinationOptions(
			{ __type: '$$MessageEventBusDestinationSyslog', host: 'logs', enabled: true },
			ID,
		);

		const changed = buildDestinationOptions(
			{ __type: '$$MessageEventBusDestinationSentry', dsn: 'https://key@sentry.example.com/1' },
			ID,
			stored,
		);

		expect(changed).toMatchObject({ __type: '$$MessageEventBusDestinationSentry', enabled: false });
		expect(changed).not.toHaveProperty('host');
	});
});

describe('parseDestinationOptions', () => {
	it('gives undefined for options that are not valid or have no id', () => {
		expect(parseDestinationOptions({ __type: '$$MessageEventBusDestinationWebhook' })).toBe(
			undefined,
		);
		expect(
			parseDestinationOptions({ __type: '$$MessageEventBusDestinationSyslog', host: 'logs' }),
		).toBe(undefined);
		expect(
			parseDestinationOptions({
				__type: '$$MessageEventBusDestinationSyslog',
				host: 'logs',
				id: ID,
			}),
		).toMatchObject({ host: 'logs', id: ID });
	});
});

describe('fromPublicDestination', () => {
	it('gives each public type its kind', () => {
		expect(fromPublicDestination({ type: 'webhook', url: 'https://example.com' })).toEqual({
			__type: '$$MessageEventBusDestinationWebhook',
			url: 'https://example.com',
		});
		expect(fromPublicDestination({ type: 'syslog', host: 'logs' })).toEqual({
			__type: '$$MessageEventBusDestinationSyslog',
			host: 'logs',
		});
		expect(
			fromPublicDestination({ type: 'sentry', dsn: 'https://key@sentry.example.com/1' }),
		).toEqual({
			__type: '$$MessageEventBusDestinationSentry',
			dsn: 'https://key@sentry.example.com/1',
		});
	});
});
