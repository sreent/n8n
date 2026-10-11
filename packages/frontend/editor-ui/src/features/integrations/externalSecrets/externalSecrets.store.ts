/**
 * Fork code (not in upstream n8n): the store of external secrets. It replaces the enterprise
 * `externalSecrets.ee.store.ts` and keeps its store id, its state and its actions.
 * The FORK.md of this folder describes it.
 */
import type {
	ExternalSecretsProvider,
	ExternalSecretsProviderData,
	ExternalSecretsProviderState,
} from '@n8n/api-types';
import { hasScope } from '@n8n/permissions';
import {
	connectProvider,
	getExternalSecrets,
	getExternalSecretsProvider,
	getExternalSecretsProviders,
	getGlobalExternalSecrets,
	getGlobalExternalSecretsForProject,
	getProjectExternalSecrets,
	reloadProvider as reloadProviderSecrets,
	testExternalSecretsProviderConnection,
	updateProvider as updateProviderSettings,
} from '@n8n/rest-api-client/api/externalSecrets';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useUsersStore } from '@n8n/stores/users.store';
import { defineStore } from 'pinia';
import { computed, reactive } from 'vue';

import { EnterpriseEditionFeature } from '@/app/constants';
import { hasPermission } from '@/app/utils/rbac/permissions';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';

import type { SecretsTree } from './externalSecrets.types';

/** The text that the completions show in place of the value of a secret. */
const SECRET_PLACEHOLDER = '*********';

