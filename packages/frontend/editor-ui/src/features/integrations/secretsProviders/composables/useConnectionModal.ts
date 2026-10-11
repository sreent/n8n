/**
 * Fork code (not in upstream n8n): the state and the actions of the connection modal of external
 * secrets. It keeps the name, the provider type and its settings, the projects that may use the
 * connection and the permissions of the user, and it saves the connection. `../FORK.md` describes
 * it.
 */
import {
	SECRETS_PROVIDER_KEY_REGEX,
	type ConnectionProjectSummary,
	type SecretProviderConnection,
	type SecretProviderTypeResponse,
} from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { ALL_SCOPES, getResourcePermissions, type Scope } from '@n8n/permissions';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import isEqual from 'lodash/isEqual';
import {
	NodeHelpers,
	type INodeParameters,
	type INodeProperties,
	type NodeParameterValueType,
} from 'n8n-workflow';
import { computed, ref, watch, type Ref } from 'vue';

import { useProjectsStore } from '@/features/collaboration/projects/projects.store';

import { useSecretsProviderConnection } from './useSecretsProviderConnection';

/** The role of the project that a connection belongs to. */
const OWNER_ROLE = 'secretsProviderConnection:owner';

const KNOWN_SCOPES: ReadonlySet<string> = new Set(ALL_SCOPES);

const isScope = (value: string): value is Scope => KNOWN_SCOPES.has(value);

type ConnectionModalOptions = {
	providerTypes: Ref<SecretProviderTypeResponse[]>;
	/** The connection to edit. Without one, the modal adds a connection. */
	providerKey?: string;
	/** The project whose settings opened the modal. */
	projectId?: string;
	/** The names that other connections use. */
	existingProviderNames: Ref<string[]>;
};

/** The value of a field that counts as filled. */
const isFilled = (value: unknown) => value !== undefined && value !== null && value !== '';

