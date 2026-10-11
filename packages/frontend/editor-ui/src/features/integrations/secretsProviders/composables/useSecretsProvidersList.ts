/**
 * Fork code (not in upstream n8n): the provider types and the connections of the instance, for the
 * settings page of the connections and the settings of a project. `../FORK.md` describes it.
 */
import type { SecretProviderConnection, SecretProviderTypeResponse } from '@n8n/api-types';
import {
	getSecretProviderConnectionByKey,
	getSecretProviderConnections,
	getSecretProviderTypes,
} from '@n8n/rest-api-client';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, ref } from 'vue';

import { useExternalSecretsStore } from '@/features/integrations/externalSecrets/externalSecrets.store';

export function useSecretsProvidersList() {
	const rootStore = useRootStore();
	const rbacStore = useRBACStore();
	const externalSecretsStore = useExternalSecretsStore();

	const types = ref<SecretProviderTypeResponse[]>([]);
	const connections = ref<SecretProviderConnection[]>([]);
	const isLoadingTypes = ref(false);
	const isLoadingConnections = ref(false);

	const canList = computed(() => rbacStore.hasScope('externalSecretsProvider:list'));
	const canCreate = computed(() => rbacStore.hasScope('externalSecretsProvider:create'));
	const canUpdate = computed(() => rbacStore.hasScope('externalSecretsProvider:update'));

	const isEnterpriseExternalSecretsEnabled = computed(
		() => externalSecretsStore.isEnterpriseExternalSecretsEnabled,
	);

	const providerTypes = computed(() => types.value);

	/** The connections by name, from the last name to the first. */
	const activeProviders = computed(() =>
		[...connections.value].sort((a, b) => b.name.localeCompare(a.name)),
	);

	/** The secrets of the connections. The page does not fill them. */
	const secrets = ref<Record<string, string[]>>({});

	const isLoading = computed(() => isLoadingTypes.value || isLoadingConnections.value);

	async function fetchProviderTypes() {
		isLoadingTypes.value = true;
		try {
			types.value = await getSecretProviderTypes(rootStore.restApiContext);
		} finally {
			isLoadingTypes.value = false;
		}
	}

	/** Fetch the connections, when the user may list them. A failed fetch keeps the list. */
	async function fetchActiveConnections() {
		if (!canList.value) return;

		isLoadingConnections.value = true;
		try {
			connections.value = await getSecretProviderConnections(rootStore.restApiContext);
		} catch {
			// The page shows the connections that it has.
		} finally {
			isLoadingConnections.value = false;
		}
	}

	/** Fetch one connection with its settings and its secrets, in place of its list item. */
	async function fetchConnection(providerKey: string) {
		const connection = await getSecretProviderConnectionByKey(
			rootStore.restApiContext,
			providerKey,
		);
		const index = connections.value.findIndex(({ name }) => name === providerKey);
		if (index !== -1) connections.value[index] = connection;
	}

	return {
		activeProviders,
		canCreate,
		canUpdate,
		fetchActiveConnections,
		fetchConnection,
		fetchProviderTypes,
		isEnterpriseExternalSecretsEnabled,
		isLoading,
		providerTypes,
		secrets,
	};
}
