import {
	OutboundHttp,
	httpStatusFromError,
	isConnectionRefusedError,
	type HttpRequestClient,
} from '@n8n/backend-network';
import { Container } from '@n8n/di';
import { UnexpectedError, type INodeProperties } from 'n8n-workflow';

import { ExternalSecretsConfig } from '../external-secrets.config';
import { SecretsProvider, type SecretsProviderSettings } from '../types';

interface InfisicalSettings {
	siteURL: string;
	projectId: string;
	environment: string;
	secretPath: string;
	authMethod: string;
	clientId?: string;
	clientSecret?: string;
}

interface InfisicalSecret {
	secretKey: string;
	secretValue: unknown;
}

interface InfisicalSecretsResponse {
	secrets: InfisicalSecret[];
	imports: Array<{ secrets: InfisicalSecret[] }>;
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
		displayName: 'Site URL',
		name: 'siteURL',
		type: 'string',
		hint: "The absolute URL of the Infisical instance. Change it only if you're self-hosting Infisical.",
		required: true,
		noDataExpression: true,
		placeholder: 'https://app.infisical.com',
		default: 'https://app.infisical.com',
	},
	{
		displayName: 'Project ID',
		name: 'projectId',
		type: 'string',
		hint: 'The Infisical project to read secrets from',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. 7c1cbe9c-3f1b-4a92-b3a2-9d5e2f1c8a4b',
		default: '',
	},
	{
		displayName: 'Environment',
		name: 'environment',
		type: 'string',
		hint: 'Environment slug (e.g. dev, staging, prod)',
		required: true,
		noDataExpression: true,
		placeholder: 'dev',
		default: 'dev',
	},
	{
		displayName: 'Secret Path',
		name: 'secretPath',
		type: 'string',
		hint: 'The path within the project to read secrets from',
		required: true,
		noDataExpression: true,
		placeholder: '/',
		default: '/',
	},
	{
		displayName: 'Authentication Method',
		name: 'authMethod',
		type: 'options',
		required: true,
		noDataExpression: true,
		default: 'universalAuth',
		options: [
			{
				name: 'Universal Auth',
				value: 'universalAuth',
			},
		],
	},
	{
		displayName: 'Client ID',
		name: 'clientId',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. 8a7b1f1c-9f2a-4d6c-bf1a-2c4e6f8b1d3a',
		default: '',
		displayOptions: {
			show: {
				authMethod: ['universalAuth'],
			},
		},
	},
	{
		displayName: 'Client Secret',
		name: 'clientSecret',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: '***************',
		default: '',
		typeOptions: {
			password: true,
		},
		displayOptions: {
			show: {
				authMethod: ['universalAuth'],
			},
		},
	},
];

/**
 * Fork code (not in upstream n8n). Reads the secrets of one folder of an Infisical project, with
 * a machine identity (Universal Auth).
 * packages/cli/src/modules/external-secrets/FORK.md describes the behaviour.
 */
export class InfisicalProvider extends SecretsProvider {
	properties: INodeProperties[] = PROPERTIES;

	displayName = 'Infisical';

	name = 'infisical';

	private settings: InfisicalSettings = {
		siteURL: '',
		projectId: '',
		environment: '',
		secretPath: '',
		authMethod: '',
	};

	private http: HttpRequestClient | undefined;

	private accessToken: string | undefined;

	private secrets: Record<string, unknown> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings as unknown as InfisicalSettings;
		const config = Container.get(ExternalSecretsConfig);
		this.http = Container.get(OutboundHttp).requests({
			// Infisical can be self-hosted on an internal network that an admin set up.
			useDefaultSsrfPolicy: 'unsafe',
			baseURL: this.settings.siteURL.replace(/\/+$/, ''),
			headers: () => ({
				Authorization: this.accessToken ? `Bearer ${this.accessToken}` : undefined,
			}),
			timeout: Math.max(config.connectTimeout, config.refreshTimeout) * 1000,
		});
	}

	protected async doConnect(): Promise<void> {
		if (this.settings.authMethod === 'universalAuth') {
			if (!this.settings.clientId || !this.settings.clientSecret) {
				throw new UnexpectedError('Infisical needs a client ID and a client secret');
			}
			await this.logIn();
		}
		await this.request({ method: 'GET', url: this.projectPath() });
	}

	async disconnect(): Promise<void> {}

	async update(): Promise<void> {
		if (!this.accessToken) {
			throw new UnexpectedError('Update attempted on Infisical before authentication');
		}
		const { projectId, environment, secretPath } = this.settings;
		const url =
			`/api/v4/secrets?projectId=${encodeURIComponent(projectId)}` +
			`&environment=${encodeURIComponent(environment)}` +
			`&secretPath=${encodeURIComponent(secretPath)}`;
		let answer: InfisicalSecretsResponse;
		try {
			answer = await this.request<InfisicalSecretsResponse>({ method: 'GET', url, json: true });
		} catch (error) {
			// An access token expires. Log in again and repeat the request once.
			if (httpStatusFromError(error) !== 401) throw error;
			await this.logIn();
			answer = await this.request<InfisicalSecretsResponse>({ method: 'GET', url, json: true });
		}
		const secrets: Record<string, unknown> = {};
		answer.secrets.forEach(({ secretKey, secretValue }) => {
			secrets[secretKey] = secretValue;
		});
		// The secrets of the folder win over imported secrets with the same key.
		answer.imports.forEach((imported) => {
			imported.secrets.forEach(({ secretKey, secretValue }) => {
				if (!(secretKey in secrets)) secrets[secretKey] = secretValue;
			});
		});
		this.secrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.request({ method: 'GET', url: this.projectPath() });
			return [true];
		} catch (error) {
			const status = httpStatusFromError(error);
			if (status === 401) return [false, 'Invalid credentials'];
			if (status === 403) {
				return [
					false,
					'Permission denied. Verify the machine identity has access to this project.',
				];
			}
			if (status === 404) return [false, 'Project not found. Check the Project ID and Site URL.'];
			if (status !== undefined) {
				return [false, `Unexpected response from Infisical (status ${status}).`];
			}
			if (isConnectionRefusedError(error)) {
				return [false, 'Connection refused. Check the Site URL.'];
			}
			return [false, error instanceof Error ? error.message : String(error)];
		}
	}

	getSecret(name: string): unknown {
		return this.secrets[name];
	}

	hasSecret(name: string): boolean {
		return name in this.secrets;
	}

	getSecretNames(): string[] {
		return Object.keys(this.secrets);
	}

	private async request<T = unknown>(options: Parameters<HttpRequestClient['request']>[0]) {
		// Before init there is no client, and the call throws a TypeError.
		return await this.http!.request<T>({ ...options, returnFullResponse: false });
	}

	private projectPath() {
		return `/api/v1/workspace/${encodeURIComponent(this.settings.projectId)}`;
	}

	/** Get an access token for the machine identity. A failed login keeps the old token. */
	private async logIn() {
		const { accessToken } = await this.request<{ accessToken: string }>({
			method: 'POST',
			url: '/api/v1/auth/universal-auth/login',
			body: { clientId: this.settings.clientId, clientSecret: this.settings.clientSecret },
			json: true,
		});
		this.accessToken = accessToken;
	}
}