/** Set an own property, also for a key such as `__proto__`. */
function setOwn(tree: SecretsTree, key: string, value: SecretsTree | string) {
	Object.defineProperty(tree, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The secret names of one provider as a tree: `a.b` becomes `{ a: { b: '*********' } }`. A name
 * cannot continue below another name: for `a` and `a.b` this throws the same `TypeError` as a
 * property assignment to a string.
 */
function namesToTree(names: string[]) {
	const tree: SecretsTree = {};
	for (const name of names) {
		const path = name.split('.');
		let node: SecretsTree | string = tree;
		for (const [index, key] of path.entries()) {
			if (typeof node === 'string') {
				throw new TypeError(`Cannot create property '${key}' on string '${node}'`);
			}
			if (index === path.length - 1) {
				setOwn(node, key, SECRET_PLACEHOLDER);
				break;
			}
			let child: SecretsTree | string | undefined = Object.hasOwn(node, key)
				? node[key]
				: undefined;
			if (child === undefined) {
				child = {};
				setOwn(node, key, child);
			}
			node = child;
		}
	}
	return tree;
}

/** The secret names of each provider as a tree, by provider. */
function secretsToTree(secrets: Record<string, string[]>) {
	const tree: SecretsTree = {};
	for (const [provider, names] of Object.entries(secrets)) {
		setOwn(tree, provider, namesToTree(names));
	}
	return tree;
}

interface ExternalSecretsState {
	providers: ExternalSecretsProvider[];
	/** The secret names of the global connections, by provider key. */
	secrets: Record<string, string[]>;
	/** The secret names of the connections of a project, by provider key. */
	projectSecrets: Record<string, string[]>;
	connectionState: Record<string, ExternalSecretsProviderState>;
}

export const useExternalSecretsStore = defineStore('externalSecrets', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();
	const usersStore = useUsersStore();

	const state = reactive<ExternalSecretsState>({
		providers: [],
		secrets: {},
		projectSecrets: {},
		connectionState: {},
	});

	const isEnterpriseExternalSecretsEnabled = computed(
		() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.ExternalSecrets],
	);

	const secrets = computed(() => state.secrets);
	const providers = computed(() => state.providers);
	const connectionState = computed(() => state.connectionState);

	const globalSecretsAsObject = computed(() => secretsToTree(state.secrets));
	const projectSecretsAsObject = computed(() => secretsToTree(state.projectSecrets));
	/** The secrets of a project replace the global secrets of a provider with the same key. */
	const secretsAsObject = computed(() => ({
		...globalSecretsAsObject.value,
		...projectSecretsAsObject.value,
	}));

	/**
	 * The user may read the secret names of the project: with a global scope, or with a scope in
	 * the project. The current project gives the scopes of its own id, and the list of the projects
	 * of the user gives the scopes of the other projects.
	 */
	function canReadProjectSecrets(projectId: string) {
		if (hasPermission(['rbac'], { rbac: { scope: 'externalSecret:list' } })) return true;

		const projectsStore = useProjectsStore();
		const project =
			projectsStore.currentProject?.id === projectId
				? projectsStore.currentProject
				: projectsStore.myProjects.find(({ id }) => id === projectId);
		return hasScope('externalSecret:list', {
			global: usersStore.currentUser?.globalScopes ?? [],
			project: project?.scopes ?? [],
		});
	}

	/**
	 * Fetch the secret names of the global connections. With role-based access, the server gives
	 * only the secrets that the user may use in the project. A failed fetch clears the names.
	 */
	async function fetchGlobalSecrets(projectId?: string) {
		const moduleSettings = settingsStore.moduleSettings['external-secrets'];
		if (!moduleSettings) return;

		try {
			if (moduleSettings.roleBasedAccess) {
				if (!projectId) return;
				state.secrets = await getGlobalExternalSecretsForProject(
					rootStore.restApiContext,
					projectId,
				);
			} else if (moduleSettings.multipleConnections || moduleSettings.forProjects) {
				state.secrets = await getGlobalExternalSecrets(rootStore.restApiContext);
			} else {
				state.secrets = await getExternalSecrets(rootStore.restApiContext);
			}
		} catch {
			state.secrets = {};
		}
	}

	/** Fetch the secret names of the connections of a project. A failed fetch clears the names. */
	async function fetchProjectSecrets(projectId?: string) {
		if (!settingsStore.moduleSettings['external-secrets']?.forProjects) return;
		if (!projectId || !canReadProjectSecrets(projectId)) return;

		try {
			state.projectSecrets = await getProjectExternalSecrets(rootStore.restApiContext, projectId);
		} catch {
			state.projectSecrets = {};
		}
	}

	/** Fetch the global secret names and the secret names of the project at the same time. */
	async function fetchSecretsForProject(projectId?: string) {
		await Promise.all([fetchGlobalSecrets(projectId), fetchProjectSecrets(projectId)]);
	}

	async function getProviders() {
		state.providers = await getExternalSecretsProviders(rootStore.restApiContext);
	}

	/** Fetch one provider with the fields of its form, and keep it in the list. */
	async function getProvider(id: string) {
		const provider = await getExternalSecretsProvider(rootStore.restApiContext, id);

		const index = state.providers.findIndex(({ name }) => name === id);
		if (index === -1) {
			state.providers.push(provider);
		} else {
			state.providers[index] = provider;
		}

		return provider;
	}

	async function testProviderConnection(id: string, data: ExternalSecretsProviderData) {
		return await testExternalSecretsProviderConnection(rootStore.restApiContext, id, data);
	}

	/** Merge new values into a provider of the list. The provider must be in the list. */
	function updateStoredProvider(id: string, data: Partial<ExternalSecretsProvider>) {
		const index = state.providers.findIndex(({ name }) => name === id);
		const provider = state.providers[index];
		state.providers[index] = {
			...provider,
			...data,
			data: { ...provider.data, ...data.data },
		};
	}

	/** Store the settings of a provider. Only `data` goes to the server and into the list. */
	async function updateProvider(id: string, { data }: Partial<ExternalSecretsProvider>) {
		await updateProviderSettings(rootStore.restApiContext, id, data);
		updateStoredProvider(id, { data });
	}

	async function updateProviderConnected(id: string, value: boolean) {
		await connectProvider(rootStore.restApiContext, id, value);
		updateStoredProvider(id, { connected: value, state: value ? 'connected' : 'initializing' });
	}

	/** Read the secrets of a provider again. Returns whether the server read them. */
	async function reloadProvider(id: string) {
		const { updated } = await reloadProviderSecrets(rootStore.restApiContext, id);
		return updated;
	}

	function setConnectionState(id: string, connectionStateValue: ExternalSecretsProviderState) {
		state.connectionState[id] = connectionStateValue;
	}

	return {
		state,
		providers,
		secrets,
		connectionState,
		isEnterpriseExternalSecretsEnabled,
		globalSecretsAsObject,
		projectSecretsAsObject,
		secretsAsObject,
		fetchGlobalSecrets,
		fetchProjectSecrets,
		fetchSecretsForProject,
		getProvider,
		getProviders,
		testProviderConnection,
		updateProvider,
		updateProviderConnected,
		reloadProvider,
		setConnectionState,
		updateStoredProvider,
	};
});
