// The behaviour of the GCP Secrets Manager provider against a fake of the GCP SDK: the form
// fields, the service account key, the client that the provider makes, the secrets that it reads,
// the connection test, and the errors. The fake replaces `SecretManagerServiceClient` and logs
// each construction and each call. For each case, the snapshot records the result and the state
// of each step, and that log. The snapshot records what the provider does, so a change in
// behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
const gcp = vi.hoisted(() => {
	interface FakeSecret {
		name: string;
		value?: string | Uint8Array;
		noVersion?: boolean;
	}
	interface FakeError {
		code: number;
		message: string;
	}
	const log: unknown[][] = [];
	const step = { label: '' };
	const state = {
		secrets: [] as FakeSecret[],
		listError: undefined as FakeError | undefined,
		accessErrors: {} as Record<string, FakeError>,
		initializeError: undefined as FakeError | undefined,
		delayMs: 0,
	};
	/** An error as the GCP SDK throws it (a gRPC status code and details). */
	const grpcError = ({ code, message }: FakeError) =>
		Object.assign(new Error(`${code} ${message}`), { code, details: message });
	/** Log the use of members that the fake does not have. */
	const watch = <T extends object>(target: T, label: string): T =>
		new Proxy(target, {
			get(object, property, receiver) {
				if (typeof property === 'string' && !(property in object) && property !== 'then') {
					log.push([step.label, `${label}.${property} (not in the fake)`]);
				}
				return Reflect.get(object, property, receiver) as unknown;
			},
		});
	return { log, step, state, grpcError, watch };
});

vi.mock('@google-cloud/secret-manager', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class SecretManagerServiceClient {
		constructor(...args: unknown[]) {
			gcp.log.push([gcp.step.label, 'new SecretManagerServiceClient', ...args]);
			return gcp.watch(this, 'SecretManagerServiceClient');
		}

		async initialize() {
			gcp.log.push([gcp.step.label, 'initialize']);
			if (gcp.state.initializeError) throw gcp.grpcError(gcp.state.initializeError);
			return {};
		}

		async listSecrets(request: { parent: string }, ...args: unknown[]) {
			gcp.log.push([gcp.step.label, 'listSecrets', request, ...args]);
			if (gcp.state.listError) throw gcp.grpcError(gcp.state.listError);
			// The API names the listed secrets with the number of the project, not with its ID.
			const secrets = gcp.state.secrets.map((secret) => ({
				name: `projects/123456789012/secrets/${secret.name}`,
				replication: { automatic: {} },
			}));
			return [secrets, null, {}];
		}

		async accessSecretVersion(request: { name: string }, ...args: unknown[]) {
			gcp.log.push([gcp.step.label, 'accessSecretVersion', request, ...args]);
			if (gcp.state.delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, gcp.state.delayMs));
			}
			const shortName = request.name.split('/')[3];
			const error = gcp.state.accessErrors[shortName];
			if (error) throw gcp.grpcError(error);
			const secret = gcp.state.secrets.find((candidate) => candidate.name === shortName);
			if (!secret || secret.noVersion) {
				throw gcp.grpcError({ code: 5, message: 'NOT_FOUND: Secret Version not found' });
			}
			const data = typeof secret.value === 'string' ? Buffer.from(secret.value) : secret.value;
			return [
				{ name: request.name.replace(/latest$/, '1'), payload: data === undefined ? {} : { data } },
				null,
				{},
			];
		}

		async close() {
			gcp.log.push([gcp.step.label, 'close']);
		}
	}
	return { ...actual, SecretManagerServiceClient };
});

import { Container } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';

// The code under test. To record the snapshot against the original files, point this import at
// `@/modules/external-secrets.ee/external-secrets-providers.ee`.
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';

import { drive, outcome, type DrivenProvider } from './fakes/drive';

const newProvider = () =>
	new (Container.get(
		ExternalSecretsProviders,
	).providers.gcpSecretsManager)() as unknown as DrivenProvider;

const key = {
	type: 'service_account',
	project_id: 'proj-1',
	private_key_id: 'key-1',
	private_key: '-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n',
	client_email: 'reader@proj-1.iam.gserviceaccount.com',
	client_id: '123',
};
const settings: IDataObject = { serviceAccountKey: JSON.stringify(key) };

beforeEach(() => {
	gcp.log.length = 0;
	gcp.step.label = '';
	gcp.state.secrets = [
		{ name: 'db-password', value: 'pw' },
		{ name: 'json', value: '{"a":1}' },
		{ name: 'empty', value: '' },
		{ name: 'zero', value: '0' },
		{ name: 'space', value: ' ' },
		{ name: 'noversion', noVersion: true },
		{ name: 'bytes', value: new Uint8Array([104, 105]) },
	];
	gcp.state.listError = undefined;
	gcp.state.accessErrors = {};
	gcp.state.initializeError = undefined;
	gcp.state.delayMs = 0;
});

