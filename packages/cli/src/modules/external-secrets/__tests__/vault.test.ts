// The behaviour of the HashiCorp Vault provider against a fake Vault server: the form fields, the
// URL forms, the namespace, the three auth methods, the discovery of KV mounts, manual KV
// mounts, the secrets and their names, the connection test, the token renewal, and the errors.
// For each case, the snapshot records the result and the state of each step, and the requests
// that Vault got. The snapshot records what the provider does, so a change in behaviour shows up
// as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
vi.hoisted(() => {
	process.env.N8N_EXTERNAL_SECRETS_CONNECT_TIMEOUT = '1';
	process.env.N8N_EXTERNAL_SECRETS_REFRESH_TIMEOUT = '2';
});

import { Container } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';

// The code under test. To record the snapshot against the original files, point this import at
// `@/modules/external-secrets.ee/external-secrets-providers.ee`.
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';

import { drive, outcome, sortedByStep, type DrivenProvider } from './fakes/drive';
import {
	emptyVaultState,
	startFakeVault,
	vaultMount,
	type FakeVault,
	type FakeVaultState,
} from './fakes/fake-vault';

const newProvider = () =>
	new (Container.get(ExternalSecretsProviders).providers.vault)() as unknown as DrivenProvider;

const realSetTimeout = globalThis.setTimeout;
/** Wait for the requests of the local fake server, also while the timers are fake. */
const settle = async (ms = 150) => await new Promise((resolve) => realSetTimeout(resolve, ms));

function baseState(): FakeVaultState {
	return {
		...emptyVaultState(),
		tokens: {
			'tok-1': { ttl: 0, renewable: false },
			'tok-up': { ttl: 0, renewable: false },
			'tok-ar': { ttl: 0, renewable: false },
		},
		userpass: {
			alice: { password: 'pw', token: 'tok-up' },
			'a/b c': { password: 'pw', token: 'tok-up' },
		},
		approle: { 'role-1': { secretId: 'sec-1', token: 'tok-ar' } },
		mounts: {
			'secret/': vaultMount('kv', '2'),
			'kv/': vaultMount('kv', '1'),
			'sys/': vaultMount('system', null),
		},
		kv: {
			'secret/': { top: { a: '1' }, 'app/db': { user: 'u' } },
			'kv/': { one: { x: 'y' } },
		},
	};
}

const token = (url: string): IDataObject => ({
	url: `${url}/v1/`,
	authMethod: 'token',
	token: 'tok-1',
});
const userpass = (url: string): IDataObject => ({
	url: `${url}/v1/`,
	authMethod: 'usernameAndPassword',
	username: 'alice',
	password: 'pw',
});
const appRole = (url: string): IDataObject => ({
	url: `${url}/v1/`,
	authMethod: 'appRole',
	roleId: 'role-1',
	secretId: 'sec-1',
});
const manual = (url: string, extra: IDataObject): IDataObject => ({ ...token(url), ...extra });

interface Case {
	name: string;
	settings: (url: string) => IDataObject;
	state?: (state: FakeVaultState) => void;
}

const fail = (path: string, status: number, body?: unknown) => (state: FakeVaultState) => {
	state.failing[path] = status;
	if (body !== undefined) state.failingBody[path] = body;
};