export function useConnectionModal(options: ConnectionModalOptions) {
	const { projectId } = options;
	const connection = useSecretsProviderConnection(projectId);
	const rbacStore = useRBACStore();
	const settingsStore = useSettingsStore();
	const projectsStore = useProjectsStore();
	const toast = useToast();
	const i18n = useI18n();

	const providerKey = ref(options.providerKey);
	const connectionName = ref('');
	const connectionNameBlurred = ref(false);
	const selectedProviderType = ref<SecretProviderTypeResponse>();
	const connectionSettings = ref<INodeParameters>({});
	const originalSettings = ref<INodeParameters>({});
	const connectionProjects = ref<ConnectionProjectSummary[]>([]);
	/** The scopes of the user for the connection, from the connections API of the project. */
	const connectionScopes = ref<Scope[]>();
	const providerSecretsCount = ref(0);
	const didSave = ref(false);
	const isSaving = ref(false);

	/** A connection that a project adds belongs to the project. Other connections start global. */
	const isSharedGlobally = ref(!projectId);
	const projectIds = ref<string[]>(projectId ? [projectId] : []);
	const originalScope = ref({ isSharedGlobally: !projectId, projectIds: [...projectIds.value] });

	const isEditMode = computed(() => !!providerKey.value);
	const isScopedMode = computed(() => !!projectId);

	// #region Permissions

	const connectionPermissions = computed(() =>
		connectionScopes.value
			? getResourcePermissions(connectionScopes.value).externalSecretsProvider
			: undefined,
	);

	/** In the settings of a project, the project manages only the connections that it owns. */
	const isOwnedByProject = computed(() =>
		connectionProjects.value.some(({ id, role }) => id === projectId && role === OWNER_ROLE),
	);

	const canCreate = computed(() => rbacStore.hasScope('externalSecretsProvider:create'));

	const canUpdate = computed(() =>
		isScopedMode.value
			? connectionPermissions.value?.update && isOwnedByProject.value
			: rbacStore.hasScope('externalSecretsProvider:update'),
	);

	const canDelete = computed(() =>
		isScopedMode.value
			? connectionPermissions.value?.delete && isOwnedByProject.value
			: rbacStore.hasScope('externalSecretsProvider:delete'),
	);

	/** The user may share connections with projects: the sharing tab shows. */
	const canShareGlobally = computed(
		() =>
			(settingsStore.moduleSettings['external-secrets']?.forProjects ?? false) &&
			rbacStore.hasScope('externalSecretsProvider:update'),
	);

	/** In the settings of a project, a connection that the project may not change is read-only. */
	const isReadOnly = computed(() => isEditMode.value && isScopedMode.value && !canUpdate.value);

	// #endregion

	// #region The name

	const connectionNameError = computed(() => {
		const name = connectionName.value;
		if (!name) {
			return i18n.baseText(
				'settings.secretsProviderConnections.modal.validation.connectionName.required',
			);
		}
		if (!SECRETS_PROVIDER_KEY_REGEX.test(name)) {
			return i18n.baseText(
				'settings.secretsProviderConnections.modal.validation.connectionName.format',
			);
		}
		if (!isEditMode.value && options.existingProviderNames.value.includes(name)) {
			return i18n.baseText('settings.secretsProviderConnections.modal.connectionName.unique');
		}
		return null;
	});

	const isValidName = computed(() => connectionNameError.value === null);

	// #endregion

	// #region The settings

	const properties = computed<INodeProperties[]>(
		() => selectedProviderType.value?.properties ?? [],
	);

	/** Whether the display options of a field show it for the current settings. */
	function shouldDisplayProperty(property: INodeProperties) {
		return NodeHelpers.displayParameter(connectionSettings.value, property, null, null);
	}

	/** The settings that go to the server: the values of the fields that the form shows. */
	const settingsToSend = computed(() => {
		const settings: INodeParameters = {};
		for (const property of properties.value) {
			if (property.type === 'notice' || !shouldDisplayProperty(property)) continue;
			if (Object.hasOwn(connectionSettings.value, property.name)) {
				settings[property.name] = connectionSettings.value[property.name];
			}
		}
		return settings;
	});

	const requiredValuesFilled = computed(() =>
		properties.value.every(
			(property) =>
				!property.required ||
				property.type === 'notice' ||
				!shouldDisplayProperty(property) ||
				isFilled(connectionSettings.value[property.name]),
		),
	);

	/** Select a provider type. Its settings start with the defaults of its fields. */
	function selectProviderType(type: string) {
		selectedProviderType.value = options.providerTypes.value.find(
			(providerType) => providerType.type === type,
		);
		const settings: INodeParameters = {};
		for (const property of properties.value) {
			if (property.type !== 'notice' && isFilled(property.default)) {
				settings[property.name] = property.default;
			}
		}
		connectionSettings.value = settings;
	}

	function updateSettings(name: string, value: NodeParameterValueType) {
		connectionSettings.value = { ...connectionSettings.value, [name]: value };
	}

	// #endregion

	// #region The projects

	const scopeUpdated = computed(
		() =>
			isSharedGlobally.value !== originalScope.value.isSharedGlobally ||
			!isEqual(projectIds.value, originalScope.value.projectIds),
	);

	/** Share the connection with all projects, or with the given projects. */
	function setScopeState(newProjectIds: string[], sharedGlobally: boolean) {
		projectIds.value = [...newProjectIds];
		isSharedGlobally.value = sharedGlobally;
	}

	/** The team projects of the store, which the connection may be shared with. */
	const projectOptions = computed(() =>
		projectsStore.projects.filter(({ type }) => type === 'team'),
	);

	/**
	 * As upstream n8n does, load the first project of the connection when the list of projects of
	 * the store does not have it. The scope select shows only the projects of the store. An error
	 * goes to the error handler of the app.
	 */
	watch(
		() => connectionProjects.value[0]?.id,
		async (id) => {
			if (!id || projectsStore.projects.some((project) => project.id === id)) return;
			await projectsStore.fetchProject(id);
		},
	);

	// #endregion

	const hasUnsavedChanges = computed(() => {
		if (!isEditMode.value) {
			return (
				connectionName.value !== '' ||
				selectedProviderType.value !== undefined ||
				scopeUpdated.value
			);
		}
		return !isEqual(connectionSettings.value, originalSettings.value) || scopeUpdated.value;
	});

	const canSave = computed(
		() =>
			!isSaving.value &&
			isValidName.value &&
			selectedProviderType.value !== undefined &&
			requiredValuesFilled.value &&
			hasUnsavedChanges.value &&
			(isEditMode.value ? !!canUpdate.value : canCreate.value),
	);

	const expressionExample = computed(() =>
		providerKey.value && isEditMode.value ? `{{ $secrets.${providerKey.value}.secret_name }}` : '',
	);

	/** Take the values of a connection from the server as the saved state. */
	function applyConnection(saved: SecretProviderConnection) {
		connectionProjects.value = saved.projects;
		providerSecretsCount.value = saved.secretsCount;
		if (saved.scopes) connectionScopes.value = saved.scopes.filter(isScope);
	}

	function keepSavedState() {
		originalSettings.value = { ...connectionSettings.value };
		originalScope.value = {
			isSharedGlobally: isSharedGlobally.value,
			projectIds: [...projectIds.value],
		};
	}

	/** Load the connection to edit, then test it when the user may change it. */
	async function loadConnection() {
		if (!providerKey.value) return;

		try {
			const loaded = await connection.getConnection(providerKey.value);
			connectionName.value = loaded.name;
			connectionNameBlurred.value = true;
			selectedProviderType.value = options.providerTypes.value.find(
				({ type }) => type === loaded.type,
			);
			connectionSettings.value = { ...loaded.settings };
			isSharedGlobally.value = loaded.projects.length === 0;
			projectIds.value = loaded.projects.map(({ id }) => id);
			applyConnection(loaded);
			keepSavedState();
			connection.setConnectionState(loaded.state);
		} catch (error) {
			toast.showError(error, i18n.baseText('generic.error'));
			return;
		}

		if (canUpdate.value) await connection.testConnection(providerKey.value);
	}

	/** Create or update the connection. A change of the settings tests the connection again. */
	async function saveConnection() {
		if (!canSave.value || !selectedProviderType.value) return false;

		isSaving.value = true;
		try {
			const settings = settingsToSend.value;
			const settingsChanged = !isEditMode.value || !isEqual(settings, originalSettings.value);
			if (isEditMode.value && providerKey.value) {
				const updated = await connection.updateConnection(
					providerKey.value,
					isScopedMode.value
						? { settings }
						: { isGlobal: isSharedGlobally.value, projectIds: projectIds.value, settings },
				);
				applyConnection(updated);
			} else {
				const created = await connection.createConnection({
					providerKey: connectionName.value,
					type: selectedProviderType.value.type,
					projectIds: projectIds.value,
					settings,
				});
				providerKey.value = created.name;
				applyConnection(created);
			}
			keepSavedState();
			didSave.value = true;
			if (settingsChanged && providerKey.value) {
				await connection.testConnection(providerKey.value);
			}
			return true;
		} catch (error) {
			toast.showError(error, i18n.baseText('generic.error'));
			return false;
		} finally {
			isSaving.value = false;
		}
	}

	return {
		canCreate,
		canDelete,
		canSave,
		canShareGlobally,
		canUpdate,
		connection,
		connectionName,
		connectionNameBlurred,
		connectionNameError,
		connectionProjects,
		connectionSettings,
		didSave,
		expressionExample,
		hasUnsavedChanges,
		isEditMode,
		isReadOnly,
		isSaving,
		isScopedMode,
		isSharedGlobally,
		isValidName,
		loadConnection,
		projectIds,
		projectOptions,
		properties,
		providerKey,
		providerSecretsCount,
		saveConnection,
		scopeUpdated,
		selectProviderType,
		selectedProviderType,
		setScopeState,
		shouldDisplayProperty,
		updateSettings,
	};
}
