<script setup lang="ts">
import {
	GIT_SYNC_ERROR_CODES,
	type GitSyncPullResult,
	type GitSyncWorkflowChange,
} from '@n8n/api-types';
import { useDocumentTitle } from '@n8n/composables/useDocumentTitle';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nAlertDialog,
	N8nBadge,
	N8nButton,
	N8nCallout,
	N8nCheckbox,
	N8nDialog,
	N8nDialogBody,
	N8nDialogClose,
	N8nDialogDescription,
	N8nDialogFooter,
	N8nIcon,
	N8nInput,
	N8nOption,
	N8nSelect,
	N8nSettingsLayout,
	N8nSettingsPageHeader,
	N8nSettingsRow,
	N8nSettingsRowGroup,
	N8nSettingsSaveBar,
	N8nSettingsSection,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';
import { computed, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, type NavigationGuardNext } from 'vue-router';

import GitSyncChangeList from './components/GitSyncChangeList.vue';
import { useGitSyncStore } from './git-sync.store';
import { errorCode, errorConflicts } from './git-sync.utils';

const i18n = useI18n();
const toast = useToast();
const documentTitle = useDocumentTitle({
	releaseChannel: useSettingsStore().settings.releaseChannel,
});
const usersStore = useUsersStore();
const gitSyncStore = useGitSyncStore();

const commitMessage = ref('');
const replaceRemoteContent = ref(false);
const fullPull = ref(false);
const loadingProjects = ref(false);
const showDisconnectDialog = ref(false);
const showReplaceDialog = ref(false);
const pullConflicts = ref<GitSyncWorkflowChange[]>([]);
const showConflictDialog = ref(false);
const showUnsavedChangesDialog = ref(false);
const pendingNext = ref<NavigationGuardNext | null>(null);

// ── Connection form ───────────────────────────────────────────────────────

const hasStoredToken = computed(
	() => gitSyncStore.settings?.accessToken === CREDENTIAL_BLANKING_VALUE,
);
const tokenWillBeRemoved = computed(
	() => hasStoredToken.value && gitSyncStore.form.accessToken === '',
);
// The input never shows the blanking value. An empty input keeps the stored token.
const tokenInputValue = computed(() =>
	gitSyncStore.form.accessToken === CREDENTIAL_BLANKING_VALUE ? '' : gitSyncStore.form.accessToken,
);
const tokenPlaceholder = computed(() =>
	hasStoredToken.value
		? i18n.baseText('settings.gitSync.accessToken.storedPlaceholder')
		: i18n.baseText('settings.gitSync.accessToken.placeholder'),
);

function onTokenInput(value: string) {
	gitSyncStore.form.accessToken =
		value === '' && hasStoredToken.value ? CREDENTIAL_BLANKING_VALUE : value;
}

function removeToken() {
	gitSyncStore.form.accessToken = '';
}

const projectOptions = computed(() => {
	const options = [...gitSyncStore.projects];
	const saved = gitSyncStore.settings;
	if (saved && !options.some(({ id }) => id === saved.projectId)) {
		options.unshift({ id: saved.projectId, name: saved.projectName ?? saved.projectId, type: '' });
	}
	return options;
});

async function searchProjects(search: string) {
	loadingProjects.value = true;
	try {
		await gitSyncStore.fetchProjects(search || undefined);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.gitSync.project.error'));
	} finally {
		loadingProjects.value = false;
	}
}

function onProjectChange(value: unknown) {
	gitSyncStore.form.projectId = typeof value === 'string' ? value : '';
}

function onCredentialMatchingChange(value: unknown) {
	if (value === 'name-and-type' || value === 'id-only') {
		gitSyncStore.form.credentialMatchingMode = value;
	}
}

const testDescription = computed(() => {
	const result = gitSyncStore.testResult;
	if (!result) return i18n.baseText('settings.gitSync.test.description');
	return i18n.baseText(
		result.branchExists
			? 'settings.gitSync.test.success'
			: 'settings.gitSync.test.successNewBranch',
		{ interpolate: { branch: gitSyncStore.form.branch } },
	);
});