const cases: Case[] = [
	{ name: 'URL with /v1/', settings: token },
	{ name: 'URL with /v1', settings: (url) => ({ ...token(url), url: `${url}/v1` }) },
	{ name: 'URL with /', settings: (url) => ({ ...token(url), url: `${url}/` }) },
	{ name: 'URL without a path', settings: (url) => ({ ...token(url), url }) },
	{ name: 'namespace', settings: (url) => ({ ...token(url), namespace: 'team' }) },
	{
		name: 'namespace with slashes',
		settings: (url) => ({ ...token(url), namespace: '/admin/team/' }),
	},
	{ name: 'token that Vault refuses', settings: (url) => ({ ...token(url), token: 'bad' }) },
	{ name: 'empty token', settings: (url) => ({ ...token(url), token: '' }) },
	{ name: 'userpass login', settings: userpass },
	{
		name: 'userpass login with a wrong password',
		settings: (url) => ({ ...userpass(url), password: 'nope' }),
	},
	{
		name: 'userpass name with a slash and a space',
		settings: (url) => ({ ...userpass(url), username: 'a/b c' }),
	},
	{
		name: 'userpass login with a namespace',
		settings: (url) => ({ ...userpass(url), namespace: 'team' }),
	},
	{ name: 'AppRole login', settings: appRole },
	{
		name: 'AppRole login with a wrong secret ID',
		settings: (url) => ({ ...appRole(url), secretId: 'nope' }),
	},
	{
		name: 'AppRole login with a namespace',
		settings: (url) => ({ ...appRole(url), namespace: 'team' }),
	},
	{ name: 'unknown auth method', settings: (url) => ({ ...token(url), authMethod: 'ldap' }) },
	{ name: 'sys/mounts 403', settings: token, state: (s) => s.forbidden.push('sys/mounts') },
	{ name: 'sys/mounts 401', settings: token, state: fail('sys/mounts', 401) },
	{ name: 'sys/mounts 404', settings: token, state: fail('sys/mounts', 404, { errors: [] }) },
	{ name: 'sys/mounts 500', settings: token, state: fail('sys/mounts', 500) },
	{ name: 'sys/mounts 503', settings: token, state: fail('sys/mounts', 503) },
	{ name: 'token lookup 400', settings: token, state: fail('auth/token/lookup-self', 400) },
	{ name: 'token lookup 401', settings: token, state: fail('auth/token/lookup-self', 401) },
	{
		name: 'token lookup 404',
		settings: token,
		state: fail('auth/token/lookup-self', 404, { errors: ['not found'] }),
	},
	{ name: 'token lookup 429', settings: token, state: fail('auth/token/lookup-self', 429) },
	{ name: 'token lookup 500', settings: token, state: fail('auth/token/lookup-self', 500) },
	{ name: 'token lookup 503', settings: token, state: fail('auth/token/lookup-self', 503) },
	{
		name: 'mounts that are not KV v1 or v2',
		settings: token,
		state: (s) => {
			s.mounts = {
				'secret/': vaultMount('kv', '2'),
				'noversion/': { ...vaultMount('kv', null), options: {} },
				'generic/': vaultMount('generic', null),
				'cubbyhole/': vaultMount('cubbyhole', null),
				'sys/': vaultMount('system', null),
			};
			s.kv['noversion/'] = { n: { a: 'b' } };
			s.kv['generic/'] = { g: { a: 'b' } };
		},
	},
	{
		name: 'manual KV v2 mount',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: (s) => s.forbidden.push('sys/mounts'),
	},
	{
		name: 'manual mount without a trailing slash',
		settings: (url) => manual(url, { kvMountPath: 'secret', kvVersion: '2' }),
		state: (s) => s.forbidden.push('sys/mounts'),
	},
	{
		name: 'manual KV v1 mount',
		settings: (url) => manual(url, { kvMountPath: 'kv/', kvVersion: '1' }),
		state: (s) => s.forbidden.push('sys/mounts'),
	},
	{
		name: 'manual mount without a version',
		settings: (url) => manual(url, { kvMountPath: 'secret/' }),
	},
	{
		name: 'manual mount with a folder',
		settings: (url) =>
			manual(url, { kvMountPath: 'secret/', kvVersion: '2', kvSecretPath: 'app/' }),
	},
	{
		name: 'manual mount with a folder without a trailing slash',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2', kvSecretPath: 'app' }),
	},
	{
		name: 'manual KV v1 mount with a folder',
		settings: (url) => manual(url, { kvMountPath: 'kv/', kvVersion: '1', kvSecretPath: 'f' }),
		state: (s) => (s.kv['kv/']['f/two'] = { z: 'w' }),
	},
	{
		name: 'folder without a manual mount',
		settings: (url) => manual(url, { kvSecretPath: 'app/' }),
	},
	{ name: 'version without a manual mount', settings: (url) => manual(url, { kvVersion: '1' }) },
	{
		name: 'manual mount that does not exist',
		settings: (url) => manual(url, { kvMountPath: 'missing/', kvVersion: '2' }),
	},
	{
		name: 'manual mount 403',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: (s) => s.forbidden.push('secret/metadata/'),
	},
	{
		name: 'manual mount 401',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: fail('secret/metadata/', 401),
	},
	{
		name: 'manual mount 404 with errors',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: fail('secret/metadata/', 404, { errors: ['not found'] }),
	},
	{
		name: 'manual mount 404 without a body',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: fail('secret/metadata/', 404, ''),
	},
	{
		name: 'manual mount 404 with a text body',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: fail('secret/metadata/', 404, 'not json'),
	},
	{
		name: 'manual mount 500',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: fail('secret/metadata/', 500),
	},
	{
		name: 'manual mount 503',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: fail('secret/metadata/', 503),
	},
	{
		name: 'mount root 404 without errors',
		settings: token,
		state: fail('secret/metadata/', 404, { errors: [] }),
	},
	{
		name: 'mount root 404 with errors',
		settings: token,
		state: fail('secret/metadata/', 404, { errors: ['not found'] }),
	},
	{ name: 'KV v1 mount root 404', settings: token, state: fail('kv/', 404, '') },
	{
		name: 'list of a folder 403',
		settings: token,
		state: (s) => s.forbidden.push('secret/metadata/app/'),
	},
	{
		name: 'read of a secret 403',
		settings: token,
		state: (s) => s.forbidden.push('secret/data/top'),
	},
	{ name: 'read of a secret 500', settings: token, state: fail('secret/data/top', 500) },
	{
		name: 'nested folders and typed values',
		settings: token,
		state: (s) => {
			s.kv['secret/'] = {
				'a/b/c/d': { deep: 'x' },
				'a/b/e': { n: 5, t: true, o: { inner: 'v' }, z: null, arr: [1, 2] },
				'a/f': { s: 'str' },
				'dot.name': { 'key.dot': 'v1', 'with space': 'v2' },
			};
		},
	},
	{ name: 'mount without secrets', settings: token, state: (s) => (s.kv['secret/'] = {}) },
	{
		name: 'folder whose secrets are all refused',
		settings: token,
		state: (s) => s.forbidden.push('secret/data/app/db'),
	},
	{
		name: 'mount whose secrets are all refused',
		settings: token,
		state: (s) => s.forbidden.push('kv/one'),
	},
	{
		name: 'manual mount with nested folders',
		settings: (url) => manual(url, { kvMountPath: 'secret/', kvVersion: '2' }),
		state: (s) => (s.kv['secret/'] = { 'a/b/c': { k: 'v' }, 'a/d': { k: 'w' }, top: { k: 'x' } }),
	},
	{
		name: 'manual KV v1 mount with nested folders',
		settings: (url) => manual(url, { kvMountPath: 'kv/', kvVersion: '1', kvSecretPath: 'f/' }),
		state: (s) => (s.kv['kv/'] = { 'f/g/h': { k: 'v' }, 'f/i': { k: 'w' } }),
	},
	{
		name: 'manual mount with a nested folder',
		settings: (url) =>
			manual(url, { kvMountPath: 'secret/', kvVersion: '2', kvSecretPath: 'a/b/' }),
		state: (s) =>
			(s.kv['secret/'] = { 'a/b/x': { k: 'v' }, 'a/b/c/y': { k: 'w' }, 'a/z': { k: 'no' } }),
	},
];

