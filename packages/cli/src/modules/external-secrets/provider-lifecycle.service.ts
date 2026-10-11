import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import { ExternalSecretsConfig } from './external-secrets.config';
import type { SecretsProvider, SecretsProviderSettings } from './types';

/** The base delay of the retries. The first retry comes after 5 to 10 seconds. */
const RETRY_BASE_DELAY_MS = 10_000;

/** The longest delay between two retries. */
const RETRY_MAX_DELAY_MS = 10 * 60_000;

interface PendingRetry {
	provider: SecretsProvider;
	attempt: number;
	timer: NodeJS.Timeout;
}

/**
 * Fork code (not in upstream n8n). The life of one provider instance: initialize it, read its
 * secrets within the refresh timeout, disconnect it, and try again later when it fails. The delay
 * of each retry is twice the delay before, from a random part between 50% and 100%.
 */
@Service()
export class ExternalSecretsProviderLifecycle {
	private readonly retries = new Map<string, PendingRetry>();

	constructor(
		private readonly logger: Logger,
		private readonly config: ExternalSecretsConfig,
	) {
		this.logger = this.logger.scoped('external-secrets');
	}

	/** Initialize the provider. `false` when the settings are not valid for it. */
	async initialize(provider: SecretsProvider, settings: SecretsProviderSettings) {
		try {
			await provider.init(settings);
			provider.state = 'initialized';
			return true;
		} catch (error) {
			this.logger.error(`Could not initialize the secrets provider "${provider.name}"`, {
				error: ensureError(error).message,
			});
			return false;
		}
	}

	/**
	 * Read the secrets of the provider, but wait at most the refresh timeout. After the timeout,
	 * the read goes on and stores the secrets when it ends. `false` when the read fails within the
	 * time.
	 */
	async refresh(provider: SecretsProvider) {
		let timer: NodeJS.Timeout | undefined;
		const update = provider.update().then(
			() => true,
			(error: unknown) => {
				this.logger.warn(`Could not read the secrets of the provider "${provider.name}"`, {
					error: ensureError(error).message,
				});
				return false;
			},
		);
		const timeout = new Promise<true>((resolve) => {
			timer = setTimeout(() => resolve(true), this.config.refreshTimeout * 1000);
		});
		try {
			return await Promise.race([update, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Disconnect the provider. An error of the provider only goes to the log. */
	async disconnect(provider: SecretsProvider) {
		try {
			await provider.disconnect();
		} catch (error) {
			this.logger.warn(`Could not disconnect the secrets provider "${provider.name}"`, {
				error: ensureError(error).message,
			});
		}
	}

	/**
	 * Try the provider again later, under the name. `retry` runs at each attempt and gives `true`
	 * when the provider is ready. A retry of the same name replaces this one.
	 */
	scheduleRetry(
		name: string,
		provider: SecretsProvider,
		retry: (provider: SecretsProvider) => Promise<boolean>,
		attempt = 0,
	) {
		this.cancelRetry(name);
		const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
		const timer = setTimeout(
			async () => {
				if (this.retries.get(name)?.provider !== provider) return;
				this.retries.delete(name);
				let ready = false;
				try {
					ready = await retry(provider);
				} catch (error) {
					this.logger.warn(`The retry of the secrets provider "${name}" failed`, {
						error: ensureError(error).message,
					});
				}
				if (!ready && !this.retries.has(name)) {
					this.scheduleRetry(name, provider, retry, attempt + 1);
				}
			},
			delay * (0.5 + Math.random() * 0.5),
		);
		this.retries.set(name, { provider, attempt, timer });
	}

	/** Stop the retries of the name. */
	cancelRetry(name: string) {
		const pending = this.retries.get(name);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.retries.delete(name);
	}

	/** The provider that waits for a retry under the name. */
	getRetryingProvider(name: string) {
		return this.retries.get(name)?.provider;
	}

	/** Stop all retries. Gives the providers that waited for a retry. */
	cancelAllRetries() {
		const providers = [...this.retries.values()].map(({ provider }) => provider);
		for (const name of [...this.retries.keys()]) this.cancelRetry(name);
		return providers;
	}
}
