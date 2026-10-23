import { Logger } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import { SecretsProviderConnectionRepository, type SecretsProviderConnection } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { Cipher, ExternalSecretsProxy, type IExternalSecretsManager } from 'n8n-core';
import { type IDataObject, jsonParse } from 'n8n-workflow';

import { Publisher } from '@/scaling/pubsub/publisher.service';

import { ExternalSecretsConfig } from './external-secrets.config';
import { ExternalSecretsProviders } from './external-secrets-providers';
import { ExternalSecretsProviderConnectionManager } from './external-secrets-provider-connection-manager';
import { ExternalSecretsProviderLifecycle } from './provider-lifecycle.service';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';
import { ExternalSecretsSecretsCache } from './secrets-cache.service';
import { ExternalSecretsSettingsStore } from './settings-store.service';
import type { ProviderTestResult, SecretsProvider, SecretsProviderSettings } from './types';

const errorMessage = (error: unknown) => ensureError(error).message;

/** A function call, so that TypeScript does not narrow the state across `connect()`. */
const isConnected = (provider: SecretsProvider) => provider.state === 'connected';

/**
 * Fork code (not in upstream n8n). The providers of external secrets that n8n uses: it loads them
 * at the start, replaces them when their settings change, reloads them on a command of another
 * instance, and gives their secrets to the secrets proxy of the core.
 *
 * Without connections (both mode flags off), each provider type has one stored setting, and the
 * provider has the name of its type. With connections, each enabled connection is a provider with
 * the name of its provider key. packages/cli/src/modules/external-secrets/FORK.md describes the
 * behaviour.
 */
@Service()
export class ExternalSecretsManager implements IExternalSecretsManager {
	private initialized = false;

	/**
	 * The parameters keep the order of the ordinary tests, which build a manager with each of these
	 * services. The services of the API use the connection manager themselves.
	 */
	constructor(
		private readonly logger: Logger,
		private readonly config: ExternalSecretsConfig,
		private readonly providers: ExternalSecretsProviders,
		private readonly eventService: EventService,
		private readonly publisher: Publisher,
		private readonly settingsStore: ExternalSecretsSettingsStore,
		private readonly providerRegistry: ExternalSecretsProviderRegistry,
		private readonly providerLifecycle: ExternalSecretsProviderLifecycle,
		_providerConnectionManager: ExternalSecretsProviderConnectionManager,
		private readonly secretsCache: ExternalSecretsSecretsCache,
		private readonly connectionRepository: SecretsProviderConnectionRepository,
		private readonly cipher: Cipher,
	) {
		this.logger = this.logger.scoped('external-secrets');
	}

	/** Load the providers and start the update interval. A second call does nothing. */
	async init() {
		if (this.initialized) return;
		this.initialized = true;
		Container.get(ExternalSecretsProxy).setManager(this);
		await this.loadAllProviders();
		this.secretsCache.start();
	}

	/**
	 * Stop the update interval and the retries, and disconnect the providers. The providers stay in
	 * the registry. The disconnects start before this method returns.
	 */
	shutdown() {
		this.initialized = false;
		this.secretsCache.stop();
		const providers = new Set([
			...this.providerLifecycle.cancelAllRetries(),
			...this.providerRegistry.getAll(),
		]);
		void Promise.all(
			[...providers].map(async (provider) => await this.providerLifecycle.disconnect(provider)),
		);
	}

	/** Whether the module stores connections, in place of one setting for each provider type. */
	usesConnections() {
		return this.config.externalSecretsForProjects || this.config.externalSecretsMultipleConnections;
	}

	// #region The provider types

	/** The provider types, by name, in the order of the API. */
	getProviderTypes() {
		return Object.keys(this.providers.providers);
	}

	hasProviderType(type: string) {
		return Object.hasOwn(this.providers.providers, type);
	}

	/** A new provider of the type, or `undefined` for a type that n8n does not know. */
	createProvider(type: string): SecretsProvider | undefined {
		if (!this.hasProviderType(type)) return undefined;
		return new this.providers.providers[type]();
	}

	// #endregion

	// #region Loading the providers

	/** Load all providers again from the stored settings or connections. */
	@OnPubSubEvent('reload-external-secrets-providers')
	async reloadAllProviders() {
		await this.loadAllProviders();
	}

	/** Ask the other instances to load their providers again. */
	async broadcastReload() {
		await this.publisher.publishCommand({ command: 'reload-external-secrets-providers' });
	}

	private async loadAllProviders() {
		if (this.usesConnections()) {
			const connections = await this.connectionRepository.findEnabledConnections();
			await this.removeProvidersExcept(connections.map(({ providerKey }) => providerKey));
			await Promise.all(
				connections.map(async (connection) => await this.loadConnection(connection)),
			);
			return;
		}
		const settings = (await this.settingsStore.reload()) ?? {};
		await this.removeProvidersExcept(Object.keys(settings));
		await Promise.all(
			Object.entries(settings).map(
				async ([name, providerSettings]) =>
					await this.loadProvider(
						name,
						name,
						providerSettings,
						Boolean(providerSettings.connected),
					),
			),
		);
	}

	private async removeProvidersExcept(names: string[]) {
		const keep = new Set(names);
		await Promise.all(
			this.providerRegistry
				.getNames()
				.filter((name) => !keep.has(name))
				.map(async (name) => await this.removeProvider(name)),
		);
	}

