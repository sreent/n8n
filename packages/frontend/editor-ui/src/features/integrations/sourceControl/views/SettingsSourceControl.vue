<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the settings page "Environments". It connects the instance to a
 * branch of a Git repository over SSH or HTTPS, and sets the branch, the protected instance flag and
 * the color of the branch. `../FORK.md` describes it.
 */
import {
	N8nButton,
	N8nCallout,
	N8nCheckbox,
	N8nColorPicker,
	N8nEmptyState,
	N8nFormInput,
	N8nHeading,
	N8nIconButton,
	N8nNotice,
	N8nOption,
	N8nSelect,
	N8nTooltip,
} from '@n8n/design-system';
import type { IValidator, Validatable } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { computed, onMounted, ref } from 'vue';
import { I18nT } from 'vue-i18n';

import CopyInput from '@/app/components/CopyInput.vue';
import { MODAL_CONFIRM } from '@/app/constants';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { useLoadingService } from '@/app/composables/useLoadingService';
import { useMessage } from '@/app/composables/useMessage';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';

import { useSourceControlStore } from '../sourceControl.store';
import type { ConnectionType, SshKeyTypes } from '../sourceControl.types';

const i18n = useI18n();
const toast = useToast();
const message = useMessage();
const loadingService = useLoadingService();
const documentTitle = useDocumentTitle();
const pageRedirectionHelper = usePageRedirectionHelper();
const sourceControlStore = useSourceControlStore();

const DOCS_URL = 'https://docs.n8n.io/source-control-environments/';
const SSH_DOCS_URL =
	'https://docs.n8n.io/administer/use-source-control-and-environments/set-up-source-control#ssh-authentication-using-deploy-keys';

/** `user@host:path` or `ssh://[user@]host[:port]/path`. */
const SSH_URL_PATTERN =
	/^(?:ssh:\/\/(?:[\w.~-]+@)?[\w.-]+(?::\d+)?\/[\w./~-]+|[\w.~-]+@[\w.-]+:[\w./~-]+)$/;

const isEnterpriseSourceControlEnabled = computed(
	() => sourceControlStore.isEnterpriseSourceControlEnabled,
);
/** The form follows the store after each request, so that each control starts with its value. */
const isConnected = ref(false);

const connectionType = ref<ConnectionType>('ssh');
const repositoryUrl = ref('');
const httpsUsername = ref('');
const httpsPassword = ref('');
const keyGeneratorType = ref<SshKeyTypes>('ed25519');
const branchName = ref('');
const branchReadOnly = ref(false);
const branchColor = ref('');
const isRepositoryUrlValid = ref(false);

const connectionTypeOptions = [
	{ value: 'ssh', label: 'SSH' },
	{ value: 'https', label: 'HTTPS' },
];

const isHttps = computed(() => connectionType.value === 'https');

const repositoryUrlValidator: IValidator = {
	validate: (value: Validatable) => {
		const url = typeof value === 'string' ? value.trim() : '';
		if (isHttps.value) {
			return isHttpsUrl(url)
				? false
				: { message: i18n.baseText('settings.sourceControl.enterValidHttpsUrl') };
		}
		return SSH_URL_PATTERN.test(url)
			? false
			: { message: i18n.baseText('settings.sourceControl.repoUrlInvalid') };
	},
};

function isHttpsUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !!url.hostname;
	} catch {
		return false;
	}
}

const canConnect = computed(() => {
	if (!isRepositoryUrlValid.value) return false;
	if (!isHttps.value) return true;
	return !!httpsUsername.value.trim() && !!httpsPassword.value.trim();
});

const canSave = computed(() => !!branchName.value);

/** Copies the preferences of the store into the form. */
function readPreferences() {
	const preferences = sourceControlStore.preferences;
	connectionType.value = preferences.connectionType ?? 'ssh';
	repositoryUrl.value = preferences.repositoryUrl;
	keyGeneratorType.value = preferences.keyGeneratorType ?? 'ed25519';
	branchName.value = preferences.branchName;
	branchReadOnly.value = preferences.branchReadOnly;
	branchColor.value = preferences.branchColor;
	isConnected.value = preferences.connected;
}

function onValidateRepositoryUrl(valid: boolean) {
	isRepositoryUrlValid.value = valid;
}