async function onTestConnection() {
	try {
		await gitSyncStore.testConnection();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.gitSync.test.error'));
	}
}

// A new test result belongs to the settings it tested.
watch(
	() => [gitSyncStore.form.repositoryUrl, gitSyncStore.form.branch, gitSyncStore.form.accessToken],
	() => {
		gitSyncStore.testResult = null;
	},
);

async function save(): Promise<boolean> {
	try {
		await gitSyncStore.saveSettings();
		toast.showMessage({ title: i18n.baseText('settings.gitSync.saved'), type: 'success' });
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.gitSync.saveError'));
		return false;
	}
	await refreshStatus();
	return true;
}

// ── Unsaved changes ───────────────────────────────────────────────────────

onBeforeRouteLeave((_to, _from, next) => {
	if (!gitSyncStore.isDirty) {
		next();
		return;
	}
	pendingNext.value = next;
	showUnsavedChangesDialog.value = true;
});

function onLeaveWithoutSaving() {
	showUnsavedChangesDialog.value = false;
	pendingNext.value?.();
	pendingNext.value = null;
}

async function onSaveAndLeave() {
	const saved = await save();
	if (!saved) return;
	showUnsavedChangesDialog.value = false;
	pendingNext.value?.();
	pendingNext.value = null;
}

function onKeepEditing() {
	showUnsavedChangesDialog.value = false;
	pendingNext.value?.(false);
	pendingNext.value = null;
}

function onUnsavedChangesDialogOpen(open: boolean) {
	if (!open) onKeepEditing();
}

