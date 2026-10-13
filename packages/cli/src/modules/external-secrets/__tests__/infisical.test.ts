// The behaviour of the Infisical provider against a fake Infisical server: the form fields, the
// site URL, Universal Auth, the project check, reading secrets with their imports, the new login
// after a refused token, the connection test, and the errors. For each case, the snapshot records
// the result and the state of each step, and the requests that Infisical got. The snapshot
// records what the provider does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
vi.hoisted(() => {
	process.env.N8N_EXTERNAL_SECRETS_CONNECT_TIMEOUT = '1';
	process.env.N8N_EXTERNAL_SECRETS_REFRESH_TIMEOUT = '2';
});

import { Container } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point this import at `@/modules/external-secrets.ee/external-secrets-providers.ee`.
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';

import { drive, outcome, type DrivenProvider } from './fakes/drive';
import {
	emptyInfisicalState,
	startFakeInfisical,
	type FakeInfisicalState,
} from './fakes/fake-infisical';

const newProvider = () =>
	new (Container.get(ExternalSecretsProviders).providers.infisical)() as unknown as DrivenProvider;

function baseState(): FakeInfisicalState {
	return {
		...emptyInfisicalState(),
		identities: { 'client-1': { clientSecret: 'secret-1', accessToken: 'at-1' } },
		tokens: ['at-1'],
		secrets: {
			'proj-1/dev': [
				{ secretKey: 'DB_PASSWORD', secretValue: 'pw' },
				{ secretKey: 'dot.key', secretValue: 'd' },
				{ secretKey: 'EMPTY', secretValue: '' },
				{ secretKey: 'NESTED', secretValue: 'n', secretPath: '/app' },
			],
			'proj-1/prod': [{ secretKey: 'PROD_ONLY', secretValue: 'p' }],
		},
	};
}

const settings = (url: string): IDataObject => ({
	siteURL: url,
	projectId: 'proj-1',
	environment: 'dev',
	secretPath: '/',
	authMethod: 'universalAuth',
	clientId: 'client-1',
	clientSecret: 'secret-1',
});

interface Case {
	name: string;
	settings: (url: string) => IDataObject;
	state?: (state: FakeInfisicalState) => void;
}

const fail = (path: string, status: number, body?: unknown) => (state: FakeInfisicalState) => {
	state.failing[path] = status;
	if (body !== undefined) state.failingBody[path] = body;
};
const secretsBody = (body: unknown) => fail('/api/v4/secrets', 200, body);

