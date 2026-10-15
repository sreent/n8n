// Fork code (not in upstream n8n): the store of source control. It keeps the preferences of the
// connection to a Git repository, and makes the requests of the settings page and of the push and
// pull modals. See `FORK.md` in this folder.
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { EnterpriseEditionFeature } from '@/app/constants';
import { defineStore } from 'pinia';
import { computed, reactive } from 'vue';

import * as api from './sourceControl.api';
import type {
	AutoPublishMode,
	PushWorkfolderData,
	SourceControlPreferences,
	SourceControlPreferencesUpdate,
	SourceControlStatusOptions,
	SshKeyTypes,
} from './sourceControl.types';

const DEFAULT_BRANCH_COLOR = '#5296D6';

const SSH_KEY_TYPES: SshKeyTypes[] = ['ed25519', 'rsa'];

export const useSourceControlStore = defineStore('sourceControl', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	/** The licence flag. The value is `undefined` when the settings have no enterprise part. */
	const isEnterpriseSourceControlEnabled = computed(
		() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.SourceControl],
	);

	const sshKeyTypesWithLabel = reactive(
		SSH_KEY_TYPES.map((value) => ({ value, label: value.toUpperCase() })),
	);

	const preferences = reactive<SourceControlPreferences>({
		branchName: '',
		branches: [],
		repositoryUrl: '',
		branchReadOnly: false,
		branchColor: DEFAULT_BRANCH_COLOR,
		connected: false,
		publicKey: '',
		keyGeneratorType: 'ed25519',
		connectionType: 'ssh',
	});

	/** The last commit message of a push. */
	const state = reactive({ commitMessage: 'commit message' });

	function setPreferences(data: Partial<SourceControlPreferences>) {
		Object.assign(preferences, data);
	}

	async function pushWorkfolder(data: PushWorkfolderData) {
		state.commitMessage = data.commitMessage ?? state.commitMessage;
		return await api.pushWorkfolder(rootStore.restApiContext, data);
	}

	/** Ordinary pages load their lists again after this action (`$onAction`). */
	async function pullWorkfolder(force: boolean, autoPublish?: AutoPublishMode) {
		return await api.pullWorkfolder(rootStore.restApiContext, { force, autoPublish });
	}

	async function getBranches() {
		setPreferences(await api.getBranches(rootStore.restApiContext));
	}

	async function getPreferences() {
		setPreferences(await api.getPreferences(rootStore.restApiContext));
	}

	async function savePreferences(data: SourceControlPreferencesUpdate) {
		setPreferences(await api.savePreferences(rootStore.restApiContext, data));
	}

	async function updatePreferences(data: SourceControlPreferencesUpdate) {
		setPreferences(await api.updatePreferences(rootStore.restApiContext, data));
	}

	/** Disconnects the instance. The repository URL and the key pair stay in the store. */
	async function disconnect(keepKeyPair: boolean) {
		await api.disconnect(rootStore.restApiContext, keepKeyPair);
		setPreferences({
			branches: [],
			branchName: '',
			currentBranch: '',
			connected: false,
			branchReadOnly: false,
			branchColor: DEFAULT_BRANCH_COLOR,
		});
	}

	/** Makes a new key pair, and reads the new public key from the preferences. */
	async function generateKeyPair(keyGeneratorType?: SshKeyTypes) {
		await api.generateKeyPair(rootStore.restApiContext, keyGeneratorType);
		const data = await api.getPreferences(rootStore.restApiContext);
		preferences.publicKey = data.publicKey;
		return { publicKey: data.publicKey };
	}

	async function getStatus() {
		return await api.getStatus(rootStore.restApiContext);
	}

	async function getAggregatedStatus(options?: SourceControlStatusOptions) {
		return await api.getAggregatedStatus(rootStore.restApiContext, options);
	}

	async function getRemoteWorkflow(workflowId: string) {
		return await api.getRemoteWorkflow(rootStore.restApiContext, workflowId);
	}

	return {
		isEnterpriseSourceControlEnabled,
		state,
		preferences,
		pushWorkfolder,
		pullWorkfolder,
		savePreferences,
		setPreferences,
		generateKeyPair,
		getBranches,
		getPreferences,
		disconnect,
		getStatus,
		getAggregatedStatus,
		sshKeyTypesWithLabel,
		getRemoteWorkflow,
		updatePreferences,
	};
});
