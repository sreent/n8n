// The behaviour of the 1Password provider against a fake 1Password Connect server: the form
// fields, the server URL, the access token, reading vaults, items and fields, the connection
// test, and the errors. For each case, the snapshot records the result and the state of each
// step, and the requests that the Connect server got. The snapshot records what the provider
// does, so a change in behaviour shows up as a snapshot diff.
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

import { drive, outcome, type DrivenProvider } from './fakes/drive';
import {
	emptyOnePasswordState,
	startFakeOnePassword,
	type FakeOnePasswordState,
} from './fakes/fake-one-password';

const newProvider = () =>
	new (Container.get(
		ExternalSecretsProviders,
	).providers.onePassword)() as unknown as DrivenProvider;

function baseState(): FakeOnePasswordState {
	return {
		...emptyOnePasswordState(),
		vaults: [
			{
				id: 'v1',
				name: 'Private',
				items: [
					{
						id: 'i1',
						title: 'Fields',
						fields: [
							{ id: 'username', label: 'username', value: 'admin', purpose: 'USERNAME' },
							{ id: 'empty', label: 'empty', value: '' },
							{ id: 'novalue', label: 'novalue' },
							{ id: 'nolabel', value: 'by id' },
							{ id: 'emptylabel', label: '', value: 'empty label' },
							{ id: 'dup1', label: 'dup', value: 'first' },
							{ id: 'dup2', label: 'dup', value: 'second' },
							{ id: 'num', label: 'num', value: 5 },
							{ id: 'zero', label: 'zero', value: 0 },
							{ id: 'false', label: 'false', value: false },
							{ id: 'null', label: 'null', value: null },
							{ id: 'space', label: 'space', value: ' ' },
							{
								id: 'sec',
								label: 'in section',
								value: 's',
								section: { id: 'sec1', label: 'Section' },
							},
							{ id: 'dotted', label: 'a.b', value: 'dot' },
						],
					},
					{ id: 'i2', title: 'No fields' },
					{ id: 'i3', title: 'Empty fields', fields: [] },
					{ id: 'i4', title: 'Only empty values', fields: [{ id: 'f', label: 'x', value: '' }] },
					{ id: 'i5', title: 'title.with.dots', fields: [{ id: 'f', label: 'x', value: 'y' }] },
					{
						id: 'i6',
						title: 'Same title',
						fields: [{ id: 'f', label: 'from', value: 'v1 first' }],
					},
					{
						id: 'i7',
						title: 'Same title',
						fields: [{ id: 'f', label: 'from', value: 'v1 second' }],
					},
				],
			},
			{
				id: 'v2',
				name: 'Shared',
				items: [{ id: 'j1', title: 'Fields', fields: [{ id: 'f', label: 'from', value: 'v2' }] }],
			},
		],
	};
}

const settings = (url: string): IDataObject => ({ serverUrl: url, accessToken: 'op-token' });

interface Case {
	name: string;
	settings: (url: string) => IDataObject;
	state?: (state: FakeOnePasswordState) => void;
}

const fail = (path: string, status: number) => (state: FakeOnePasswordState) => {
	state.failing[path] = status;
};

const cases: Case[] = [
	{ name: 'vaults, items and fields', settings },
	{ name: 'one vault', settings, state: (s) => (s.vaults = s.vaults.slice(0, 1)) },
	{
		name: 'server URL with a trailing slash',
		settings: (url) => ({ ...settings(url), serverUrl: `${url}/` }),
	},
	{
		name: 'server URL with a path',
		settings: (url) => ({ ...settings(url), serverUrl: `${url}/base` }),
	},
	{ name: 'wrong access token', settings: (url) => ({ ...settings(url), accessToken: 'nope' }) },
	{ name: 'empty access token', settings: (url) => ({ ...settings(url), accessToken: '' }) },
	{ name: 'vaults 403', settings, state: fail('/v1/vaults', 403) },
	{ name: 'vaults 500', settings, state: fail('/v1/vaults', 500) },
	{ name: 'items 500', settings, state: fail('/v1/vaults/v1/items', 500) },
	{ name: 'item 404', settings, state: fail('/v1/vaults/v1/items/i1', 404) },
	{ name: 'item 500', settings, state: fail('/v1/vaults/v2/items/j1', 500) },
	{ name: 'no vaults', settings, state: (s) => (s.vaults = []) },
	{
		name: 'vault without items',
		settings,
		state: (s) => (s.vaults = [{ id: 'v9', name: 'Empty', items: [] }]),
	},
];

