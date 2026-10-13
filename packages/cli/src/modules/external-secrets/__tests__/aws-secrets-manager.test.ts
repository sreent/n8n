// The behaviour of the AWS Secrets Manager provider against a fake Secrets Manager endpoint: the
// form fields, the IAM user and auto-detect credentials, the pages of ListSecrets, the batches of
// BatchGetSecretValue, the connection test, the errors and the retries of the AWS SDK, and the
// transport (the proxy of the environment, the SSRF policy). The AWS SDK is real; the environment
// variable AWS_ENDPOINT_URL_SECRETS_MANAGER points it at the fake. For each case, the snapshot
// records the result and the state of each step, and the requests that the endpoint got. The
// snapshot records what the provider does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
vi.hoisted(() => {
	// The connect timeout is longer than the retries of the SDK after a throttled request (at most
	// 1.5 s), so that all requests of a connect show up in the connect step.
	process.env.N8N_EXTERNAL_SECRETS_CONNECT_TIMEOUT = '3';
	process.env.N8N_EXTERNAL_SECRETS_REFRESH_TIMEOUT = '2';
	// The credentials that the auto-detect method finds in the environment.
	process.env.AWS_ACCESS_KEY_ID = 'AKIDENV';
	process.env.AWS_SECRET_ACCESS_KEY = 'env-secret';
	process.env.AWS_SESSION_TOKEN = 'env-session';
});

import { SsrfProtectionConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';
import net from 'node:net';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point this import at `@/modules/external-secrets.ee/external-secrets-providers.ee`.
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';

import { drive, outcome, sortedByStep, type DrivenProvider } from './fakes/drive';
import { emptyAwsState, startFakeAws, type FakeAws, type FakeAwsState } from './fakes/fake-aws';

const newProvider = () =>
	new (Container.get(
		ExternalSecretsProviders,
	).providers.awsSecretsManager)() as unknown as DrivenProvider;

function baseState(): FakeAwsState {
	return {
		...emptyAwsState(),
		accessKeys: ['AKIDTEST', 'AKIDENV'],
		secrets: [
			{ Name: 'db', SecretString: 'pw' },
			{ Name: 'json', SecretString: '{"user":"u","pass":"p","n":5}' },
			{ Name: 'bin', SecretBinary: Buffer.from('binary').toString('base64') },
			{ Name: 'path/with/slashes', SecretString: 'v' },
			{ Name: 'dot.name', SecretString: 'd' },
			{ Name: 'blank', SecretString: '' },
			{ Name: 'novalue' },
		],
	};
}

const iamUser: IDataObject = {
	region: 'eu-west-3',
	authMethod: 'iamUser',
	accessKeyId: 'AKIDTEST',
	secretAccessKey: 'secret',
};

/** The fake endpoint for the next case. */
async function startEndpoint(state: FakeAwsState) {
	const aws = await startFakeAws(state);
	process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER = aws.url;
	return aws;
}

/** Requests with a short list of the secret IDs of each batch. */
const requestLines = (aws: FakeAws) =>
	sortedByStep(
		aws.requests.map((line) =>
			line.replace(/"SecretIdList":\[([^\]]*)\]/, (_, ids: string) => {
				const list = ids === '' ? [] : ids.split(',');
				return `"SecretIdList":${list.length} IDs from ${list[0] ?? '-'} to ${list[list.length - 1] ?? '-'}`;
			}),
		),
	);

interface Case {
	name: string;
	settings: IDataObject;
	state?: (state: FakeAwsState) => void;
}

const fail =
	(operation: string, status: number, type: string, message: string) => (state: FakeAwsState) => {
		state.failing[operation] = { status, type, message };
	};

const cases: Case[] = [
	{ name: 'IAM user', settings: iamUser },
	{ name: 'auto detect', settings: { region: 'eu-west-3', authMethod: 'autoDetect' } },
	{
		name: 'auto detect with keys in the settings',
		settings: { ...iamUser, authMethod: 'autoDetect' },
	},
	{
		name: 'many secrets',
		settings: iamUser,
		state: (s) => {
			s.secrets = Array.from({ length: 45 }, (_, i) => ({
				Name: `s${String(i).padStart(3, '0')}`,
				SecretString: `v${i}`,
			}));
			s.listPageSize = 20;
		},
	},
	{ name: 'wrong access key', settings: { ...iamUser, accessKeyId: 'AKIDBAD' } },
	{ name: 'empty access key', settings: { ...iamUser, accessKeyId: '' } },
	{ name: 'empty secret key', settings: { ...iamUser, secretAccessKey: '' } },
	{ name: 'empty region', settings: { ...iamUser, region: '' } },
	{ name: 'other region', settings: { ...iamUser, region: 'us-east-1' } },
	{ name: 'unknown auth method', settings: { ...iamUser, authMethod: 'role' } },
	{
		name: 'list access denied',
		settings: iamUser,
		state: fail(
			'ListSecrets',
			400,
			'AccessDeniedException',
			'User is not authorized to perform: secretsmanager:ListSecrets',
		),
	},
	{
		name: 'batch access denied',
		settings: iamUser,
		state: fail('BatchGetSecretValue', 400, 'AccessDeniedException', 'not authorized'),
	},
	{
		name: 'errors for some secrets in a batch',
		settings: iamUser,
		state: (s) => s.batchErrors.push('db'),
	},
	{
		name: 'list server error',
		settings: iamUser,
		state: fail('ListSecrets', 500, 'InternalServiceError', 'boom'),
	},
	{
		name: 'list throttled',
		settings: iamUser,
		state: fail('ListSecrets', 400, 'ThrottlingException', 'Rate exceeded'),
	},
	{
		name: 'batch server error',
		settings: iamUser,
		state: fail('BatchGetSecretValue', 500, 'InternalServiceError', 'boom'),
	},
	{ name: 'no secrets', settings: iamUser, state: (s) => (s.secrets = []) },
];

