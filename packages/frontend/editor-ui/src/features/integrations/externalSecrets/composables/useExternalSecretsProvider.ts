/**
 * Fork code (not in upstream n8n): the settings of a provider type, as the settings page of
 * external secrets sends them, and the connection test. `../FORK.md` describes them.
 */
import type {
	ExternalSecretsProviderData,
	ExternalSecretsProviderProperty,
	ExternalSecretsProviderState,
} from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { NodeHelpers } from 'n8n-workflow';

import { useExternalSecretsStore } from '../externalSecrets.store';

/** Whether the `displayOptions` of a field show it for the given settings. */
export function isPropertyShown(
	property: ExternalSecretsProviderProperty,
	data: ExternalSecretsProviderData,
) {
	return NodeHelpers.displayParameter(data, property, null, null);
}

/** The settings that go to the server: only the values of the fields that the form shows. */
export function settingsToSend(
	properties: ExternalSecretsProviderProperty[],
	data: ExternalSecretsProviderData,
) {
	const settings: ExternalSecretsProviderData = {};
	for (const property of properties) {
		if (Object.hasOwn(data, property.name) && isPropertyShown(property, data)) {
			settings[property.name] = data[property.name];
		}
	}
	return settings;
}

export function useExternalSecretsProvider() {
	const externalSecretsStore = useExternalSecretsStore();
	const toast = useToast();
	const i18n = useI18n();

	/** Test settings and keep the result as the connection state of the provider type. */
	async function testConnection(
		name: string,
		settings: ExternalSecretsProviderData,
	): Promise<ExternalSecretsProviderState> {
		try {
			const { testState } = await externalSecretsStore.testProviderConnection(name, settings);
			externalSecretsStore.setConnectionState(name, testState);
			return testState;
		} catch (error) {
			toast.showError(error, i18n.baseText('error'));
			externalSecretsStore.setConnectionState(name, 'error');
			return 'error';
		}
	}

	return { testConnection };
}
