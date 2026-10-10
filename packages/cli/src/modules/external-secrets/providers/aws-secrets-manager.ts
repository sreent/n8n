import type { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { OutboundHttp } from '@n8n/backend-network';
import { Container } from '@n8n/di';
import type { INodeProperties } from 'n8n-workflow';

import { UnknownAuthTypeError } from '../errors/unknown-auth-type.error';
import { SecretsProvider, type SecretsProviderSettings } from '../types';

interface AwsSecretsManagerSettings {
	region: string;
	authMethod: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/** BatchGetSecretValue takes at most 20 secret IDs in one request. */
const BATCH_SIZE = 20;

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
		displayName: 'Region',
		name: 'region',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. eu-west-3',
		default: '',
	},
	{
		displayName: 'Authentication Method',
		name: 'authMethod',
		type: 'options',
		required: true,
		noDataExpression: true,
		default: 'iamUser',
		options: [
			{
				name: 'IAM User',
				value: 'iamUser',
				description:
					'Credentials for IAM user having <code>secretsmanager:ListSecrets</code> and <code>secretsmanager:BatchGetSecretValue</code> permissions. <a href="https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html" target="_blank">Learn more</a>',
			},
			{
				name: 'Auto Detect',
				value: 'autoDetect',
				description:
					'Use automatic credential detection to authenticate AWS calls for external secrets<a href="https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html#credchain" target="_blank">Learn more</a>.',
			},
		],
	},
	{
		displayName: 'Access Key ID',
		name: 'accessKeyId',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. ACHXUQMBAQEVTE2RKMWP',
		default: '',
		displayOptions: {
			show: {
				authMethod: ['iamUser'],
			},
		},
	},
	{
		displayName: 'Secret Access Key',
		name: 'secretAccessKey',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. cbmjrH/xNAjPwlQR3i/1HRSDD+esQX/Lan3gcmBc',
		default: '',
		typeOptions: {
			password: true,
		},
		displayOptions: {
			show: {
				authMethod: ['iamUser'],
			},
		},
	},
];

/**
 * Fork code (not in upstream n8n). Reads all secrets of an AWS account in one region with the
 * AWS SDK. Each secret with a text value is a secret of n8n; binary and empty values are left
 * out. packages/cli/src/modules/external-secrets/FORK.md describes the behaviour.
 */
export class AwsSecretsManagerProvider extends SecretsProvider {
	properties: INodeProperties[] = PROPERTIES;

	displayName = 'AWS Secrets Manager';

	name = 'awsSecretsManager';

	private client: SecretsManager | undefined;

	private secrets: Record<string, string> = {};

	async init(settings: SecretsProviderSettings): Promise<void> {
		const { region, authMethod, accessKeyId, secretAccessKey } =
			settings.settings as unknown as AwsSecretsManagerSettings;
		if (authMethod !== 'iamUser' && authMethod !== 'autoDetect') {
			throw new UnknownAuthTypeError(authMethod);
		}
		// The SDK makes its own requests, to the endpoint of the region. The agents add the proxy of
		// the environment. As for the other providers, an admin sets up the provider, so the SSRF
		// policy does not apply.
		const { httpAgent, httpsAgent } = Container.get(OutboundHttp)
			.transport({ useDefaultSsrfPolicy: 'unsafe' })
			.getNodeAgent();
		const { SecretsManager } = await import('@aws-sdk/client-secrets-manager');
		// Without credentials, the SDK finds them with its default chain: the environment, the
		// shared files, and the role of the container or the instance.
		this.client = new SecretsManager({
			region,
			...(authMethod === 'iamUser' ? { credentials: { accessKeyId, secretAccessKey } } : {}),
			requestHandler: { httpAgent, httpsAgent },
		});
	}

	protected async doConnect(): Promise<void> {
		await this.client!.listSecrets({ MaxResults: 1 });
	}

	async disconnect(): Promise<void> {}

	async update(): Promise<void> {
		// Before an init without errors there is no client, and the call throws a TypeError.
		const names: string[] = [];
		let nextToken: string | undefined;
		do {
			const page = await this.client!.listSecrets({ NextToken: nextToken });
			for (const entry of page.SecretList ?? []) {
				if (entry.Name) names.push(entry.Name);
			}
			nextToken = page.NextToken;
		} while (nextToken);

		const secrets: Record<string, string> = {};
		for (let start = 0; start < names.length; start += BATCH_SIZE) {
			const batch = await this.client!.batchGetSecretValue({
				SecretIdList: names.slice(start, start + BATCH_SIZE),
			});
			// The response reports the secrets that it cannot read in `Errors`. They are left out.
			for (const value of batch.SecretValues ?? []) {
				if (value.Name && value.SecretString) secrets[value.Name] = value.SecretString;
			}
		}
		this.secrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.client!.listSecrets({ MaxResults: 1 });
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
