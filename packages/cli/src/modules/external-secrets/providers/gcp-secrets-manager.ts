import type { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { isRecord } from '@n8n/utils/is-record';
import { UserError, type INodeProperties } from 'n8n-workflow';

import { SecretsProvider, type SecretsProviderSettings } from '../types';

/** The fields of the service account key that the provider uses. */
interface GcpSecretsManagerSettings {
	projectId: string;
	clientEmail: string;
	privateKey: string;
}

const KEY_MESSAGE =
	'Service account key must contain "client_email" and "private_key" fields. Use the downloaded service account JSON key file from Google Cloud Console.';

const NO_CLIENT_MESSAGE = 'Failed to connect to GCP Secrets Manager';

/** The text of a field of the key, without the spaces around it. */
const keyField = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);

/**
 * Reads the service account key, the JSON text of the key file. A key that is not a JSON object
 * with the email and the private key gives the same error.
 */
function parseServiceAccountKey(serviceAccountKey: unknown): GcpSecretsManagerSettings {
	let key: unknown;
	try {
		key = typeof serviceAccountKey === 'string' ? JSON.parse(serviceAccountKey) : undefined;
	} catch {
		key = undefined;
	}
	const fields = isRecord(key) ? key : {};
	const clientEmail = keyField(fields.client_email);
	const privateKey = keyField(fields.private_key);
	if (!clientEmail || !privateKey) throw new UserError(KEY_MESSAGE);
	return { projectId: keyField(fields.project_id) ?? '', clientEmail, privateKey };
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
		displayName: 'Service Account Key',
		name: 'serviceAccountKey',
		type: 'json',
		hint: 'Content of JSON file downloaded from Google Cloud Console.',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. { "type": "service_account", "project_id": "gcp-secrets-store", ... }',
		default: '',
		typeOptions: {
			password: true,
		},
	},
];

/**
 * Fork code (not in upstream n8n). Reads the latest version of all secrets of a Google Cloud
 * project with the GCP SDK and a service account key.
 * packages/cli/src/modules/external-secrets/FORK.md describes the behaviour.
 */
export class GcpSecretsManagerProvider extends SecretsProvider {
	properties: INodeProperties[] = PROPERTIES;

	displayName = 'GCP Secrets Manager';

	name = 'gcpSecretsManager';

	/** Set by an init without errors. */
	private settings: GcpSecretsManagerSettings | undefined;

	private client: SecretManagerServiceClient | undefined;

	private secrets: Record<string, string> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = parseServiceAccountKey(settings.settings.serviceAccountKey);
	}

	protected async doConnect(): Promise<void> {
		// Before an init without errors there are no settings, and this throws a TypeError.
		const { projectId, clientEmail, privateKey } = this.settings!;
		// The SDK makes its own requests to Google Cloud.
		const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
		this.client = new SecretManagerServiceClient({
			credentials: { client_email: clientEmail, private_key: privateKey },
			projectId,
		});
	}

	async disconnect(): Promise<void> {}

	async update(): Promise<void> {
		// Before an init without errors there are no settings, and before a connect there is no
		// client. Then the update throws a TypeError.
		const { projectId } = this.settings!;
		const [listed] = await this.client!.listSecrets({ parent: `projects/${projectId}` });
		// The listed names are `projects/<project number>/secrets/<name>`.
		const names = listed.flatMap((secret) => secret.name?.split('/').pop() ?? []);

		const client = this.client!;
		const values = await Promise.all(
			names.map(async (name) => {
				try {
					const [version] = await client.accessSecretVersion({
						name: `projects/${projectId}/secrets/${name}/versions/latest`,
					});
					return version.payload?.data?.toString();
				} catch {
					// A secret without a version that the account can read is left out.
					return undefined;
				}
			}),
		);
		const secrets: Record<string, string> = {};
		names.forEach((name, index) => {
			const value = values[index];
			// Empty values are left out.
			if (value) secrets[name] = value;
		});
		this.secrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		if (!this.client) return [false, NO_CLIENT_MESSAGE];
		try {
			await this.client.initialize();
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
