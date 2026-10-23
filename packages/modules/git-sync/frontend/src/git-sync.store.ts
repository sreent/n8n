import {
	GIT_SYNC_DEFAULT_AUTHOR_NAME,
	GIT_SYNC_DEFAULT_DIRECTORY,
	GIT_SYNC_DEFAULT_USERNAME,
	type GitSyncConnectionTestResult,
	type GitSyncProjectOption,
	type GitSyncPullResult,
	type GitSyncPushResult,
	type GitSyncSettingsResponse,
	type GitSyncStatus,
} from '@n8n/api-types';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
	deleteGitSyncSettings,
	getGitSyncProjects,
	getGitSyncSettings,
	getGitSyncStatus,
	pullFromGit,
	pushToGit,
	saveGitSyncSettings,
	testGitSyncConnection,
	type GitSyncSettingsForm,
} from './git-sync.api';
import { GIT_SYNC_STORE } from './git-sync.constants';

export function emptyForm(authorEmail = ''): GitSyncSettingsForm {
	return {
		repositoryUrl: '',
		branch: 'main',
		directory: GIT_SYNC_DEFAULT_DIRECTORY,
		projectId: '',
		username: GIT_SYNC_DEFAULT_USERNAME,
		accessToken: '',
		authorName: GIT_SYNC_DEFAULT_AUTHOR_NAME,
		authorEmail,
		credentialMatchingMode: 'name-and-type',
	};
}

function toForm(settings: GitSyncSettingsResponse): GitSyncSettingsForm {
	const { projectName: _projectName, ...form } = settings;
	return form;
}

export const useGitSyncStore = defineStore(GIT_SYNC_STORE, () => {
	const rootStore = useRootStore();

	const settings = ref<GitSyncSettingsResponse | null>(null);
	const form = ref<GitSyncSettingsForm>(emptyForm());
	const projects = ref<GitSyncProjectOption[]>([]);
	const status = ref<GitSyncStatus | null>(null);
	const testResult = ref<GitSyncConnectionTestResult | null>(null);
	const lastPushResult = ref<GitSyncPushResult | null>(null);
	const lastPullResult = ref<GitSyncPullResult | null>(null);

	const loading = ref(true);
	const saving = ref(false);
	const testing = ref(false);
	const loadingStatus = ref(false);
	const pushing = ref(false);
	const pulling = ref(false);

	const isConnected = computed(() => settings.value !== null);
	const isBusy = computed(
		() => saving.value || loadingStatus.value || pushing.value || pulling.value,
	);
	const isDirty = computed(() => {
		const saved = settings.value ? toForm(settings.value) : emptyForm(form.value.authorEmail);
		return JSON.stringify(form.value) !== JSON.stringify(saved);
	});
	const canSave = computed(
		() =>
			form.value.repositoryUrl.trim() !== '' &&
			form.value.branch.trim() !== '' &&
			form.value.authorEmail.trim() !== '',
	);

	async function fetchSettings(defaultAuthorEmail = ''): Promise<void> {
		loading.value = true;
		try {
			settings.value = await getGitSyncSettings(rootStore.restApiContext);
			form.value = settings.value ? toForm(settings.value) : emptyForm(defaultAuthorEmail);
		} finally {
			loading.value = false;
		}
	}

	async function fetchProjects(search?: string): Promise<void> {
		projects.value = await getGitSyncProjects(rootStore.restApiContext, search);
	}

	async function saveSettings(): Promise<void> {
		saving.value = true;
		try {
			settings.value = await saveGitSyncSettings(rootStore.restApiContext, form.value);
			form.value = toForm(settings.value);
			status.value = null;
		} finally {
			saving.value = false;
		}
	}

	function discardChanges(): void {
		form.value = settings.value ? toForm(settings.value) : emptyForm(form.value.authorEmail);
		testResult.value = null;
	}

	async function disconnect(): Promise<void> {
		saving.value = true;
		try {
			await deleteGitSyncSettings(rootStore.restApiContext);
			settings.value = null;
			status.value = null;
			lastPushResult.value = null;
			lastPullResult.value = null;
			form.value = emptyForm(form.value.authorEmail);
		} finally {
			saving.value = false;
		}
	}

	async function testConnection(): Promise<GitSyncConnectionTestResult> {
		testing.value = true;
		testResult.value = null;
		try {
			testResult.value = await testGitSyncConnection(rootStore.restApiContext, form.value);
			return testResult.value;
		} finally {
			testing.value = false;
		}
	}

	async function fetchStatus(): Promise<void> {
		loadingStatus.value = true;
		try {
			status.value = await getGitSyncStatus(rootStore.restApiContext);
		} finally {
			loadingStatus.value = false;
		}
	}

	async function push(message: string, replaceRemoteContent = false): Promise<GitSyncPushResult> {
		pushing.value = true;
		try {
			lastPushResult.value = await pushToGit(rootStore.restApiContext, {
				message,
				replaceRemoteContent,
			});
			return lastPushResult.value;
		} finally {
			pushing.value = false;
		}
	}

	async function pull(overwriteLocalChanges = false, full = false): Promise<GitSyncPullResult> {
		pulling.value = true;
		try {
			lastPullResult.value = await pullFromGit(rootStore.restApiContext, {
				overwriteLocalChanges,
				full,
			});
			return lastPullResult.value;
		} finally {
			pulling.value = false;
		}
	}

	return {
		settings,
		form,
		projects,
		status,
		testResult,
		lastPushResult,
		lastPullResult,
		loading,
		saving,
		testing,
		loadingStatus,
		pushing,
		pulling,
		isConnected,
		isBusy,
		isDirty,
		canSave,
		fetchSettings,
		fetchProjects,
		saveSettings,
		discardChanges,
		disconnect,
		testConnection,
		fetchStatus,
		push,
		pull,
	};
});
