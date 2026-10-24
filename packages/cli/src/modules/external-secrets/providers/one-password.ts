import { OnePasswordConnect, type OPConnect } from '@1password/connect';
import { UserError, type IDataObject, type INodeProperties } from 'n8n-workflow';

import { SecretsProvider, type SecretsProviderSettings } from '../types';

interface OnePasswordSettings {
	serverUrl: string;
	accessToken: string;
}

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
		displayName: 'Connect Server URL',
		name: 'serverUrl',
		type: 'string',
		hint: 'URL of your <a href="https://developer.1password.com/docs/connect/get-started/" target="_blank">1Password Connect Server</a>.',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. http://localhost:8080',
		default: '',
	},
	{
		displayName: 'Access Token',
		name: 'accessToken',
		type: 'string',
		hint: 'Token created for your Connect Server integration.',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. eyJhbGciOiJFUzI1NiIsImtpZCI6...',
		default: '',
		typeOptions: {
			password: true,
		},
	},
];

/**
 * Fork code (not in upstream n8n). Reads the items of all vaults that a 1Password Connect server
 * gives to the access token. Each item is a secret with its fields as properties.
 * packages/cli/src/modules/external-secrets/FORK.md describes the behaviour.
 */
export class OnePasswordProvider extends SecretsProvider {
	properties: INodeProperties[] = PROPERTIES;

	displayName = '1Password';

	name = 'onePassword';

	private settings: OnePasswordSettings = { serverUrl: '', accessToken: '' };

	private client: OPConnect | undefined;

	private secrets: Record<string, IDataObject> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings as unknown as OnePasswordSettings;
		if (!this.settings.serverUrl) throw new UserError('Connect Server URL is required.');
		if (!this.settings.accessToken) throw new UserError('Access Token is required.');
	}

	protected async doConnect(): Promise<void> {
		// The SDK makes its own requests to the Connect server, which an admin set up.
		this.client = OnePasswordConnect({
			serverURL: this.settings.serverUrl,
			token: this.settings.accessToken,
		});
		await this.client.listVaults();
	}

	async disconnect(): Promise<void> {}

	async update(): Promise<void> {
		// Before a connect there is no client, and the call throws a TypeError.
		const vaults = await this.client!.listVaults();
		const secrets: Record<string, IDataObject> = {};
		for (const vault of vaults) {
			if (!vault.id) continue;
			const items = await this.client!.listItems(vault.id);
			for (const summary of items) {
				if (!summary.id) continue;
				const item = await this.client!.getItemById(vault.id, summary.id);
				const fields: IDataObject = {};
				for (const field of item.fields ?? []) {
					if (field.label && field.value) fields[field.label] = field.value;
				}
				// A later item with the same title replaces the earlier one.
				if (Object.keys(fields).length > 0 && item.title !== undefined) {
					secrets[item.title] = fields;
				}
			}
		}
		this.secrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		if (!this.client) return [false, 'Client not initialized'];
		try {
			await this.client.listVaults();
			return [true];
		} catch (error) {
			// The SDK rejects with the error body of the server, which is not an Error.
			return [false, error instanceof Error ? error.message : 'Unknown error'];
		}
	}

	getSecret(name: string): IDataObject | undefined {
		return this.secrets[name];
	}

	hasSecret(name: string): boolean {
		return name in this.secrets;
	}

	/** The editor completes the fields of an item, so each name is `<item title>.<field label>`. */
	getSecretNames(): string[] {
		return Object.entries(this.secrets).flatMap(([title, fields]) =>
			Object.keys(fields).map((label) => `${title}.${label}`),
		);
	}
}
