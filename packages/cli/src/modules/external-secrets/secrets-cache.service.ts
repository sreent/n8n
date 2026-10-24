import { Service } from '@n8n/di';

import { ExternalSecretsProviderLifecycle } from './provider-lifecycle.service';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';

/**
 * Fork code (not in upstream n8n). Reads the secrets of the connected providers again. The system
 * task `external-secrets-refresh` calls it at each update interval. Each read waits at most the
 * refresh timeout. A read that fails keeps the secrets that the provider had.
 */
@Service()
export class ExternalSecretsSecretsCache {
	constructor(
		private readonly registry: ExternalSecretsProviderRegistry,
		private readonly lifecycle: ExternalSecretsProviderLifecycle,
	) {}

	/** Read the secrets of each connected provider again. */
	async refreshAll() {
		await Promise.all(
			this.registry
				.getAll()
				.filter((provider) => provider.state === 'connected')
				.map(async (provider) => await this.lifecycle.refresh(provider)),
		);
	}
}