async function onConnect() {
	loadingService.startLoading(i18n.baseText('settings.sourceControl.loading.connecting'));
	try {
		await sourceControlStore.savePreferences({
			repositoryUrl: repositoryUrl.value,
			connectionType: connectionType.value,
			...(isHttps.value
				? { httpsUsername: httpsUsername.value, httpsPassword: httpsPassword.value }
				: {}),
		});
		await sourceControlStore.getBranches();
		readPreferences();
		httpsPassword.value = '';
		toast.showMessage({
			title: i18n.baseText('settings.sourceControl.toast.connected.title'),
			message: i18n.baseText('settings.sourceControl.toast.connected.message'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.toast.connected.error'));
	}
	loadingService.stopLoading();
}

async function onDisconnect() {
	try {
		const confirmation = await message.confirm(
			i18n.baseText('settings.sourceControl.modals.disconnect.message'),
			i18n.baseText('settings.sourceControl.modals.disconnect.title'),
			{
				confirmButtonText: i18n.baseText('settings.sourceControl.modals.disconnect.confirm'),
				cancelButtonText: i18n.baseText('settings.sourceControl.modals.disconnect.cancel'),
			},
		);
		if (confirmation === MODAL_CONFIRM) {
			loadingService.startLoading();
			await sourceControlStore.disconnect(true);
			readPreferences();
			toast.showMessage({
				title: i18n.baseText('settings.sourceControl.toast.disconnected.title'),
				message: i18n.baseText('settings.sourceControl.toast.disconnected.message'),
				type: 'success',
			});
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.toast.disconnected.error'));
	}
	loadingService.stopLoading();
}

async function onSave() {
	loadingService.startLoading();
	try {
		await sourceControlStore.updatePreferences({
			branchName: branchName.value,
			branchReadOnly: branchReadOnly.value,
			branchColor: branchColor.value,
		});
		toast.showMessage({
			title: i18n.baseText('settings.sourceControl.saved.title'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.saved.error'));
	}
	loadingService.stopLoading();
}

async function refreshBranches() {
	try {
		await sourceControlStore.getBranches();
		toast.showMessage({
			title: i18n.baseText('settings.sourceControl.refreshBranches.success'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.refreshBranches.error'));
	}
}

async function refreshSshKey() {
	try {
		const confirmation = await message.confirm(
			i18n.baseText('settings.sourceControl.modals.refreshSshKey.message'),
			i18n.baseText('settings.sourceControl.modals.refreshSshKey.title'),
			{
				confirmButtonText: i18n.baseText('settings.sourceControl.modals.refreshSshKey.confirm'),
				cancelButtonText: i18n.baseText('settings.sourceControl.modals.refreshSshKey.cancel'),
			},
		);
		if (confirmation === MODAL_CONFIRM) {
			await sourceControlStore.generateKeyPair(keyGeneratorType.value);
			toast.showMessage({
				title: i18n.baseText('settings.sourceControl.refreshSshKey.successful.title'),
				type: 'success',
			});
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.refreshSshKey.error.title'));
	}
}

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('source-control', 'upgrade-source-control');
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.sourceControl.title'));
	if (!isEnterpriseSourceControlEnabled.value) return;
	await sourceControlStore.getPreferences();
	readPreferences();
	if (sourceControlStore.preferences.connected) {
		await sourceControlStore.getBranches();
	}
});
</script>

<template>
	<div :class="$style.container">
		<N8nHeading size="2xlarge" tag="h1">{{
			i18n.baseText('settings.sourceControl.title')
		}}</N8nHeading>
		<div
			v-if="isEnterpriseSourceControlEnabled"
			data-test-id="source-control-content-licensed"
			:class="$style.content"
		>
			<N8nCallout theme="secondary" icon="info" class="mt-2xl mb-l">
				<I18nT keypath="settings.sourceControl.description" tag="span" scope="global">
					<template #link>
						<a :href="DOCS_URL" target="_blank">
							{{ i18n.baseText('settings.sourceControl.description.link') }}
						</a>
					</template>
				</I18nT>
			</N8nCallout>
			<N8nHeading size="xlarge" tag="h2" class="mb-s">{{
				i18n.baseText('settings.sourceControl.gitConfig')
			}}</N8nHeading>
			<div v-if="!isConnected" :class="$style.group">
				<label for="connectionType">{{
					i18n.baseText('settings.sourceControl.connectionType')
				}}</label>
				<div data-test-id="source-control-connection-type-select" :class="$style.select">
					<N8nSelect id="connectionType" v-model="connectionType" size="large">
						<N8nOption
							v-for="option in connectionTypeOptions"
							:key="option.value"
							:value="option.value"
							:label="option.label"
						/>
					</N8nSelect>
				</div>
			</div>
			<div :class="$style.group">
				<label for="repoUrl">{{
					isHttps
						? i18n.baseText('settings.sourceControl.httpsRepoUrl')
						: i18n.baseText('settings.sourceControl.sshRepoUrl')
				}}</label>
				<div :class="$style.groupFlex">
					<N8nFormInput
						id="repoUrl"
						:key="connectionType"
						v-model="repositoryUrl"
						label=""
						name="repoUrl"
						:class="$style.input"
						:placeholder="
							isHttps
								? i18n.baseText('settings.sourceControl.httpsRepoUrlPlaceholder')
								: i18n.baseText('settings.sourceControl.sshRepoUrlPlaceholder')
						"
						:disabled="isConnected"
						:validators="{ REPO_URL: repositoryUrlValidator }"
						:validation-rules="[{ name: 'REQUIRED' }, { name: 'REPO_URL' }]"
						validate-on-blur
						@validate="onValidateRepositoryUrl"
					/>
					<N8nButton
						v-if="isConnected"
						variant="destructive"
						size="large"
						icon="trash-2"
						:class="$style.disconnectButton"
						data-test-id="source-control-disconnect-button"
						@click="onDisconnect"
						>{{ i18n.baseText('settings.sourceControl.button.disconnect') }}</N8nButton
					>
				</div>
				<N8nNotice v-if="!isConnected" theme="info" class="mt-2xs" :compact="true">{{
					isHttps
						? i18n.baseText('settings.sourceControl.httpsFormatNotice')
						: i18n.baseText('settings.sourceControl.sshFormatNotice')
				}}</N8nNotice>
			</div>
			<template v-if="isHttps && !isConnected">
				<div :class="$style.group">
					<label for="httpsUsername">{{
						i18n.baseText('settings.sourceControl.httpsUsername')
					}}</label>
					<N8nFormInput
						id="httpsUsername"
						v-model="httpsUsername"
						label=""
						name="httpsUsername"
						:class="$style.input"
						:placeholder="i18n.baseText('settings.sourceControl.httpsUsernamePlaceholder')"
						:validation-rules="[{ name: 'REQUIRED' }]"
						validate-on-blur
					/>
				</div>
				<div :class="$style.group">
					<label for="httpsPassword">{{
						i18n.baseText('settings.sourceControl.httpsPersonalAccessToken')
					}}</label>
					<N8nFormInput
						id="httpsPassword"
						v-model="httpsPassword"
						label=""
						name="httpsPassword"
						type="password"
						:class="$style.input"
						:placeholder="
							i18n.baseText('settings.sourceControl.httpsPersonalAccessTokenPlaceholder')
						"
						:validation-rules="[{ name: 'REQUIRED' }]"
						validate-on-blur
					/>
					<N8nNotice theme="warning" class="mt-2xs" :compact="true">
						<I18nT keypath="settings.sourceControl.httpsWarningNotice" tag="span" scope="global">
							<template #strong>
								<strong>{{
									i18n.baseText('settings.sourceControl.httpsWarningNotice.strong')
								}}</strong>
							</template>
							<template #repo>
								<code>repo</code>
							</template>
							<template #publicRepo>
								<code>public_repo</code>
							</template>
						</I18nT>
					</N8nNotice>
				</div>
			</template>
			<div v-if="!isHttps && sourceControlStore.preferences.publicKey" :class="$style.group">
				<label>{{ i18n.baseText('settings.sourceControl.sshKey') }}</label>
				<div :class="{ [$style.sshInput]: !isConnected }">
					<div
						v-if="!isConnected"
						data-test-id="source-control-ssh-key-type-select"
						:class="$style.sshKeyTypeSelect"
					>
						<N8nSelect v-model="keyGeneratorType" size="large">
							<N8nOption
								v-for="option in sourceControlStore.sshKeyTypesWithLabel"
								:key="option.value"
								:value="option.value"
								:label="option.label"
							/>
						</N8nSelect>
					</div>
					<CopyInput
						:class="$style.copyInput"
						collapse
						size="medium"
						:value="sourceControlStore.preferences.publicKey"
						:copy-button-text="i18n.baseText('generic.clickToCopy')"
					/>
					<N8nButton
						v-if="!isConnected"
						size="large"
						variant="subtle"
						icon="refresh-cw"
						data-test-id="source-control-refresh-ssh-key-button"
						@click="refreshSshKey"
						>{{ i18n.baseText('settings.sourceControl.refreshSshKey') }}</N8nButton
					>
				</div>
				<N8nNotice theme="info" class="mt-s" :compact="true">
					<I18nT keypath="settings.sourceControl.sshKeyDescription" tag="span" scope="global">
						<template #link>
							<a :href="SSH_DOCS_URL" target="_blank">{{
								i18n.baseText('settings.sourceControl.sshKeyDescriptionLink')
							}}</a>
						</template>
					</I18nT>
				</N8nNotice>
			</div>
			<N8nButton
				v-if="!isConnected"
				size="large"
				:disabled="!canConnect"
				:class="$style.connect"
				data-test-id="source-control-connect-button"
				@click="onConnect"
				>{{ i18n.baseText('settings.sourceControl.button.connect') }}</N8nButton
			>
			<div v-if="isConnected" data-test-id="source-control-connected-content">
				<div :class="$style.group">
					<hr />
					<N8nHeading size="xlarge" tag="h2" class="mb-s">{{
						i18n.baseText('settings.sourceControl.instanceSettings')
					}}</N8nHeading>
					<label>{{ i18n.baseText('settings.sourceControl.branches') }}</label>
					<div :class="$style.branchSelection">
						<div data-test-id="source-control-branch-select" :class="$style.select">
							<N8nSelect v-model="branchName" size="large">
								<N8nOption
									v-for="branch in sourceControlStore.preferences.branches"
									:key="branch"
									:value="branch"
									:label="branch"
								/>
							</N8nSelect>
						</div>
						<N8nTooltip placement="top">
							<template #content>
								<span>{{ i18n.baseText('settings.sourceControl.refreshBranches.tooltip') }}</span>
							</template>
							<N8nIconButton
								size="small"
								variant="subtle"
								icon="refresh-cw"
								:aria-label="i18n.baseText('generic.refresh')"
								data-test-id="source-control-refresh-branches-button"
								@click="refreshBranches"
							/>
						</N8nTooltip>
					</div>
					<div :class="$style.readOnly">
						<N8nCheckbox
							v-model="branchReadOnly"
							data-test-id="source-control-read-only-checkbox"
						/>
						<I18nT keypath="settings.sourceControl.protected" tag="span" scope="global">
							<template #bold>
								<strong>{{ i18n.baseText('settings.sourceControl.protected.bold') }}</strong>
							</template>
						</I18nT>
					</div>
				</div>
				<div :class="$style.group">
					<label>{{ i18n.baseText('settings.sourceControl.color') }}</label>
					<div>
						<N8nColorPicker v-model="branchColor" size="small" />
					</div>
				</div>
				<div :class="[$style.group, 'pt-s']">
					<N8nButton
						size="large"
						:disabled="!canSave"
						data-test-id="source-control-save-settings-button"
						@click="onSave"
						>{{ i18n.baseText('settings.sourceControl.button.save') }}</N8nButton
					>
				</div>
			</div>
		</div>
		<N8nEmptyState
			v-else
			data-test-id="source-control-content-unlicensed"
			:description="i18n.baseText('settings.sourceControl.actionBox.description')"
			:button-text="i18n.baseText('settings.sourceControl.actionBox.buttonText')"
			@click:button="goToUpgrade"
		>
			<template #heading>
				<span>{{ i18n.baseText('settings.sourceControl.actionBox.title') }}</span>
			</template>
			<template #description>
				{{ i18n.baseText('settings.sourceControl.actionBox.description') }}
				<a :href="DOCS_URL" target="_blank">
					{{ i18n.baseText('settings.sourceControl.actionBox.description.link') }}
				</a>
			</template>
		</N8nEmptyState>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	padding-bottom: var(--spacing--2xl);

	> * {
		width: 100%;
	}
}

.content {
	max-width: 1000px;
}

.group {
	padding: 0 0 var(--spacing--sm);
	width: 100%;
	display: block;

	hr {
		margin: 0 0 var(--spacing--xl);
		border: 1px solid var(--color--foreground--tint-1);
	}

	label {
		display: inline-block;
		padding: 0 0 var(--spacing--2xs);
		font-size: var(--font-size--sm);
	}

	small {
		display: inline-block;
		padding: var(--spacing--2xs) 0 0;
		font-size: var(--font-size--2xs);
		color: var(--color--text--tint-1);
	}
}

.select {
	max-width: 400px;
}

.groupFlex {
	display: flex;
	align-items: flex-start;

	> div {
		flex: 1;
	}
}

.input {
	flex: 1;
}

.disconnectButton {
	margin: 0 0 0 var(--spacing--xs);
	height: 40px;
}

.sshInput {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);

	> div {
		flex: 1 1 auto;
	}

	> button {
		height: 42px;
	}
}

.sshKeyTypeSelect {
	min-width: 120px;
	flex: 0 0 auto !important;
}

.copyInput {
	flex: 1;
}

.branchSelection {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);

	> div:first-child {
		flex: 1;
	}
}

.readOnly {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm) 0 0;
	font-size: var(--font-size--sm);
}

.connect {
	margin: var(--spacing--2xs) 0 0;
}
</style>