const cases: Case[] = [
	{ name: 'site URL', settings },
	{
		name: 'site URL with a trailing slash',
		settings: (url) => ({ ...settings(url), siteURL: `${url}/` }),
	},
	{
		name: 'site URL with a path',
		settings: (url) => ({ ...settings(url), siteURL: `${url}/base` }),
	},
	{
		name: 'site URL with a path and a trailing slash',
		settings: (url) => ({ ...settings(url), siteURL: `${url}/base/` }),
	},
	{ name: 'secret path /app', settings: (url) => ({ ...settings(url), secretPath: '/app' }) },
	{ name: 'secret path app', settings: (url) => ({ ...settings(url), secretPath: 'app' }) },
	{ name: 'secret path /app/', settings: (url) => ({ ...settings(url), secretPath: '/app/' }) },
	{ name: 'empty secret path', settings: (url) => ({ ...settings(url), secretPath: '' }) },
	{ name: 'other environment', settings: (url) => ({ ...settings(url), environment: 'prod' }) },
	{
		name: 'environment that does not exist',
		settings: (url) => ({ ...settings(url), environment: 'staging' }),
	},
	{
		name: 'project that does not exist',
		settings: (url) => ({ ...settings(url), projectId: 'proj-x' }),
	},
	{
		name: 'project ID with spaces',
		settings: (url) => ({ ...settings(url), projectId: ' proj-1 ' }),
	},
	{
		name: 'project ID and path with special characters',
		settings: (url) => ({ ...settings(url), projectId: 'a/b?c#d', secretPath: '/x y+z' }),
	},
	{ name: 'wrong client secret', settings: (url) => ({ ...settings(url), clientSecret: 'nope' }) },
	{ name: 'empty client ID', settings: (url) => ({ ...settings(url), clientId: '' }) },
	{ name: 'empty client secret', settings: (url) => ({ ...settings(url), clientSecret: '' }) },
	{
		name: 'unknown auth method',
		settings: (url) => ({ ...settings(url), authMethod: 'accessToken' }),
	},
	{ name: 'project 401', settings, state: fail('/api/v1/workspace/proj-1', 401) },
	{ name: 'project 403', settings, state: fail('/api/v1/workspace/proj-1', 403) },
	{ name: 'project 500', settings, state: fail('/api/v1/workspace/proj-1', 500) },
	{ name: 'login 429', settings, state: fail('/api/v1/auth/universal-auth/login', 429) },
	{ name: 'login 500', settings, state: fail('/api/v1/auth/universal-auth/login', 500) },
	{ name: 'secrets 403', settings, state: fail('/api/v4/secrets', 403) },
	{ name: 'secrets 404', settings, state: fail('/api/v4/secrets', 404) },
	{ name: 'secrets 500', settings, state: fail('/api/v4/secrets', 500) },
	{
		name: 'duplicate keys',
		settings,
		state: secretsBody({
			secrets: [
				{ secretKey: 'A', secretValue: '1' },
				{ secretKey: 'A', secretValue: '2' },
			],
			imports: [],
		}),
	},
	{
		name: 'keys and values of other types',
		settings,
		state: secretsBody({
			secrets: [
				{ secretKey: 'N', secretValue: 5 },
				{ secretKey: 'U' },
				{ secretValue: 'no key' },
				{ secretKey: '', secretValue: 'empty key' },
				{ secretKey: 'O', secretValue: { x: 1 } },
			],
			imports: [],
		}),
	},
	{
		name: 'imported secrets',
		settings,
		state: secretsBody({
			secrets: [{ secretKey: 'A', secretValue: 'own' }],
			imports: [
				{
					secretPath: '/x',
					environment: 'dev',
					secrets: [
						{ secretKey: 'B', secretValue: 'x1' },
						{ secretKey: 'C', secretValue: 'x2' },
					],
				},
				{
					secretPath: '/y',
					environment: 'dev',
					secrets: [
						{ secretKey: 'B', secretValue: 'y1' },
						{ secretKey: 'A', secretValue: 'y2' },
					],
				},
			],
		}),
	},
	{
		name: 'imports with the keys of empty and missing own values',
		settings,
		state: secretsBody({
			secrets: [{ secretKey: 'EMPTY', secretValue: '' }, { secretKey: 'U' }],
			imports: [
				{
					secretPath: '/x',
					environment: 'dev',
					secrets: [
						{ secretKey: 'EMPTY', secretValue: 'imported' },
						{ secretKey: 'U', secretValue: 'imported' },
					],
				},
			],
		}),
	},
	{ name: 'answer without secrets', settings, state: secretsBody({ imports: [] }) },
	{
		name: 'answer without imports',
		settings,
		state: secretsBody({ secrets: [{ secretKey: 'A', secretValue: '1' }] }),
	},
	{
		name: 'import without secrets',
		settings,
		state: secretsBody({ secrets: [], imports: [{ secretPath: '/x', environment: 'dev' }] }),
	},
];

