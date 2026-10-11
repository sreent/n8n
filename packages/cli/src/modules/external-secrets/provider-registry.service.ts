import { Service } from '@n8n/di';

import type { SecretsProvider } from './types';

/**
 * Fork code (not in upstream n8n). The providers that the module uses, by name: the provider type
 * in the mode with one setting for each type, the provider key of the connection in the mode with
 * connections. The map keeps the order in which the names came in.
 */
@Service()
export class ExternalSecretsProviderRegistry {
	private readonly providers = new Map<string, SecretsProvider>();

	get(name: string) {
		return this.providers.get(name);
	}

	set(name: string, provider: SecretsProvider) {
		this.providers.set(name, provider);
	}

	remove(name: string) {
		this.providers.delete(name);
	}

	has(name: string) {
		return this.providers.has(name);
	}

	getNames() {
		return [...this.providers.keys()];
	}

	getAll() {
		return [...this.providers.values()];
	}

	entries() {
		return [...this.providers.entries()];
	}

	/** Forget all providers, as a new process would. */
	clear() {
		this.providers.clear();
	}
}
