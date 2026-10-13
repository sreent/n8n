// Fork code (not in upstream n8n): a stand-in for the store of source control. It keeps the store
// ID and the members that ordinary code reads: the preferences (read-only branch, branch name and
// colour), the licence flag, and three requests. The fork has no source control backend; Git sync
// replaces it. See `FORK.md` in this folder.
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { EnterpriseEditionFeature } from '@/app/constants';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import * as api from './sourceControl.api';
import type { AutoPublishMode, SourceControlPreferences } from './sourceControl.types';

const defaultPreferences = (): SourceControlPreferences => ({
	branchName: '',
	branches: [],
	repositoryUrl: '',
	branchReadOnly: false,
	branchColor: '#5296D6',
	connected: false,
	publicKey: '',
	keyGeneratorType: 'ed25519',
	connectionType: 'ssh',
});

export const useSourceControlStore = defineStore('sourceControl', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	/** The licence flag. The value is `undefined` when the settings have no enterprise part. */
	const isEnterpriseSourceControlEnabled = computed(
		() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.SourceControl],
	);

	const preferences = ref<SourceControlPreferences>(defaultPreferences());

	function setPreferences(data: Partial<SourceControlPreferences>) {
		preferences.value = { ...preferences.value, ...data };
	}

	async function getPreferences() {
		setPreferences(await api.getPreferences(rootStore.restApiContext));
	}

	async function getRemoteWorkflow(workflowId: string) {
		return await api.getRemoteWorkflow(rootStore.restApiContext, workflowId);
	}

	/** Ordinary pages load their lists again after this action (`$onAction`). */
	async function pullWorkfolder(force: boolean, autoPublish?: AutoPublishMode) {
		return await api.pullWorkfolder(rootStore.restApiContext, { force, autoPublish });
	}

	return {
		isEnterpriseSourceControlEnabled,
		preferences,
		setPreferences,
		getPreferences,
		getRemoteWorkflow,
		pullWorkfolder,
	};
});
