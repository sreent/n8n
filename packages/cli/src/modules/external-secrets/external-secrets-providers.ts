import { Service } from '@n8n/di';

import { AwsSecretsManagerProvider } from './providers/aws-secrets-manager';
import { AzureKeyVaultProvider } from './providers/azure-key-vault';
import { GcpSecretsManagerProvider } from './providers/gcp-secrets-manager';
import { InfisicalProvider } from './providers/infisical';
import { OnePasswordProvider } from './providers/one-password';
import { VaultProvider } from './providers/vault';
import type { SecretsProvider } from './types';

/**
 * Fork code (not in upstream n8n). The secrets provider types, by name. The order is the order
 * of the types in the API.
 */
@Service()
export class ExternalSecretsProviders {
	providers: Record<string, new () => SecretsProvider> = {
		awsSecretsManager: AwsSecretsManagerProvider,
		infisical: InfisicalProvider,
		vault: VaultProvider,
		azureKeyVault: AzureKeyVaultProvider,
		gcpSecretsManager: GcpSecretsManagerProvider,
		onePassword: OnePasswordProvider,
	};
}