describe('Vault provider', () => {
	test('form fields', () => {
		const provider = new (Container.get(ExternalSecretsProviders).providers.vault)();
		expect({
			name: provider.name,
			displayName: provider.displayName,
			properties: provider.properties,
		}).toMatchSnapshot();
	});

	test.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
		const state = baseState();
		c.state?.(state);
		const vault = await startFakeVault(state);
		try {
			const result = await drive(newProvider(), {
				settings: c.settings(vault.url),
				step: vault.step,
				read: ['secret', 'kv', 'noversion', 'generic'],
			});
			expect({ result, requests: sortedByStep(vault.requests) }).toMatchSnapshot();
		} finally {
			await vault.close();
		}
	});

	test('request headers', async () => {
		const vault = await startFakeVault(baseState());
		await drive(newProvider(), {
			settings: { ...userpass(vault.url), namespace: 'team' },
			step: vault.step,
		});
		await vault.close();
		const sorted = [...vault.headers].sort((a, b) =>
			JSON.stringify(a).localeCompare(JSON.stringify(b)),
		);
		expect(sorted).toMatchSnapshot();
	});

	test('repeated updates', async () => {
		const vault = await startFakeVault(baseState());
		const provider = newProvider();
		const record: Record<string, unknown> = {};
		await provider.init({ connected: true, connectedAt: null, settings: token(vault.url) });
		await provider.connect();
		await provider.update();
		record.first = provider.getSecretNames();
		vault.state.kv['secret/'] = { other: { b: '2' } };
		await provider.update();
		record['after a change'] = provider.getSecretNames();
		vault.state.failing['sys/mounts'] = 500;
		record['failing update'] = await outcome(async () => await provider.update());
		record['after the failing update'] = {
			names: provider.getSecretNames(),
			state: provider.state,
			secret: provider.getSecret('secret'),
		};
		delete vault.state.failing['sys/mounts'];
		vault.state.forbidden.push('secret/metadata/');
		await provider.update();
		record['after a refused mount'] = { names: provider.getSecretNames(), state: provider.state };
		await provider.disconnect();
		await vault.close();
		expect(record).toMatchSnapshot();
	});

	test('calls before connect', async () => {
		const vault = await startFakeVault(baseState());
		const record: Record<string, unknown> = {};
		for (const [label, settings] of [
			['token', token(vault.url)],
			['userpass', userpass(vault.url)],
		] as const) {
			vault.requests.length = 0;
			const provider = newProvider();
			await provider.init({ connected: true, connectedAt: null, settings });
			vault.step('update');
			const update = await outcome(async () => await provider.update());
			const names = provider.getSecretNames();
			vault.step('test');
			const testResult = await outcome(async () => await provider.test());
			record[label] = {
				update,
				names,
				test: testResult,
				state: provider.state,
				requests: [...vault.requests],
			};
			await provider.disconnect();
		}
		await vault.close();
		expect(record).toMatchSnapshot();
	});

	test('a second connect', async () => {
		const vault = await startFakeVault(baseState());
		const provider = newProvider();
		await provider.init({ connected: true, connectedAt: null, settings: userpass(vault.url) });
		vault.step('connect 1');
		await provider.connect();
		vault.step('connect 2');
		await provider.connect();
		await provider.disconnect();
		await vault.close();
		expect({ state: provider.state, requests: sortedByStep(vault.requests) }).toMatchSnapshot();
	});

	test('network errors and invalid URLs', async () => {
		const down = await startFakeVault(baseState());
		const downUrl = down.url;
		await down.close();
		const record: Record<string, unknown> = {};
		for (const [label, url] of [
			['connection refused', `${downUrl}/v1/`],
			['invalid URL', 'not a url'],
			['empty URL', ''],
		] as const) {
			const result = await drive(newProvider(), {
				settings: { url, authMethod: 'token', token: 'tok-1' },
			});
			record[label] = {
				init: result.init,
				connect: result['state after connect'],
				test: result.test,
			};
		}
		expect(record).toMatchSnapshot();
	});

	describe('token renewal', () => {
		const start = new Date('2026-01-01T00:00:00.000Z');

		beforeEach(() => {
			vi.useFakeTimers({
				toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
				now: start,
			});
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		/** Move the fake clock and wait for the requests that it starts. */
		async function advance(vault: FakeVault, label: string, ms: number) {
			vault.step(label);
			await vi.advanceTimersByTimeAsync(ms);
			await settle();
		}

		async function connected(state: FakeVaultState, settings: (url: string) => IDataObject) {
			const vault = await startFakeVault(state);
			const provider = newProvider();
			await provider.init({ connected: true, connectedAt: null, settings: settings(vault.url) });
			vault.step('connect');
			await provider.connect();
			await settle();
			return { vault, provider };
		}

		test('a renewable token with a TTL of 6 seconds', async () => {
			const state = baseState();
			state.tokens['tok-1'] = { ttl: 6, renewable: true };
			const { vault, provider } = await connected(state, token);
			await advance(vault, 'after 2999 ms', 2999);
			await advance(vault, 'after 3000 ms', 1);
			await advance(vault, 'after 5999 ms', 2999);
			await advance(vault, 'after 6000 ms', 1);
			await provider.disconnect();
			await advance(vault, 'after disconnect', 10_000);
			await vault.close();
			const renewalHeaders = vault.headers.find(({ request }) => request.includes('renew-self'));
			expect({ state: provider.state, requests: vault.requests, renewalHeaders }).toMatchSnapshot();
		});

		test('a token that is not renewable', async () => {
			const state = baseState();
			state.tokens['tok-1'] = { ttl: 6, renewable: false };
			const { vault, provider } = await connected(state, token);
			await advance(vault, 'after 10 s', 10_000);
			await provider.disconnect();
			await vault.close();
			expect({ state: provider.state, requests: vault.requests }).toMatchSnapshot();
		});

		test('a renewable token without an expiry time', async () => {
			const state = baseState();
			state.tokens['tok-1'] = { ttl: 6, renewable: true };
			state.noExpireTime = true;
			const { vault, provider } = await connected(state, token);
			await advance(vault, 'after 10 s', 10_000);
			await provider.disconnect();
			await vault.close();
			expect({ state: provider.state, requests: vault.requests }).toMatchSnapshot();
		});

		test('a renewal that Vault refuses, with token auth', async () => {
			const state = baseState();
			state.tokens['tok-1'] = { ttl: 6, renewable: true };
			state.forbidden.push('auth/token/renew-self');
			const { vault, provider } = await connected(state, token);
			await advance(vault, 'after 3000 ms', 3000);
			const afterFirst = provider.state;
			await advance(vault, 'after 6000 ms', 3000);
			await provider.disconnect();
			await vault.close();
			expect({ afterFirst, state: provider.state, requests: vault.requests }).toMatchSnapshot();
		});

		test('a renewal that Vault refuses, with a userpass login', async () => {
			const state = baseState();
			state.tokens['tok-up'] = { ttl: 6, renewable: true };
			state.forbidden.push('auth/token/renew-self');
			const { vault, provider } = await connected(state, userpass);
			await advance(vault, 'after 3000 ms', 3000);
			await provider.disconnect();
			await vault.close();
			expect({ state: provider.state, requests: vault.requests }).toMatchSnapshot();
		});

		test('a renewal that Vault refuses, and a new connect that fails', async () => {
			const state = baseState();
			state.tokens['tok-1'] = { ttl: 6, renewable: true };
			state.forbidden.push('auth/token/renew-self');
			const { vault, provider } = await connected(state, token);
			vault.state.forbidden.push('sys/mounts');
			await advance(vault, 'after 3000 ms', 3000);
			const afterFirst = provider.state;
			await advance(vault, 'after 10 s', 7000);
			await provider.disconnect();
			await vault.close();
			expect({ afterFirst, state: provider.state, requests: vault.requests }).toMatchSnapshot();
		});

		test('a second connect with a renewable token', async () => {
			const state = baseState();
			state.tokens['tok-1'] = { ttl: 6, renewable: true };
			const { vault, provider } = await connected(state, token);
			await advance(vault, 'after 1000 ms', 1000);
			vault.step('connect again');
			await provider.connect();
			await settle();
			await advance(vault, 'after 3000 ms', 2000);
			await advance(vault, 'after 4000 ms', 1000);
			await advance(vault, 'after 7000 ms', 3000);
			await provider.disconnect();
			await vault.close();
			expect({ state: provider.state, requests: vault.requests }).toMatchSnapshot();
		});

		test('a renewal that fails with a server error', async () => {
			const state = baseState();
			state.tokens['tok-1'] = { ttl: 6, renewable: true };
			state.failing['auth/token/renew-self'] = 500;
			const { vault, provider } = await connected(state, token);
			await advance(vault, 'after 3000 ms', 3000);
			await provider.disconnect();
			await vault.close();
			expect({ state: provider.state, requests: vault.requests }).toMatchSnapshot();
		});
	});

	test('timeouts of a slow Vault', async () => {
		const state = baseState();
		state.delayMs = 3500;
		const vault = await startFakeVault(state);
		const provider = newProvider();
		await provider.init({ connected: true, connectedAt: null, settings: token(vault.url) });
		const time = (from: number) => `${Math.round((Date.now() - from) / 500) * 500} ms`;
		let from = Date.now();
		const connect = await outcome(async () => await provider.connect());
		const connectTime = time(from);
		const afterConnect = provider.state;
		from = Date.now();
		const update = await outcome(async () => await provider.update());
		const updateTime = time(from);
		from = Date.now();
		const testResult = await outcome(async () => await provider.test());
		const testTime = time(from);
		await provider.disconnect();
		await vault.close();
		expect({
			connect,
			connectTime,
			afterConnect,
			update,
			updateTime,
			test: testResult,
			testTime,
		}).toMatchSnapshot();
	}, 20_000);
});
