import type { SecretClient } from '@azure/keyvault-secrets';
import { UserError, type INodeProperties } from 'n8n-workflow';

import { SecretsProvider, type SecretsProviderSettings } from '../types';

interface AzureKeyVaultSettings {
	environment?: string;
	vaultName: string;
	vaultUrl: string;
	tenantId: string;
	clientId: string;
	clientSecret: string;
	authorityHost?: string;
}

/** The domain of the vaults and the sign-in host of each Azure cloud. */
const CLOUDS: Record<string, { vaultDomain: string; authorityHost: string }> = {
	public: { vaultDomain: 'vault.azure.net', authorityHost: 'https://login.microsoftonline.com' },
	usGovernment: {
		vaultDomain: 'vault.usgovcloudapi.net',
		authorityHost: 'https://login.microsoftonline.us',
	},
	china: {
		vaultDomain: 'vault.azure.cn',
		authorityHost: 'https://login.partner.microsoftonline.cn',
	},
};

const NO_CLIENT_MESSAGE = 'Failed to connect to Azure Key Vault';

/** The fields of the settings form. */
const PROPERTIES: INodeProperties[] = [
	{
		displayName:
			'Need help filling out these fields? <a href="https://docs.n8n.io/external-secrets/#connect-n8n-to-your-secrets-store" target="_blank">Open docs</a>',
		name: 'notice',
		type: 'notice',
		noDataExpression: true,
		default: '',
	},
	{
		displayName: 'Azure Cloud',
		name: 'environment',
		type: 'options',
		hint: 'The Azure cloud environment your Key Vault is hosted in.',
		noDataExpression: true,
		default: 'public',
		options: [
			{
				name: 'Azure Public Cloud',
				value: 'public',
				description: 'Uses <code>vault.azure.net</code> and <code>login.microsoftonline.com</code>',
			},
			{
				name: 'Azure US Government',
				value: 'usGovernment',
				description:
					'Uses <code>vault.usgovcloudapi.net</code> and <code>login.microsoftonline.us</code>',
			},
			{
				name: 'Azure China',
				value: 'china',
				description:
					'Uses <code>vault.azure.cn</code> and <code>login.partner.microsoftonline.cn</code>',
			},
			{
				name: 'Custom',
				value: 'custom',
				description:
					'Provide the vault URL and authority host directly, for setups such as Azure Stack or proxied environments',
			},
		],
	},
	{
		displayName: 'Vault Name',
		name: 'vaultName',
		type: 'string',
		hint: 'The name of your existing Azure Key Vault.',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. my-vault',
		default: '',
		displayOptions: {
			hide: {
				environment: ['custom'],
			},
		},
	},
	{
		displayName: 'Vault URL',
		name: 'vaultUrl',
		type: 'string',
		hint: 'The full URL of your existing Azure Key Vault.',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. https://my-vault.vault.usgovcloudapi.net',
		default: '',
		displayOptions: {
			show: {
				environment: ['custom'],
			},
		},
	},
	{
		displayName: 'Tenant ID',
		name: 'tenantId',
		type: 'string',
		hint: 'In Azure, this can be called "Directory (Tenant) ID".',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. 7dec9324-7074-72b7-a3ca-a9bb3012f466',
		default: '',
	},
	{
		displayName: 'Client ID',
		name: 'clientId',
		type: 'string',
		hint: 'In Azure, this can be called "Application (Client) ID".',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. 7753d8c2-e41f-22ed-3dd7-c9e96463622c',
		default: '',
		typeOptions: {
			password: true,
		},
	},
	{
		displayName: 'Client Secret',
		name: 'clientSecret',
		type: 'string',
		hint: 'The client secret value of your registered application.',
		required: true,
		noDataExpression: true,
		default: '',
		typeOptions: {
			password: true,
		},
	},
	{
		displayName: 'Authority Host',
		name: 'authorityHost',
		type: 'string',
		hint: 'The Microsoft Entra authority to authenticate against. Leave empty to use the default (https://login.microsoftonline.com).',
		noDataExpression: true,
		placeholder: 'e.g. https://login.microsoftonline.us',
		default: '',
		displayOptions: {
			show: {
				environment: ['custom'],
			},
		},
	},
];

/**
 * Fork code (not in upstream n8n). Reads all enabled secrets of an Azure Key Vault with the Azure
 * SDK and a client secret of an app registration.
 * packages/cli/src/modules/external-secrets/FORK.md describes the behaviour.
 */
export class AzureKeyVaultProvider extends SecretsProvider {
	properties: INodeProperties[] = PROPERTIES;

	displayName = 'Azure Key Vault';

	name = 'azureKeyVault';

	private settings: AzureKeyVaultSettings = {
		vaultName: '',
		vaultUrl: '',
		tenantId: '',
		clientId: '',
		clientSecret: '',
	};

	private client: SecretClient | undefined;

	private secrets: Record<string, string> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings as unknown as AzureKeyVaultSettings;
	}

	protected async doConnect(): Promise<void> {
		const { vaultName, vaultUrl, tenantId, clientId, clientSecret, authorityHost } = this.settings;
		const environment = this.settings.environment ?? 'public';
		let url: string;
		let host: string;
		if (environment === 'custom') {
			url = vaultUrl;
			host = authorityHost || CLOUDS.public.authorityHost;
		} else if (Object.hasOwn(CLOUDS, environment)) {
			// The fields of the custom cloud can stay in the settings. They do not apply here.
			url = `https://${vaultName}.${CLOUDS[environment].vaultDomain}/`;
			host = CLOUDS[environment].authorityHost;
		} else {
			throw new UserError('Unknown Azure cloud', { extra: { environment } });
		}

		// The SDK makes its own requests to Azure, and uses the proxy of the environment.
		const { ClientSecretCredential } = await import('@azure/identity');
		const { SecretClient } = await import('@azure/keyvault-secrets');
		const credential = new ClientSecretCredential(tenantId, clientId, clientSecret, {
			authorityHost: host,
		});
		this.client = new SecretClient(url, credential);
	}

	async disconnect(): Promise<void> {}

	async update(): Promise<void> {
		// Before a connect there is no client, and the call throws a TypeError.
		const names: string[] = [];
		for await (const properties of this.client!.listPropertiesOfSecrets()) {
			// Only a secret that is disabled has the flag `false`.
			if (properties.enabled !== false) names.push(properties.name);
		}

		const client = this.client!;
		const values = await Promise.all(
			names.map(async (name) => {
				try {
					return (await client.getSecret(name)).value;
				} catch {
					// A secret that the vault does not give is left out.
					return undefined;
				}
			}),
		);
		const secrets: Record<string, string> = {};
		names.forEach((name, index) => {
			const value = values[index];
			if (value !== undefined) secrets[name] = value;
		});
		this.secrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		if (!this.client) return [false, NO_CLIENT_MESSAGE];
		try {
			// The first page of secrets proves the credentials and the access to the vault.
			await this.client.listPropertiesOfSecrets().next();
			return [true];
		} catch (error) {
			return [false, error instanceof Error ? error.message : String(error)];
		}
	}

	getSecret(name: string): string | undefined {
		return this.secrets[name];
	}

	hasSecret(name: string): boolean {
		return name in this.secrets;
	}

	getSecretNames(): string[] {
		return Object.keys(this.secrets);
	}
}
