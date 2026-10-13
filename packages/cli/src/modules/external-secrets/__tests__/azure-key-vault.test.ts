// The behaviour of the Azure Key Vault provider against fakes of the Azure SDK: the form fields,
// the clouds, the custom vault URL and authority host, the credential and the client that the
// provider makes, the secrets that it reads, the connection test, and the errors. The fakes
// replace `ClientSecretCredential` and `SecretClient`, and log each construction, each call and
// each listed secret that the provider takes. For each case, the snapshot records the result and
// the state of each step, and that log. The snapshot records what the provider does, so a change
// in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
const azure = vi.hoisted(() => {
	interface FakeSecret {
		name: string;
		value?: string;
		enabled?: boolean;
		/** The list gives the secret without the `enabled` flag. */
		withoutFlag?: boolean;
	}
	interface FakeError {
		statusCode: number;
		code: string;
		message: string;
	}
	const log: unknown[][] = [];
	const step = { label: '' };
	const state = {
		secrets: [] as FakeSecret[],
		listError: undefined as FakeError | undefined,
		getErrors: {} as Record<string, FakeError>,
		delayMs: 0,
	};
	/** An error as the Azure SDK throws it (a RestError with a status code and a code). */
	const restError = ({ statusCode, code, message }: FakeError) =>
		Object.assign(new Error(message), { name: 'RestError', statusCode, code });
	/** Log the use of members that the fakes do not have. */
	const watch = <T extends object>(target: T, label: string): T =>
		new Proxy(target, {
			get(object, property, receiver) {
				if (typeof property === 'string' && !(property in object) && property !== 'then') {
					log.push([step.label, `${label}.${property} (not in the fake)`]);
				}
				return Reflect.get(object, property, receiver) as unknown;
			},
		});
	return { log, step, state, restError, watch };
});

vi.mock('@azure/identity', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class ClientSecretCredential {
		constructor(...args: unknown[]) {
			azure.log.push([azure.step.label, 'new ClientSecretCredential', ...args]);
			return azure.watch(this, 'ClientSecretCredential');
		}

		async getToken(scopes: unknown) {
			azure.log.push([azure.step.label, 'ClientSecretCredential.getToken', scopes]);
			return { token: 'token', expiresOnTimestamp: 4102444800000 };
		}
	}
	return { ...actual, ClientSecretCredential };
});

vi.mock('@azure/keyvault-secrets', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class SecretClient {
		constructor(vaultUrl: unknown, credential: unknown, ...rest: unknown[]) {
			azure.log.push([
				azure.step.label,
				'new SecretClient',
				vaultUrl,
				credential?.constructor.name,
				...rest,
			]);
			return azure.watch(this, 'SecretClient');
		}

		listPropertiesOfSecrets(...args: unknown[]) {
			azure.log.push([azure.step.label, 'SecretClient.listPropertiesOfSecrets', ...args]);
			const { secrets, listError } = azure.state;
			const label = azure.step.label;
			async function* items() {
				if (listError) throw azure.restError(listError);
				for (const secret of secrets) {
					azure.log.push([label, 'listed secret taken', secret.name]);
					yield secret.withoutFlag
						? { name: secret.name, vaultUrl: 'https://vault' }
						: { name: secret.name, enabled: secret.enabled ?? true, vaultUrl: 'https://vault' };
				}
			}
			return Object.assign(items(), {
				byPage: () => {
					azure.log.push([label, 'SecretClient.listPropertiesOfSecrets.byPage']);
					return items();
				},
			});
		}

		async getSecret(name: string, ...args: unknown[]) {
			azure.log.push([azure.step.label, 'SecretClient.getSecret', name, ...args]);
			if (azure.state.delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, azure.state.delayMs));
			}
			const error = azure.state.getErrors[name];
			if (error) throw azure.restError(error);
			const secret = azure.state.secrets.find((candidate) => candidate.name === name);
			if (!secret) {
				throw azure.restError({
					statusCode: 404,
					code: 'SecretNotFound',
					message: `${name} was not found`,
				});
			}
			return {
				name,
				value: secret.value,
				properties: { name, enabled: secret.enabled ?? true, vaultUrl: 'https://vault' },
			};
		}
	}
	return { ...actual, SecretClient };
});

import { Container } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point this import at `@/modules/external-secrets.ee/external-secrets-providers.ee`.
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';

import { drive, outcome, type DrivenProvider } from './fakes/drive';

const newProvider = () =>
	new (Container.get(
		ExternalSecretsProviders,
	).providers.azureKeyVault)() as unknown as DrivenProvider;

const settings: IDataObject = {
	environment: 'public',
	vaultName: 'my-vault',
	tenantId: 'tenant-1',
	clientId: 'client-1',
	clientSecret: 'secret-1',
};

beforeEach(() => {
	azure.log.length = 0;
	azure.step.label = '';
	azure.state.secrets = [
		{ name: 'db-password', value: 'pw' },
		{ name: 'disabled', value: 'd', enabled: false },
		{ name: 'empty', value: '' },
		{ name: 'novalue' },
		{ name: 'multi-line', value: 'a\nb' },
		{ name: 'no-flag', value: 'f', withoutFlag: true },
	];
	azure.state.listError = undefined;
	azure.state.getErrors = {};
	azure.state.delayMs = 0;
});