describe('AWS Secrets Manager provider', () => {
	afterEach(() => {
		Container.get(SsrfProtectionConfig).enabled = false;
		for (const key of ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[key];
	});

	test('form fields', () => {
		const provider = new (Container.get(ExternalSecretsProviders).providers.awsSecretsManager)();
		expect({
			name: provider.name,
			displayName: provider.displayName,
			properties: provider.properties,
		}).toMatchSnapshot();
	});

	test.each(cases.map((c) => [c.name, c] as const))(
		'%s',
		async (_name, c) => {
			const state = baseState();
			c.state?.(state);
			const aws = await startEndpoint(state);
			try {
				const result = await drive(newProvider(), {
					settings: c.settings,
					step: aws.step,
					read: ['db', 'json', 'bin', 'path/with/slashes', 'dot.name', 'blank', 'novalue', 'nope'],
				});
				expect({ result, requests: requestLines(aws) }).toMatchSnapshot();
			} finally {
				await aws.close();
			}
		},
		30_000,
	);

	test('calls before connect, repeated updates, and calls after disconnect', async () => {
		const aws = await startEndpoint(baseState());
		const provider = newProvider();
		const record: Record<string, unknown> = {};
		await provider.init({ connected: true, connectedAt: null, settings: iamUser });
		aws.step('update before connect');
		record['update before connect'] = await outcome(async () => await provider.update());
		record['names before connect'] = provider.getSecretNames();
		aws.step('test before connect');
		record['test before connect'] = await outcome(async () => await provider.test());
		aws.step('connect');
		await provider.connect();
		aws.state.secrets = [{ Name: 'new', SecretString: 'n' }];
		aws.step('update');
		await provider.update();
		record['after a change'] = provider.getSecretNames();
		aws.state.failing.ListSecrets = { status: 400, type: 'AccessDeniedException', message: 'no' };
		record['failing update'] = await outcome(async () => await provider.update());
		record['after the failing update'] = {
			names: provider.getSecretNames(),
			state: provider.state,
		};
		delete aws.state.failing.ListSecrets;
		aws.step('disconnect');
		await provider.disconnect();
		aws.step('test after disconnect');
		record['test after disconnect'] = await outcome(async () => await provider.test());
		await aws.close();
		expect({ ...record, requests: requestLines(aws) }).toMatchSnapshot();
	});

	test('a refused connection', async () => {
		const aws = await startEndpoint(baseState());
		await aws.close();
		const result = await drive(newProvider(), { settings: iamUser });
		expect({
			connect: result['state after connect'],
			update: result.update,
			test: result.test,
		}).toMatchSnapshot();
	}, 30_000);

	test('a slow endpoint', async () => {
		const state = baseState();
		state.secrets = [{ Name: 'db', SecretString: 'pw' }];
		state.delayMs = 4000;
		const aws = await startEndpoint(state);
		const provider = newProvider();
		await provider.init({ connected: true, connectedAt: null, settings: iamUser });
		const time = (from: number) => `${Math.round((Date.now() - from) / 500) * 500} ms`;
		let from = Date.now();
		const connect = await outcome(async () => await provider.connect());
		const connectTime = time(from);
		const afterConnect = provider.state;
		from = Date.now();
		const update = await outcome(async () => await provider.update());
		const updateTime = time(from);
		const names = provider.getSecretNames();
		await provider.disconnect();
		await aws.close();
		expect({ connect, connectTime, afterConnect, update, updateTime, names }).toMatchSnapshot();
	}, 60_000);

	test('the transport: SSRF protection and a proxy from the environment', async () => {
		const record: Record<string, unknown> = {};

		Container.get(SsrfProtectionConfig).enabled = true;
		let aws = await startEndpoint(baseState());
		const guarded = await drive(newProvider(), { settings: iamUser, skipUpdate: true });
		record['with SSRF protection'] = {
			connect: guarded['state after connect'],
			test: guarded.test,
			requests: aws.requests.length,
		};
		await aws.close();

		// A host name that resolves to a loopback address, which the default SSRF policy blocks.
		aws = await startEndpoint(baseState());
		process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER = aws.url.replace('127.0.0.1', 'localhost');
		const byName = await drive(newProvider(), { settings: iamUser, skipUpdate: true });
		record['with SSRF protection and a loopback host name'] = {
			connect: byName['state after connect'],
			test: byName.test,
			requests: aws.requests.length,
		};
		await aws.close();
		Container.get(SsrfProtectionConfig).enabled = false;

		const proxyRequests: string[] = [];
		const proxy = net.createServer((socket) => {
			socket.once('data', (chunk: Buffer) => {
				proxyRequests.push(chunk.toString('latin1').split('\r\n')[0]);
				socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
		const proxyPort = (proxy.address() as net.AddressInfo).port;
		aws = await startEndpoint(baseState());
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
		process.env.http_proxy = process.env.HTTP_PROXY;
		process.env.NO_PROXY = '';
		process.env.no_proxy = '';
		const proxied = await drive(newProvider(), { settings: iamUser, skipUpdate: true });
		record['with a proxy from the environment'] = {
			connect: proxied['state after connect'],
			test: proxied.test,
			'requests at the endpoint': aws.requests.length,
			'requests at the proxy': [...new Set(proxyRequests)].map((line) =>
				line.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>'),
			),
		};
		await aws.close();
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
		expect(record).toMatchSnapshot();
	}, 60_000);
});
