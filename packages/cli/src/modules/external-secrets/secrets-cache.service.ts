import { Service } from '@n8n/di';

import { ExternalSecretsConfig } from './external-secrets.config';
import { ExternalSecretsProviderLifecycle } from './provider-lifecycle.service';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';

/**
 * Fork code (not in upstream n8n). Reads the secrets of the connected providers again at each
 * update interval (`N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL`). Each read waits at most the refresh
 * timeout. A read that fails keeps the secrets that the provider had.
 */
@Service()
export class ExternalSecretsSecretsCache {
	private interval: NodeJS.Timeout | undefined;

	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly registry: ExternalSecretsProviderRegistry,
		private readonly lifecycle: ExternalSecretsProviderLifecycle,
	) {}

	start() {
		this.stop();
		this.interval = setInterval(
			async () => await this.refreshAll(),
			this.config.updateInterval * 1000,
		);
	}

	stop() {
		clearInterval(this.interval);
		this.interval = undefined;
	}

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