const step = (label: string) => {
	azure.step.label = label;
};

interface Case {
	name: string;
	settings: IDataObject;
	state?: () => void;
}

const cases: Case[] = [
	{ name: 'Azure Public Cloud', settings },
	{ name: 'Azure US Government', settings: { ...settings, environment: 'usGovernment' } },
	{ name: 'Azure China', settings: { ...settings, environment: 'china' } },
	{
		// The settings can keep the fields of the custom cloud after a change to another cloud.
		name: 'Azure Public Cloud with a vault URL and an authority host in the settings',
		settings: {
			...settings,
			vaultUrl: 'https://vault.example.com',
			authorityHost: 'https://login.example.com',
		},
	},
	{
		name: 'custom vault URL and authority host',
		settings: {
			...settings,
			environment: 'custom',
			vaultUrl: 'https://vault.example.com/',
			authorityHost: 'https://login.example.com',
		},
	},
	{
		name: 'custom vault URL without an authority host',
		settings: { ...settings, environment: 'custom', vaultUrl: 'https://vault.example.com' },
	},
	{
		name: 'custom vault URL with an empty authority host',
		settings: {
			...settings,
			environment: 'custom',
			vaultUrl: 'https://vault.example.com',
			authorityHost: '',
		},
	},
	{
		name: 'custom without a vault URL',
		settings: { ...settings, environment: 'custom', vaultUrl: '' },
	},
	{ name: 'empty cloud', settings: { ...settings, environment: '' } },
	{
		name: 'custom with an invalid vault URL',
		settings: { ...settings, environment: 'custom', vaultUrl: 'not a url' },
	},
	{
		name: 'no cloud in the settings',
		settings: {
			vaultName: 'my-vault',
			tenantId: 'tenant-1',
			clientId: 'client-1',
			clientSecret: 'secret-1',
		},
	},
	{ name: 'unknown cloud', settings: { ...settings, environment: 'mars' } },
	{ name: 'empty vault name', settings: { ...settings, vaultName: '' } },
	{ name: 'vault name with spaces', settings: { ...settings, vaultName: ' my vault ' } },
	{ name: 'empty tenant ID', settings: { ...settings, tenantId: '' } },
	{ name: 'empty client ID', settings: { ...settings, clientId: '' } },
	{ name: 'empty client secret', settings: { ...settings, clientSecret: '' } },
	{
		name: 'list 401',
		settings,
		state: () => {
			azure.state.listError = {
				statusCode: 401,
				code: 'Unauthorized',
				message: 'AKV10000: Request is missing a Bearer or PoP token.',
			};
		},
	},
	{
		name: 'list 403',
		settings,
		state: () => {
			azure.state.listError = {
				statusCode: 403,
				code: 'Forbidden',
				message: 'The user does not have secrets list permission',
			};
		},
	},
	{
		name: 'read 403 for one secret',
		settings,
		state: () => {
			azure.state.getErrors['db-password'] = {
				statusCode: 403,
				code: 'Forbidden',
				message: 'no get permission',
			};
		},
	},
	{
		name: 'read 404 for one secret',
		settings,
		state: () => {
			azure.state.getErrors['multi-line'] = {
				statusCode: 404,
				code: 'SecretNotFound',
				message: 'gone',
			};
		},
	},
	{
		name: 'no secrets',
		settings,
		state: () => {
			azure.state.secrets = [];
		},
	},
];

describe('Azure Key Vault provider', () => {
	test('form fields', () => {
		const provider = new (Container.get(ExternalSecretsProviders).providers.azureKeyVault)();
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
			read: [
				'db-password',
				'db_password',
				'disabled',
				'empty',
				'novalue',
				'multi-line',
				'no-flag',
				'nope',
			],
		});
		expect({ result, log: azure.log }).toMatchSnapshot();
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
		azure.state.secrets = [{ name: 'new', value: 'n' }];
		await provider.update();
		record['after a change'] = provider.getSecretNames();
		azure.state.listError = { statusCode: 500, code: 'InternalError', message: 'boom' };
		record['failing update'] = await outcome(async () => await provider.update());
		record['after the failing update'] = {
			names: provider.getSecretNames(),
			state: provider.state,
		};
		azure.state.listError = undefined;
		step('connect again');
		await provider.connect();
		step('disconnect');
		await provider.disconnect();
		step('test after disconnect');
		record['test after disconnect'] = await outcome(async () => await provider.test());
		expect({ ...record, log: azure.log }).toMatchSnapshot();
	});

	test('reads the secrets in parallel', async () => {
		azure.state.secrets = [
			{ name: 'a', value: '1' },
			{ name: 'b', value: '2' },
			{ name: 'c', value: '3' },
		];
		azure.state.delayMs = 1000;
		const provider = newProvider();
		await provider.init({ connected: true, connectedAt: null, settings });
		await provider.connect();
		const from = Date.now();
		const update = await outcome(async () => await provider.update());
		const time = `${Math.round((Date.now() - from) / 500) * 500} ms`;
		expect({ update, time, names: provider.getSecretNames() }).toMatchSnapshot();
	}, 20_000);
});