async function disconnect(): Promise<void> {
	try {
		await gitSyncStore.disconnect();
		showDisconnectDialog.value = false;
		toast.showMessage({
			title: i18n.baseText('settings.gitSync.disconnect.success'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.gitSync.disconnect.error'));
	}
}

// ── Status ────────────────────────────────────────────────────────────────

const shortCommit = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : '');
const formatDate = (value: string) => new Date(value).toLocaleString();

async function refreshStatus(): Promise<void> {
	if (!gitSyncStore.isConnected) return;
	try {
		await gitSyncStore.fetchStatus();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.gitSync.status.error'));
	}
}

// ── Push ──────────────────────────────────────────────────────────────────

const canPush = computed(
	() => commitMessage.value.trim() !== '' && !gitSyncStore.isBusy && !gitSyncStore.isDirty,
);

function onPushClick() {
	if (replaceRemoteContent.value) {
		showReplaceDialog.value = true;
		return;
	}
	void push();
}

async function push(): Promise<void> {
	showReplaceDialog.value = false;
	try {
		const result = await gitSyncStore.push(commitMessage.value.trim(), replaceRemoteContent.value);
		if (result.result === 'pushed') {
			toast.showMessage({
				title: i18n.baseText('settings.gitSync.push.success', {
					adjustToNumber: result.changedFiles,
					interpolate: { count: String(result.changedFiles) },
				}),
				type: 'success',
			});
			commitMessage.value = '';
		} else {
			toast.showMessage({ title: i18n.baseText('settings.gitSync.push.upToDate'), type: 'info' });
		}
		replaceRemoteContent.value = false;
	} catch (error) {
		toast.showError(
			error,
			errorCode(error) === GIT_SYNC_ERROR_CODES.pullFirst
				? i18n.baseText('settings.gitSync.push.pullFirst')
				: i18n.baseText('settings.gitSync.push.error'),
		);
	}
	await refreshStatus();
}

// ── Pull ──────────────────────────────────────────────────────────────────

const pullResultLines = computed(() => {
	const result: GitSyncPullResult | null = gitSyncStore.lastPullResult;
	if (!result) return [];
	if (result.result === 'no-remote-branch' || result.result === 'no-package') return [];

	const names = (items: Array<{ name: string }>) => items.map(({ name }) => name).join(', ');
	const lines: Array<{ key: string; text: string; theme: 'info' | 'warning' }> = [];
	if (result.result === 'pulled') {
		if (result.created.length > 0) {
			lines.push({
				key: 'created',
				theme: 'info',
				text: i18n.baseText('settings.gitSync.pull.result.created', {
					interpolate: { names: result.created.join(', ') },
				}),
			});
		}
		if (result.updated.length > 0) {
			lines.push({
				key: 'updated',
				theme: 'info',
				text: i18n.baseText('settings.gitSync.pull.result.updated', {
					interpolate: { names: result.updated.join(', ') },
				}),
			});
		}
		if (result.stubbedCredentials.length > 0) {
			lines.push({
				key: 'stubbed',
				theme: 'warning',
				text: i18n.baseText('settings.gitSync.pull.result.stubbedCredentials', {
					interpolate: { names: result.stubbedCredentials.join(', ') },
				}),
			});
		}
		if (result.publishingBlocked.length > 0) {
			lines.push({
				key: 'blocked',
				theme: 'warning',
				text: i18n.baseText('settings.gitSync.pull.result.publishingBlocked', {
					interpolate: { names: result.publishingBlocked.join(', ') },
				}),
			});
		}
	}
	if (result.removedUpstream.length > 0) {
		lines.push({
			key: 'removed',
			theme: 'warning',
			text: i18n.baseText('settings.gitSync.pull.result.removedUpstream', {
				interpolate: { names: names(result.removedUpstream) },
			}),
		});
	}
	return lines;
});

function pullMessage(result: GitSyncPullResult): string {
	switch (result.result) {
		case 'pulled':
			return i18n.baseText('settings.gitSync.pull.success');
		case 'up-to-date':
			return i18n.baseText('settings.gitSync.pull.upToDate');
		case 'no-remote-branch':
			return i18n.baseText('settings.gitSync.pull.noRemoteBranch');
		case 'no-package':
			return i18n.baseText('settings.gitSync.pull.noPackage');
	}
}

async function pull(overwriteLocalChanges = false): Promise<void> {
	showConflictDialog.value = false;
	try {
		const result = await gitSyncStore.pull(overwriteLocalChanges, fullPull.value);
		toast.showMessage({
			title: pullMessage(result),
			type: result.result === 'pulled' ? 'success' : 'info',
		});
		fullPull.value = false;
	} catch (error) {
		if (errorCode(error) === GIT_SYNC_ERROR_CODES.localChanges) {
			pullConflicts.value = errorConflicts(error);
			showConflictDialog.value = true;
			return;
		}
		toast.showError(error, i18n.baseText('settings.gitSync.pull.error'));
	}
	await refreshStatus();
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.gitSync.title'));
	try {
		await gitSyncStore.fetchSettings(usersStore.currentUser?.email ?? '');
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.gitSync.loadError'));
		return;
	}
	await Promise.all([searchProjects(''), refreshStatus()]);
});
</script>

<template>
	<N8nSettingsLayout :class="$style.layout">
		<N8nSettingsPageHeader
			:title="i18n.baseText('settings.gitSync.title')"
			:description="i18n.baseText('settings.gitSync.description')"
			:show-docs-link="false"
		/>

		<div v-if="gitSyncStore.loading" :class="$style.loading" data-test-id="git-sync-loading">
			<N8nIcon icon="spinner" spin />
		</div>

		<div v-else :class="$style.content">
			<N8nSettingsSection :title="i18n.baseText('settings.gitSync.connection.title')">
				<N8nSettingsRowGroup>
					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.repositoryUrl.label')"
						:description="i18n.baseText('settings.gitSync.repositoryUrl.description')"
						action-fill
					>
						<template #action>
							<N8nInput
								v-model="gitSyncStore.form.repositoryUrl"
								:class="$style.control"
								:placeholder="i18n.baseText('settings.gitSync.repositoryUrl.placeholder')"
								data-test-id="git-sync-repository-url"
							/>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.branch.label')"
						:description="i18n.baseText('settings.gitSync.branch.description')"
						action-fill
					>
						<template #action>
							<N8nInput
								v-model="gitSyncStore.form.branch"
								:class="$style.control"
								data-test-id="git-sync-branch"
							/>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.directory.label')"
						:description="i18n.baseText('settings.gitSync.directory.description')"
						action-fill
					>
						<template #action>
							<N8nInput
								v-model="gitSyncStore.form.directory"
								:class="$style.control"
								data-test-id="git-sync-directory"
							/>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.project.label')"
						:description="i18n.baseText('settings.gitSync.project.description')"
						action-fill
					>
						<template #action>
							<N8nSelect
								:class="$style.control"
								:model-value="gitSyncStore.form.projectId || undefined"
								:placeholder="i18n.baseText('settings.gitSync.project.placeholder')"
								:aria-label="i18n.baseText('settings.gitSync.project.label')"
								:loading="loadingProjects"
								:remote-method="searchProjects"
								filterable
								remote
								data-test-id="git-sync-project"
								@update:model-value="onProjectChange"
							>
								<N8nOption
									v-for="project in projectOptions"
									:key="project.id"
									:value="project.id"
									:label="project.name"
								/>
							</N8nSelect>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.username.label')"
						:description="i18n.baseText('settings.gitSync.username.description')"
						action-fill
					>
						<template #action>
							<N8nInput
								v-model="gitSyncStore.form.username"
								:class="$style.control"
								data-test-id="git-sync-username"
							/>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.accessToken.label')"
						:description="
							tokenWillBeRemoved
								? i18n.baseText('settings.gitSync.accessToken.willBeRemoved')
								: i18n.baseText('settings.gitSync.accessToken.description')
						"
						action-fill
					>
						<template #action>
							<div :class="$style.tokenControl">
								<N8nInput
									:model-value="tokenInputValue"
									:class="$style.control"
									:placeholder="tokenPlaceholder"
									type="password"
									autocomplete="new-password"
									data-test-id="git-sync-access-token"
									@update:model-value="onTokenInput"
								/>
								<N8nButton
									v-if="hasStoredToken && !tokenWillBeRemoved"
									variant="ghost"
									size="small"
									native-type="button"
									data-test-id="git-sync-remove-token"
									@click.stop.prevent="removeToken"
								>
									{{ i18n.baseText('settings.gitSync.accessToken.remove') }}
								</N8nButton>
							</div>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.authorName.label')"
						:description="i18n.baseText('settings.gitSync.authorName.description')"
						action-fill
					>
						<template #action>
							<N8nInput
								v-model="gitSyncStore.form.authorName"
								:class="$style.control"
								data-test-id="git-sync-author-name"
							/>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.authorEmail.label')"
						:description="i18n.baseText('settings.gitSync.authorEmail.description')"
						action-fill
					>
						<template #action>
							<N8nInput
								v-model="gitSyncStore.form.authorEmail"
								:class="$style.control"
								type="email"
								data-test-id="git-sync-author-email"
							/>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.credentialMatching.label')"
						:description="i18n.baseText('settings.gitSync.credentialMatching.description')"
						:max-description-lines="3"
						action-fill
					>
						<template #action>
							<N8nSelect
								:class="$style.control"
								:model-value="gitSyncStore.form.credentialMatchingMode"
								:aria-label="i18n.baseText('settings.gitSync.credentialMatching.label')"
								data-test-id="git-sync-credential-matching"
								@update:model-value="onCredentialMatchingChange"
							>
								<N8nOption
									value="name-and-type"
									:label="i18n.baseText('settings.gitSync.credentialMatching.option.nameAndType')"
								/>
								<N8nOption
									value="id-only"
									:label="i18n.baseText('settings.gitSync.credentialMatching.option.idOnly')"
								/>
							</N8nSelect>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						:title="i18n.baseText('settings.gitSync.test.label')"
						:description="testDescription"
					>
						<template #action>
							<N8nButton
								variant="outline"
								native-type="button"
								:loading="gitSyncStore.testing"
								:disabled="!gitSyncStore.canSave"
								data-test-id="git-sync-test-connection"
								@click.stop.prevent="onTestConnection"
							>
								{{ i18n.baseText('settings.gitSync.test.button') }}
							</N8nButton>
						</template>
					</N8nSettingsRow>

					<N8nSettingsRow
						v-if="gitSyncStore.isConnected"
						:title="i18n.baseText('settings.gitSync.disconnect.label')"
						:description="i18n.baseText('settings.gitSync.disconnect.description')"
					>
						<template #action>
							<N8nButton
								variant="outline"
								native-type="button"
								:disabled="gitSyncStore.isBusy"
								data-test-id="git-sync-disconnect"
								@click.stop.prevent="showDisconnectDialog = true"
							>
								{{ i18n.baseText('settings.gitSync.disconnect.button') }}
							</N8nButton>
						</template>
					</N8nSettingsRow>
				</N8nSettingsRowGroup>
			</N8nSettingsSection>

			<template v-if="gitSyncStore.isConnected && !gitSyncStore.isDirty">
				<N8nSettingsSection :title="i18n.baseText('settings.gitSync.status.title')">
					<div :class="$style.statusHeader">
						<div :class="$style.statusInfo" data-test-id="git-sync-status-info">
							<N8nText size="small" color="text-dark">
								{{
									i18n.baseText('settings.gitSync.status.branch', {
										interpolate: { branch: gitSyncStore.form.branch },
									})
								}}
							</N8nText>
							<N8nText v-if="gitSyncStore.status?.remoteHead" size="small" color="text-light">
								{{
									i18n.baseText('settings.gitSync.status.commit', {
										interpolate: { commit: shortCommit(gitSyncStore.status.remoteHead) },
									})
								}}
							</N8nText>
							<N8nText
								v-else-if="gitSyncStore.status"
								size="small"
								color="text-light"
								data-test-id="git-sync-no-remote-branch"
							>
								{{ i18n.baseText('settings.gitSync.status.noRemoteBranch') }}
							</N8nText>
							<N8nBadge
								v-if="gitSyncStore.status?.remoteChanged"
								variant="warning"
								size="small"
								data-test-id="git-sync-remote-changed"
							>
								{{ i18n.baseText('settings.gitSync.status.remoteChanged') }}
							</N8nBadge>
						</div>
						<N8nButton
							variant="ghost"
							icon="refresh-cw"
							native-type="button"
							:loading="gitSyncStore.loadingStatus"
							:disabled="gitSyncStore.isBusy"
							data-test-id="git-sync-refresh-status"
							@click.stop.prevent="refreshStatus"
						>
							{{ i18n.baseText('settings.gitSync.status.refresh') }}
						</N8nButton>
					</div>

					<div v-if="gitSyncStore.status" :class="$style.changeLists">
						<GitSyncChangeList
							:title="i18n.baseText('settings.gitSync.status.outgoing')"
							:empty-text="i18n.baseText('settings.gitSync.status.outgoingEmpty')"
							:changes="gitSyncStore.status.outgoing"
							data-test-id="git-sync-outgoing"
						/>
						<GitSyncChangeList
							:title="i18n.baseText('settings.gitSync.status.incoming')"
							:empty-text="i18n.baseText('settings.gitSync.status.incomingEmpty')"
							:changes="gitSyncStore.status.incoming"
							data-test-id="git-sync-incoming"
						/>
						<GitSyncChangeList
							:title="i18n.baseText('settings.gitSync.status.conflicts')"
							:empty-text="i18n.baseText('settings.gitSync.status.conflictsEmpty')"
							:changes="gitSyncStore.status.conflicts"
							data-test-id="git-sync-conflicts"
						/>
					</div>

					<div v-if="gitSyncStore.status" :class="$style.history">
						<N8nText v-if="gitSyncStore.status.lastPush" size="small" color="text-light">
							{{
								i18n.baseText('settings.gitSync.status.lastPush', {
									interpolate: {
										date: formatDate(gitSyncStore.status.lastPush.at),
										commit: shortCommit(gitSyncStore.status.lastPush.commit),
									},
								})
							}}
						</N8nText>
						<N8nText v-if="gitSyncStore.status.lastPull" size="small" color="text-light">
							{{
								i18n.baseText('settings.gitSync.status.lastPull', {
									interpolate: {
										date: formatDate(gitSyncStore.status.lastPull.at),
										commit: shortCommit(gitSyncStore.status.lastPull.commit),
									},
								})
							}}
						</N8nText>
					</div>
				</N8nSettingsSection>

				<N8nSettingsSection :title="i18n.baseText('settings.gitSync.push.title')">
					<N8nSettingsRowGroup>
						<N8nSettingsRow
							:title="i18n.baseText('settings.gitSync.push.message.label')"
							:description="i18n.baseText('settings.gitSync.push.description')"
							action-fill
						>
							<template #action>
								<N8nInput
									v-model="commitMessage"
									:class="$style.control"
									:placeholder="i18n.baseText('settings.gitSync.push.message.placeholder')"
									:maxlength="1000"
									data-test-id="git-sync-commit-message"
								/>
							</template>
						</N8nSettingsRow>
						<N8nSettingsRow
							:title="i18n.baseText('settings.gitSync.push.replace.label')"
							:description="i18n.baseText('settings.gitSync.push.replace.description')"
						>
							<template #action>
								<N8nCheckbox
									:model-value="replaceRemoteContent"
									data-test-id="git-sync-replace-remote"
									@update:model-value="replaceRemoteContent = Boolean($event)"
								/>
							</template>
						</N8nSettingsRow>
						<N8nSettingsRow :title="i18n.baseText('settings.gitSync.push.button')">
							<template #action>
								<N8nButton
									variant="solid"
									icon="upload"
									native-type="button"
									:loading="gitSyncStore.pushing"
									:disabled="!canPush"
									data-test-id="git-sync-push"
									@click.stop.prevent="onPushClick"
								>
									{{ i18n.baseText('settings.gitSync.push.button') }}
								</N8nButton>
							</template>
						</N8nSettingsRow>
					</N8nSettingsRowGroup>
				</N8nSettingsSection>

				<N8nSettingsSection :title="i18n.baseText('settings.gitSync.pull.title')">
					<N8nSettingsRowGroup>
						<N8nSettingsRow
							:title="i18n.baseText('settings.gitSync.pull.full.label')"
							:description="i18n.baseText('settings.gitSync.pull.full.description')"
						>
							<template #action>
								<N8nCheckbox
									:model-value="fullPull"
									data-test-id="git-sync-full-pull"
									@update:model-value="fullPull = Boolean($event)"
								/>
							</template>
						</N8nSettingsRow>
						<N8nSettingsRow
							:title="i18n.baseText('settings.gitSync.pull.button')"
							:description="i18n.baseText('settings.gitSync.pull.description')"
						>
							<template #action>
								<N8nButton
									variant="solid"
									icon="download"
									native-type="button"
									:loading="gitSyncStore.pulling"
									:disabled="gitSyncStore.isBusy"
									data-test-id="git-sync-pull"
									@click.stop.prevent="pull()"
								>
									{{ i18n.baseText('settings.gitSync.pull.button') }}
								</N8nButton>
							</template>
						</N8nSettingsRow>
					</N8nSettingsRowGroup>
					<div v-if="pullResultLines.length > 0" :class="$style.pullResult">
						<N8nCallout
							v-for="line in pullResultLines"
							:key="line.key"
							:theme="line.theme"
							data-test-id="git-sync-pull-result"
						>
							{{ line.text }}
						</N8nCallout>
					</div>
				</N8nSettingsSection>
			</template>

			<N8nSettingsSaveBar
				:class="$style.saveBar"
				:visible="gitSyncStore.isDirty"
				:message="i18n.baseText('settings.gitSync.unsavedChanges')"
				:save-label="i18n.baseText('settings.gitSync.save')"
				:discard-label="i18n.baseText('settings.gitSync.discard')"
				:saving="gitSyncStore.saving"
				:save-disabled="!gitSyncStore.canSave"
				floating
				@save="save"
				@discard="gitSyncStore.discardChanges()"
			/>
		</div>

		<N8nAlertDialog
			v-model:open="showDisconnectDialog"
			:title="i18n.baseText('settings.gitSync.disconnect.confirmTitle')"
			:description="i18n.baseText('settings.gitSync.disconnect.confirmDescription')"
			:action-label="i18n.baseText('settings.gitSync.disconnect.button')"
			:cancel-label="i18n.baseText('settings.gitSync.cancel')"
			:loading="gitSyncStore.saving"
			action-variant="destructive"
			@action="disconnect"
		/>

		<N8nAlertDialog
			v-model:open="showReplaceDialog"
			:title="i18n.baseText('settings.gitSync.push.confirmTitle')"
			:description="i18n.baseText('settings.gitSync.push.confirmDescription')"
			:action-label="i18n.baseText('settings.gitSync.push.confirm')"
			:cancel-label="i18n.baseText('settings.gitSync.cancel')"
			:loading="gitSyncStore.pushing"
			action-variant="destructive"
			@action="push"
		/>

		<N8nDialog
			:open="showUnsavedChangesDialog"
			:header="i18n.baseText('settings.gitSync.unsavedChanges')"
			size="medium"
			data-test-id="git-sync-unsaved-changes-dialog"
			@update:open="onUnsavedChangesDialogOpen"
		>
			<N8nDialogBody>
				<N8nDialogDescription>
					{{ i18n.baseText('settings.gitSync.unsavedChanges.message') }}
				</N8nDialogDescription>
			</N8nDialogBody>
			<N8nDialogFooter>
				<N8nDialogClose as-child>
					<N8nButton
						variant="outline"
						:label="i18n.baseText('generic.keepEditing')"
						@click="onKeepEditing"
					/>
				</N8nDialogClose>
				<N8nButton
					variant="outline"
					:label="i18n.baseText('settings.gitSync.unsavedChanges.leaveWithoutSaving')"
					@click="onLeaveWithoutSaving"
				/>
				<N8nButton
					variant="solid"
					:label="i18n.baseText('settings.gitSync.unsavedChanges.saveAndLeave')"
					:loading="gitSyncStore.saving"
					:disabled="!gitSyncStore.canSave"
					@click="onSaveAndLeave"
				/>
			</N8nDialogFooter>
		</N8nDialog>

		<N8nAlertDialog
			v-model:open="showConflictDialog"
			:title="i18n.baseText('settings.gitSync.pull.conflictTitle')"
			:description="i18n.baseText('settings.gitSync.pull.conflictDescription')"
			:action-label="i18n.baseText('settings.gitSync.pull.conflictConfirm')"
			:cancel-label="i18n.baseText('settings.gitSync.cancel')"
			:loading="gitSyncStore.pulling"
			action-variant="destructive"
			@action="pull(true)"
		>
			<ul :class="$style.conflictList" data-test-id="git-sync-conflict-list">
				<li v-for="conflict in pullConflicts" :key="conflict.id">
					<N8nText size="small">{{ conflict.name }}</N8nText>
				</li>
			</ul>
		</N8nAlertDialog>
	</N8nSettingsLayout>
</template>

<style lang="scss" module>
.layout {
	padding-top: 0;
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xl);
	width: 100%;
}

.loading {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: var(--spacing--2xl);
	color: var(--icon-color--subtle);
}

.control {
	width: 100%;
}

.tokenControl {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	width: 100%;
}

.statusHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.statusInfo {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--xs);
}

.changeLists {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
	gap: var(--spacing--lg);
}

.history {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.pullResult {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.conflictList {
	margin: 0;
	padding-left: var(--spacing--md);
}

.saveBar {
	margin-block-start: var(--spacing--xl);
}
</style>