describe('1Password provider', () => {
	test('form fields', () => {
		const provider = new (Container.get(ExternalSecretsProviders).providers.onePassword)();
		expect({
			name: provider.name,
			displayName: provider.displayName,
			properties: provider.properties,
		}).toMatchSnapshot();
	});

	test.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
		const state = baseState();
		c.state?.(state);
		const connect = await startFakeOnePassword(state);
		try {
			const result = await drive(newProvider(), {
				settings: c.settings(connect.url),
				step: connect.step,
				read: [
					'Fields',
					'No fields',
					'Empty fields',
					'Only empty values',
					'title.with.dots',
					'Same title',
				],
			});
			expect({ result, requests: connect.requests }).toMatchSnapshot();
		} finally {
			await connect.close();
		}
	});

	test('request headers', async () => {
		const connect = await startFakeOnePassword(baseState());
		await drive(newProvider(), { settings: settings(connect.url), step: connect.step });
		await connect.close();
		expect(connect.headers).toMatchSnapshot();
	});

	test('repeated updates, and calls before connect', async () => {
		const connect = await startFakeOnePassword(baseState());
		const provider = newProvider();
		const record: Record<string, unknown> = {};
		await provider.init({ connected: true, connectedAt: null, settings: settings(connect.url) });
		connect.step('update before connect');
		record['update before connect'] = await outcome(async () => await provider.update());
		record['names before connect'] = provider.getSecretNames();
		connect.step('test before connect');
		record['test before connect'] = await outcome(async () => await provider.test());
		connect.step('connect');
		await provider.connect();
		connect.state.vaults = [
			{
				id: 'v3',
				name: 'Other',
				items: [{ id: 'k1', title: 'Other', fields: [{ id: 'f', label: 'k', value: 'v' }] }],
			},
		];
		connect.step('update');
		await provider.update();
		record['after a change'] = provider.getSecretNames();
		connect.state.failing['/v1/vaults'] = 500;
		record['failing update'] = await outcome(async () => await provider.update());
		record['after the failing update'] = {
			names: provider.getSecretNames(),
			state: provider.state,
		};
		delete connect.state.failing['/v1/vaults'];
		connect.step('connect again');
		await provider.connect();
		await provider.disconnect();
		await connect.close();
		expect({ ...record, requests: connect.requests }).toMatchSnapshot();
	});

	test('network errors and invalid URLs', async () => {
		const down = await startFakeOnePassword(baseState());
		const downUrl = down.url;
		await down.close();
		const record: Record<string, unknown> = {};
		for (const [label, url] of [
			['connection refused', downUrl],
			['invalid URL', 'not a url'],
			['empty URL', ''],
		] as const) {
			const result = await drive(newProvider(), {
				settings: { serverUrl: url, accessToken: 'op-token' },
			});
			record[label] = {
				init: result.init,
				connect: result['state after connect'],
				update: result.update,
				test: result.test,
			};
		}
		expect(record).toMatchSnapshot();
	});

	test('a slow Connect server', async () => {
		const state = baseState();
		state.delayMs = 2500;
		const connect = await startFakeOnePassword(state);
		const provider = newProvider();
		await provider.init({ connected: true, connectedAt: null, settings: settings(connect.url) });
		const time = (from: number) => `${Math.round((Date.now() - from) / 500) * 500} ms`;
		let from = Date.now();
		const connectResult = await outcome(async () => await provider.connect());
		const connectTime = time(from);
		const afterConnect = provider.state;
		from = Date.now();
		const testResult = await outcome(async () => await provider.test());
		const testTime = time(from);
		await provider.disconnect();
		await connect.close();
		expect({
			connect: connectResult,
			connectTime,
			afterConnect,
			test: testResult,
			testTime,
		}).toMatchSnapshot();
	}, 20_000);
});