	/** Load the provider of a stored connection under its provider key. */
	async loadConnection(connection: SecretsProviderConnection) {
		let settings: IDataObject;
		try {
			settings = jsonParse<IDataObject>(await this.cipher.decryptV2(connection.encryptedSettings));
		} catch (error) {
			this.logger.error(
				`Could not read the settings of the connection "${connection.providerKey}"`,
				{ error: errorMessage(error) },
			);
			return undefined;
		}
		return await this.loadProvider(
			connection.providerKey,
			connection.type,
			{ connected: true, connectedAt: null, settings },
			true,
		);
	}

	/**
	 * Make a new provider of the type, initialize it, and, with `connect`, connect it and read its
	 * secrets. When the initialization fails, nothing changes. Then the new provider replaces the
	 * provider of the name, and the old one disconnects. Only a connected old provider stays when
	 * the new one cannot connect or read its secrets: the new one then tries again later, and takes
	 * the place of the old one when it is ready. Gives the new provider, or `undefined` when its
	 * initialization failed.
	 */
	async loadProvider(
		name: string,
		type: string,
		settings: SecretsProviderSettings,
		connect: boolean,
	): Promise<SecretsProvider | undefined> {
		await this.stopRetry(name);
		const provider = this.createProvider(type);
		if (!provider) {
			this.logger.error(`Unknown type "${type}" of the secrets provider "${name}"`);
			return undefined;
		}
		if (!(await this.providerLifecycle.initialize(provider, settings))) return undefined;
		const previous = this.providerRegistry.get(name);
		// A new name takes its place in the order of the registry now, before the connect.
		if (!previous) this.providerRegistry.set(name, provider);
		let ready = true;
		if (connect) {
			await provider.connect();
			ready = isConnected(provider) && (await this.providerLifecycle.refresh(provider));
		}
		if (!ready && previous && isConnected(previous)) {
			this.retryLater(name, provider);
			return provider;
		}
		this.providerRegistry.set(name, provider);
		if (previous && previous !== provider) await this.providerLifecycle.disconnect(previous);
		if (!ready) this.retryLater(name, provider);
		return provider;
	}

	/** Disconnect the provider of the name and forget it. */
	async removeProvider(name: string) {
		await this.stopRetry(name);
		const provider = this.providerRegistry.get(name);
		if (!provider) return;
		this.providerRegistry.remove(name);
		await this.providerLifecycle.disconnect(provider);
	}

	/** Stop the retries of the name. A provider that only waited for a retry disconnects. */
	private async stopRetry(name: string) {
		const retrying = this.providerLifecycle.getRetryingProvider(name);
		this.providerLifecycle.cancelRetry(name);
		if (retrying && retrying !== this.providerRegistry.get(name)) {
			await this.providerLifecycle.disconnect(retrying);
		}
	}

	/**
	 * Try a provider that failed again later: connect it when it is not connected, and read its
	 * secrets. A provider that is ready takes the place of the provider of the name.
	 */
	private retryLater(name: string, provider: SecretsProvider) {
		this.providerLifecycle.scheduleRetry(name, provider, async (retried) => {
			if (!isConnected(retried)) {
				await retried.connect();
				if (!isConnected(retried)) return false;
			}
			if (!(await this.providerLifecycle.refresh(retried))) return false;
			const current = this.providerRegistry.get(name);
			if (current !== retried) {
				this.providerRegistry.set(name, retried);
				if (current) await this.providerLifecycle.disconnect(current);
			}
			return true;
		});
	}

	// #endregion

	// #region Testing and reading the secrets

	/**
	 * Test settings with a new provider of the type: initialize it, connect it and run its test.
	 * Then it disconnects.
	 */
	async testProvider(type: string, settings: IDataObject): Promise<ProviderTestResult> {
		const provider = this.createProvider(type);
		if (!provider) return { success: false };
		const initialized = await this.providerLifecycle.initialize(provider, {
			connected: true,
			connectedAt: new Date(),
			settings,
		});
		if (!initialized) return { success: false };
		try {
			await provider.connect();
			if (!isConnected(provider)) {
				return { success: false, error: errorMessage(provider.connectError) };
			}
			const [success, error] = await provider.test();
			return { success, ...(error !== undefined && { error }) };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		} finally {
			await this.providerLifecycle.disconnect(provider);
		}
	}

	/**
	 * Read the secrets of the connected provider of the name again, and tell the other instances.
	 * `false` when the provider is not connected or the read fails.
	 */
	async syncProvider(name: string) {
		const provider = this.providerRegistry.get(name);
		if (!provider || !isConnected(provider)) return false;
		try {
			await provider.update();
		} catch (error) {
			this.logger.warn(`Could not read the secrets of the provider "${name}"`, {
				error: errorMessage(error),
			});
			return false;
		}
		await this.broadcastReload();
		this.eventService.emit('external-secrets-provider-reloaded', { vaultType: name });
		return true;
	}

	// #endregion

	// #region The interface of the secrets proxy

	getProvider(name: string) {
		return this.providerRegistry.get(name);
	}

	hasProvider(name: string) {
		return this.providerRegistry.has(name);
	}

	getProviderNames() {
		return this.providerRegistry.getNames();
	}

	getSecret(provider: string, name: string) {
		return this.providerRegistry.get(provider)?.getSecret(name);
	}

	hasSecret(provider: string, name: string) {
		return this.providerRegistry.get(provider)?.hasSecret(name) ?? false;
	}

	getSecretNames(provider: string) {
		return this.providerRegistry.get(provider)?.getSecretNames() ?? [];
	}

	// #endregion
}
