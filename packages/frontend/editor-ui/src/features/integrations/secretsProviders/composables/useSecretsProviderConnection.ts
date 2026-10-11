/**
 * Fork code (not in upstream n8n): the requests for one connection of external secrets, and the
 * state of its last test. With a project id, the requests go to the connections of the project.
 * `../FORK.md` describes it.
 */
import type { SecretsProviderState } from '@n8n/api-types';
import {
	createProjectSecretProviderConnection,
	createSecretProviderConnection,
	enableSecretProviderConnection,
	getProjectSecretProviderConnectionByKey,
	getSecretProviderConnectionByKey,
	reloadSecretProviderConnection,
	testProjectSecretProviderConnection,
	testSecretProviderConnection,
	updateProjectSecretProviderConnection,
	updateSecretProviderConnection,
} from '@n8n/rest-api-client';
import { useRootStore } from '@n8n/stores/useRootStore';
import { ref } from 'vue';

/** The body of a create, as the connection modal sends it. */
type CreateConnection = Parameters<typeof createSecretProviderConnection>[1];

/** The body of an update. */
type UpdateConnection = Parameters<typeof updateSecretProviderConnection>[2];

export function useSecretsProviderConnection(projectId?: string) {
	const rootStore = useRootStore();

	const connectionState = ref<SecretsProviderState>('initializing');
	const connectionError = ref<string>();
	const isLoading = ref(false);
	const isTesting = ref(false);

	async function getConnection(providerKey: string) {
		isLoading.value = true;
		try {
			return projectId
				? await getProjectSecretProviderConnectionByKey(
						rootStore.restApiContext,
						projectId,
						providerKey,
					)
				: await getSecretProviderConnectionByKey(rootStore.restApiContext, providerKey);
		} finally {
			isLoading.value = false;
		}
	}

	/**
	 * Create a connection. The settings page of the instance marks the connection as global. A
	 * project owns the connections that it creates.
	 */
	async function createConnection(data: CreateConnection) {
		if (!projectId) {
			return await createSecretProviderConnection(rootStore.restApiContext, {
				...data,
				isGlobal: true,
			});
		}

		const { providerKey, type, settings } = data;
		return await createProjectSecretProviderConnection(rootStore.restApiContext, projectId, {
			providerKey,
			type,
			settings,
			projectIds: [projectId],
		});
	}

	async function updateConnection(providerKey: string, data: UpdateConnection) {
		return projectId
			? await updateProjectSecretProviderConnection(
					rootStore.restApiContext,
					projectId,
					providerKey,
					data,
				)
			: await updateSecretProviderConnection(rootStore.restApiContext, providerKey, data);
	}

	/**
	 * Test the stored settings of the connection, and keep the result as the connection state. A
	 * failed request counts as an error and keeps the last error message.
	 */
	async function testConnection(providerKey: string) {
		isTesting.value = true;
		try {
			const result = projectId
				? await testProjectSecretProviderConnection(
						rootStore.restApiContext,
						projectId,
						providerKey,
					)
				: await testSecretProviderConnection(rootStore.restApiContext, providerKey);
			// The test state of the server decides: a tested connection counts as connected.
			connectionState.value = result.testState === 'error' ? 'error' : 'connected';
			connectionError.value = result.error;
		} catch {
			connectionState.value = 'error';
		} finally {
			isTesting.value = false;
		}
		return connectionState.value;
	}

	/** Read the secrets of the connection again. The instance API does this for all users. */
	async function reloadConnection(providerKey: string) {
		return await reloadSecretProviderConnection(rootStore.restApiContext, providerKey);
	}

	async function activateConnection(providerKey: string) {
		return await enableSecretProviderConnection(rootStore.restApiContext, providerKey);
	}

	function setConnectionState(state: SecretsProviderState) {
		connectionState.value = state;
	}

	return {
		activateConnection,
		connectionError,
		connectionState,
		createConnection,
		getConnection,
		isLoading,
		isTesting,
		reloadConnection,
		setConnectionState,
		testConnection,
		updateConnection,
	};
}