const step = (label: string) => {
	gcp.step.label = label;
};

interface Case {
	name: string;
	settings: IDataObject;
	state?: () => void;
}

const cases: Case[] = [
	{ name: 'service account key', settings },
	{ name: 'key as an object', settings: { serviceAccountKey: key } },
	{
		name: 'key text with spaces around it',
		settings: { serviceAccountKey: `  ${JSON.stringify(key)}\n` },
	},
	{
		name: 'spaces around the email and the private key',
		settings: {
			serviceAccountKey: JSON.stringify({
				...key,
				client_email: ' reader@x ',
				private_key: `  ${key.private_key}  `,
			}),
		},
	},
	{
		name: 'escaped line breaks in the private key',
		settings: {
			serviceAccountKey: JSON.stringify({
				...key,
				private_key: '-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----\\n',
			}),
		},
	},
	{
		name: 'key without a project',
		settings: { serviceAccountKey: JSON.stringify({ ...key, project_id: undefined }) },
	},
	{
		name: 'project with spaces',
		settings: { serviceAccountKey: JSON.stringify({ ...key, project_id: ' proj-1 ' }) },
	},
	{
		name: 'key without an email',
		settings: { serviceAccountKey: JSON.stringify({ ...key, client_email: '' }) },
	},
	{
		name: 'key without a private key',
		settings: { serviceAccountKey: JSON.stringify({ ...key, private_key: undefined }) },
	},
	{ name: 'invalid JSON', settings: { serviceAccountKey: '{not json' } },
	{ name: 'empty key', settings: { serviceAccountKey: '' } },
	{
		name: 'list error',
		settings,
		state: () => {
			gcp.state.listError = {
				code: 7,
				message: 'PERMISSION_DENIED: Permission denied on resource project proj-1.',
			};
		},
	},
	{
		name: 'read error for one secret',
		settings,
		state: () => {
			gcp.state.accessErrors['db-password'] = { code: 7, message: 'PERMISSION_DENIED: no access' };
		},
	},
	{
		name: 'initialize error',
		settings,
		state: () => {
			gcp.state.initializeError = { code: 16, message: 'UNAUTHENTICATED: invalid key' };
		},
	},
	{
		name: 'no secrets',
		settings,
		state: () => {
			gcp.state.secrets = [];
		},
	},
];

describe('GCP Secrets Manager provider', () => {
	test('form fields', () => {
		const provider = new (Container.get(ExternalSecretsProviders).providers.gcpSecretsManager)();
		expect({
			name: provider.name,
			displayName: provider.displayName,
			properties: provider.properties,
		}).toMatchSnapshot();
	});

	test.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
		c.state?.();
		const result = await drive(newProvider(), {
			settings: c.settings,
			step,
			read: ['db-password', 'json', 'empty', 'zero', 'space', 'noversion', 'bytes', 'nope'],
		});
		expect({ result, log: gcp.log }).toMatchSnapshot();
	});

	test('calls before connect, repeated updates, a second connect, and calls after disconnect', async () => {
		const provider = newProvider();
		const record: Record<string, unknown> = {};
		step('init');
		await provider.init({ connected: true, connectedAt: null, settings });
		step('update before connect');
		record['update before connect'] = await outcome(async () => await provider.update());
		step('test before connect');
		record['test before connect'] = await outcome(async () => await provider.test());
		step('connect');
		await provider.connect();
		step('update');
		await provider.update();
		gcp.state.secrets = [{ name: 'new', value: 'n' }];
		await provider.update();
		record['after a change'] = provider.getSecretNames();
		gcp.state.listError = { code: 13, message: 'INTERNAL: boom' };
		record['failing update'] = await outcome(async () => await provider.update());
		record['after the failing update'] = {
			names: provider.getSecretNames(),
			state: provider.state,
		};
		gcp.state.listError = undefined;
		step('connect again');
		await provider.connect();
		step('disconnect');
		await provider.disconnect();
		step('test after disconnect');
		record['test after disconnect'] = await outcome(async () => await provider.test());
		expect({ ...record, log: gcp.log }).toMatchSnapshot();
	});

	test('reads the secrets in parallel', async () => {
		gcp.state.secrets = [
			{ name: 'a', value: '1' },
			{ name: 'b', value: '2' },
			{ name: 'c', value: '3' },
		];
		gcp.state.delayMs = 1000;
		const provider = newProvider();
		await provider.init({ connected: true, connectedAt: null, settings });
		await provider.connect();
		const from = Date.now();
		const update = await outcome(async () => await provider.update());
		const time = `${Math.round((Date.now() - from) / 500) * 500} ms`;
		expect({ update, time, names: provider.getSecretNames() }).toMatchSnapshot();
	}, 20_000);
});
