import { EventService, RoleService } from '@n8n/backend-services';
import { SettingsRepository } from '@n8n/db';
import { Container, Service } from '@n8n/di';
import { UnexpectedError } from '@n8n/errors';
import { EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING } from '@n8n/permissions';
import type { IDataObject } from 'n8n-workflow';

import { ExternalSecretsManager } from './external-secrets-manager';
import { ExternalSecretsProviderRegistry } from './provider-registry.service';
import { mergeBlankedValues, redactSettings } from './redaction';
import { ExternalSecretsSettingsStore } from './settings-store.service';
import type { ProviderTestResult, SecretsProvider, SecretsProviderSettings } from './types';

/**
 * Fork code (not in upstream n8n). The settings API of external secrets (`/external-secrets`):
 * one stored setting for each provider type, and the setting of the system roles. The manager
 * comes from the container at each call, because tests replace it.
 */
@Service()
export class ExternalSecretsService {
	constructor(
		private readonly settingsStore: ExternalSecretsSettingsStore,
		private readonly registry: ExternalSecretsProviderRegistry,
		private readonly eventService: EventService,
		private readonly settingsRepository: SettingsRepository,
		private readonly roleService: RoleService,
	) {}

	private get manager() {
		return Container.get(ExternalSecretsManager);
	}

	hasProviderType(name: string) {
		return this.manager.hasProviderType(name);
	}

	/**
	 * The registered provider of the type, or a new one to show the fields of its form. The routes
	 * check the type first.
	 */
	private providerToShow(name: string) {
		const provider = this.registry.get(name) ?? this.manager.createProvider(name);
		if (!provider) throw new UnexpectedError(`Unknown provider type "${name}"`);
		return provider;
	}

	/** Each provider type, with its stored settings (passwords blanked) and its state. */
	async getProviders() {
		const settings = (await this.settingsStore.reload()) ?? {};
		return this.manager.getProviderTypes().map((name) => {
			const provider = this.providerToShow(name);
			const stored = settings[name];
			return {
				connected: stored?.connected ?? false,
				connectedAt: stored?.connectedAt,
				data: redactSettings(stored?.settings ?? {}, provider.properties),
				displayName: provider.displayName,
				icon: name,
				name,
				state: provider.state,
			};
		});
	}

	/** One provider type, with the fields of its form. */
	async getProvider(name: string) {
		const settings = (await this.settingsStore.reload()) ?? {};
		const provider = this.providerToShow(name);
		const stored = settings[name];
		return {
			connected: stored?.connected,
			connectedAt: stored?.connectedAt,
			data: redactSettings(stored?.settings ?? {}, provider.properties),
			displayName: provider.displayName,
			icon: name,
			name,
			properties: provider.properties,
			state: provider.state,
		};
	}

	/**
	 * Store new settings of a provider type, and load its provider with them. A blanked value keeps
	 * the stored value. The provider tests the settings for the event.
	 */
	async saveProviderSettings(name: string, data: IDataObject, userId: string) {
		const settings = (await this.settingsStore.reload()) ?? {};
		const stored = settings[name];
		const merged = mergeBlankedValues(data, stored?.settings);
		const providerSettings: SecretsProviderSettings = stored
			? { ...stored, settings: merged }
			: { connected: false, connectedAt: null, settings: merged };
		settings[name] = providerSettings;
		await this.settingsStore.save(settings);
		const provider = await this.manager.loadProvider(
			name,
			name,
			providerSettings,
			Boolean(providerSettings.connected),
		);
		const [isValid, errorMessage] = provider ? await this.testLoadedProvider(provider) : [false];
		await this.manager.broadcastReload();
		this.eventService.emit('external-secrets-provider-settings-saved', {
			userId,
			vaultType: name,
			isNew: !stored,
			isValid,
			...(errorMessage !== undefined && { errorMessage }),
		});
	}

	private async testLoadedProvider(
		provider: SecretsProvider,
	): Promise<[boolean] | [boolean, string]> {
		try {
			return await provider.test();
		} catch {
			return [false];
		}
	}

	/** Store whether the provider is connected, and connect or disconnect it. */
	async setProviderConnected(name: string, connected: unknown) {
		const settings = (await this.settingsStore.reload()) ?? {};
		const providerSettings = {
			...(settings[name] ?? { connectedAt: null, settings: {} }),
			connected,
		} as SecretsProviderSettings;
		settings[name] = providerSettings;
		await this.settingsStore.save(settings);
		if (connected) await this.manager.loadProvider(name, name, providerSettings, true);
		else await this.manager.removeProvider(name);
		await this.manager.broadcastReload();
	}

	/** Test settings of a provider type. A blanked value takes the stored value. */
	async testProviderSettings(name: string, data: IDataObject): Promise<ProviderTestResult> {
		const settings = (await this.settingsStore.reload()) ?? {};
		const merged = mergeBlankedValues(data, settings[name]?.settings);
		return await this.manager.testProvider(name, merged);
	}

	/** Read the secrets of the connected provider again. `false` when that is not possible. */
	async updateProvider(name: string) {
		return await this.manager.syncProvider(name);
	}

	/** The names of the secrets of each provider. */
	getSecretNames() {
		return Object.fromEntries(
			this.registry.entries().map(([name, provider]) => [name, provider.getSecretNames()]),
		);
	}

	/** Whether the project roles get the scopes of external secrets. */
	async getSystemRolesEnabled() {
		const row = await this.settingsRepository.findByKey(
			EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING.key,
		);
		return row?.value === 'true';
	}

	/** Give the project admin and editor roles the scopes of external secrets, or take them away. */
	async setSystemRolesEnabled(enabled: boolean, userId: string) {
		await this.settingsRepository.upsert(
			{
				key: EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING.key,
				value: String(enabled),
				loadOnStartup: true,
			},
			['key'],
		);
		for (const [roleSlug, scopes] of Object.entries(
			EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING.roleScopeMap,
		)) {
			if (enabled) await this.roleService.addScopesToRole(roleSlug, scopes);
			else await this.roleService.removeScopesFromRole(roleSlug, scopes);
		}
		this.eventService.emit('external-secrets-system-roles-toggled', { enabled, userId });
	}
}