describe('Infisical provider', () => {
	test('form fields', () => {
		const provider = new (Container.get(ExternalSecretsProviders).providers.infisical)();
		expect({
			name: provider.name,
			displayName: provider.displayName,
			properties: provider.properties,
		}).toMatchSnapshot();
	});

	test.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
		const state = baseState();
		c.state?.(state);
		const infisical = await startFakeInfisical(state);
		try {
			const result = await drive(newProvider(), {
				settings: c.settings(infisical.url),
				step: infisical.step,
				read: ['DB_PASSWORD', 'NESTED', 'EMPTY', 'A', 'B', 'C', 'N', 'U', '', 'O', 'undefined'],
			});
			expect({ result, requests: infisical.requests }).toMatchSnapshot();
		} finally {
			await infisical.close();
		}
	});

	test('request headers', async () => {
		const infisical = await startFakeInfisical(baseState());
		await drive(newProvider(), { settings: settings(infisical.url), step: infisical.step });
		await infisical.close();
		expect(infisical.headers).toMatchSnapshot();
	});

	test('repeated updates, and calls before connect', async () => {
		const infisical = await startFakeInfisical(baseState());
		const provider = newProvider();
		const record: Record<string, unknown> = {};
		await provider.init({ connected: true, connectedAt: null, settings: settings(infisical.url) });
		infisical.step('update before connect');
		record['update before connect'] = await outcome(async () => await provider.update());
		record['names before connect'] = provider.getSecretNames();
		infisical.step('test before connect');
		record['test before connect'] = await outcome(async () => await provider.test());
		infisical.step('connect');
		await provider.connect();
		infisical.step('update');
		await provider.update();
		record.first = provider.getSecretNames();
		infisical.state.secrets['proj-1/dev'] = [{ secretKey: 'OTHER', secretValue: 'o' }];
		await provider.update();
		record['after a change'] = provider.getSecretNames();
		infisical.state.failing['/api/v4/secrets'] = 500;
		record['failing update'] = await outcome(async () => await provider.update());
		record['after the failing update'] = {
			names: provider.getSecretNames(),
			state: provider.state,
		};
		delete infisical.state.failing['/api/v4/secrets'];
		infisical.step('connect again');
		await provider.connect();
		await provider.disconnect();
		await infisical.close();
		expect({ ...record, requests: infisical.requests }).toMatchSnapshot();
	});

	test('a refused token', async () => {
		const infisical = await startFakeInfisical(baseState());
		const provider = newProvider();
		const record: Record<string, unknown> = {};
		await provider.init({ connected: true, connectedAt: null, settings: settings(infisical.url) });
		infisical.step('connect');
		await provider.connect();

		// The token expires: an update logs in again and repeats the request.
		infisical.state.revoked.push('at-1');
		infisical.step('update after the token expires');
		record['update after the token expires'] = await outcome(async () => await provider.update());
		record['names after the new login'] = provider.getSecretNames();

		// A test does not log in again.
		infisical.state.revoked.push('at-1');
		infisical.step('test after the token expires');
		record['test after the token expires'] = await outcome(async () => await provider.test());

		// The server also refuses the token of the new login.
		infisical.state.alwaysRevoked.push('at-1');
		infisical.step('update with a token that stays refused');
		record['update with a token that stays refused'] = await outcome(
			async () => await provider.update(),
		);
		infisical.state.alwaysRevoked = [];

		// The new login fails.
		infisical.state.revoked.push('at-1');
		infisical.state.identities['client-1'].clientSecret = 'changed';
		infisical.step('update when the new login fails');
		record['update when the new login fails'] = await outcome(async () => await provider.update());
		infisical.state.identities['client-1'].clientSecret = 'secret-1';
		infisical.step('update after the failed login');
		record['update after the failed login'] = await outcome(async () => await provider.update());
		record.state = provider.state;
		await provider.disconnect();
		await infisical.close();
		expect({ ...record, requests: infisical.requests }).toMatchSnapshot();
	});

	test('network errors and invalid URLs', async () => {
		const down = await startFakeInfisical(baseState());
		const downUrl = down.url;
		await down.close();
		const record: Record<string, unknown> = {};
		for (const [label, url] of [
			['connection refused', downUrl],
			['invalid URL', 'not a url'],
			['empty URL', ''],
		] as const) {
			const result = await drive(newProvider(), { settings: { ...settings(url), siteURL: url } });
			record[label] = {
				init: result.init,
				connect: result['state after connect'],
				update: result.update,
				test: result.test,
			};
		}
		expect(record).toMatchSnapshot();
	});

	test('timeouts of a slow Infisical', async () => {
		const state = baseState();
		state.delayMs = 3500;
		const infisical = await startFakeInfisical(state);
		const provider = newProvider();
		await provider.init({ connected: true, connectedAt: null, settings: settings(infisical.url) });
		const time = (from: number) => `${Math.round((Date.now() - from) / 500) * 500} ms`;
		let from = Date.now();
		const connect = await outcome(async () => await provider.connect());
		const connectTime = time(from);
		const afterConnect = provider.state;
		from = Date.now();
		const testResult = await outcome(async () => await provider.test());
		const testTime = time(from);
		await provider.disconnect();
		await infisical.close();
		expect({ connect, connectTime, afterConnect, test: testResult, testTime }).toMatchSnapshot();
	}, 20_000);
});
