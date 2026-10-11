<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the settings page of the connections of external secrets. The
 * router shows it when the module settings turn on multiple connections or project connections.
 * `../FORK.md` describes it.
 */
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nEmptyState,
	N8nHeading,
	N8nIcon,
	N8nLink,
	N8nLoading,
	N8nText,
	useMessage,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { updateExternalSecretsSettings } from '@n8n/rest-api-client/api/externalSecrets';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { ElSwitch } from 'element-plus';
import { computed, onMounted, ref } from 'vue';

import {
	DELETE_SECRETS_PROVIDER_MODAL_KEY,
	MODAL_CONFIRM,
	SECRETS_PROVIDER_CONNECTION_MODAL_KEY,
} from '@/app/constants';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';

import SecretsProviderConnectionCard from '../components/SecretsProviderConnectionCard.vue';
import SecretsProvidersEmptyState from '../components/SecretsProvidersEmptyState.vue';
import { useSecretsProviderConnection } from '../composables/useSecretsProviderConnection';
import { useSecretsProvidersList } from '../composables/useSecretsProvidersList';

const i18n = useI18n();
const toast = useToast();
const message = useMessage();
const documentTitle = useDocumentTitle();
const pageRedirectionHelper = usePageRedirectionHelper();
const uiStore = useUIStore();
const rootStore = useRootStore();
const settingsStore = useSettingsStore();
const projectsStore = useProjectsStore();

const {
	activeProviders,
	providerTypes,
	canCreate,
	canUpdate,
	isEnterpriseExternalSecretsEnabled,
	isLoading,
	fetchProviderTypes,
	fetchActiveConnections,
	fetchConnection,
} = useSecretsProvidersList();
const connection = useSecretsProviderConnection();

const moduleSettings = computed(() => settingsStore.moduleSettings['external-secrets']);
const isUpdatingSystemRoles = ref(false);

/** The connections by name. */
const sortedProviders = computed(() =>
	[...activeProviders.value].sort((a, b) => a.name.localeCompare(b.name)),
);

function providerTypeInfo(type: string) {
	return providerTypes.value.find((providerType) => providerType.type === type);
}

function projectOf(provider: (typeof activeProviders.value)[number]) {
	const first = provider.projects[0];
	if (!first) return null;
	return projectsStore.projects.find(({ id }) => id === first.id) ?? null;
}

async function loadPage() {
	try {
		await Promise.all([
			fetchProviderTypes(),
			fetchActiveConnections(),
			projectsStore.getAllProjects(),
		]);
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	}
}

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('external-secrets', 'upgrade-external-secrets');
}

function openConnectionModal(
	providerKey?: string,
	activeTab: 'connection' | 'sharing' = 'connection',
) {
	uiStore.openModalWithData({
		name: SECRETS_PROVIDER_CONNECTION_MODAL_KEY,
		data: {
			activeTab,
			providerKey,
			providerTypes: providerTypes.value,
			existingProviderNames: activeProviders.value.map(({ name }) => name),
			onClose: async () => {
				await fetchActiveConnections();
			},
		},
	});
}

function openDeleteModal(providerKey: string) {
	const provider = activeProviders.value.find(({ name }) => name === providerKey);
	if (!provider) return;

	uiStore.openModalWithData({
		name: DELETE_SECRETS_PROVIDER_MODAL_KEY,
		data: {
			providerKey,
			providerName: provider.name,
			secretsCount: provider.secretsCount,
			projectId: provider.projects[0]?.id,
			onConfirm: async () => {
				await fetchActiveConnections();
			},
		},
	});
}

async function reloadProvider(providerKey: string) {
	try {
		await connection.reloadConnection(providerKey);
		toast.showMessage({
			type: 'success',
			title: i18n.baseText('settings.externalSecrets.card.reload.success.title'),
			message: i18n.baseText('settings.externalSecrets.card.reload.success.description', {
				interpolate: { provider: providerKey },
			}),
		});
		await fetchConnection(providerKey);
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	}
}

async function activateProvider(providerKey: string) {
	try {
		await connection.activateConnection(providerKey);
		await fetchConnection(providerKey);
		toast.showMessage({
			type: 'success',
			title: i18n.baseText('settings.secretsProviderConnections.actions.activate.success.title'),
			message: i18n.baseText(
				'settings.secretsProviderConnections.actions.activate.success.description',
				{ interpolate: { provider: providerKey } },
			),
		});
	} catch (error) {
		toast.showError(
			error,
			i18n.baseText('settings.secretsProviderConnections.actions.activate.error.title'),
			{
				message: i18n.baseText(
					'settings.secretsProviderConnections.actions.activate.error.description',
					{ interpolate: { provider: providerKey } },
				),
			},
		);
	}
}

/** Give the project roles the scopes of external secrets, or take them away after a question. */
async function onSystemRolesChange(value: string | number | boolean) {
	const enabled = value === true;
	if (!enabled) {
		const answer = await message.confirm(
			i18n.baseText('settings.externalSecrets.systemRoles.confirm.message'),
			i18n.baseText('settings.externalSecrets.systemRoles.confirm.headline'),
			{
				confirmButtonText: i18n.baseText(
					'settings.externalSecrets.systemRoles.confirm.confirmButtonText',
				),
				cancelButtonText: i18n.baseText(
					'settings.externalSecrets.systemRoles.confirm.cancelButtonText',
				),
			},
		);
		if (answer !== MODAL_CONFIRM) return;
	}

	isUpdatingSystemRoles.value = true;
	try {
		await updateExternalSecretsSettings(rootStore.restApiContext, { systemRolesEnabled: enabled });
		await settingsStore.getModuleSettings();
		toast.showMessage({
			type: 'success',
			title: i18n.baseText(
				enabled
					? 'settings.externalSecrets.systemRoles.enabled.toast'
					: 'settings.externalSecrets.systemRoles.disabled.toast',
			),
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.externalSecrets.systemRoles.error'));
	} finally {
		isUpdatingSystemRoles.value = false;
	}
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.secretsProviderConnections.title'));
	if (!isEnterpriseExternalSecretsEnabled.value) return;
	await loadPage();
});
</script>

<template>
	<div :class="$style.container">
		<div class="mb-xl" :class="$style.header">
			<N8nHeading tag="h1" size="2xlarge">
				{{ i18n.baseText('settings.secretsProviderConnections.title') }}
			</N8nHeading>
			<N8nText
				v-if="isEnterpriseExternalSecretsEnabled && activeProviders.length"
				color="text-base"
				size="medium"
			>
				{{ i18n.baseText('settings.secretsProviderConnections.description') }}
				{{ i18n.baseText('credentialResolver.view.learnMore') }}
				<N8nLink
					theme="text"
					:href="i18n.baseText('settings.externalSecrets.docs')"
					size="medium"
					new-window
				>
					<span :class="$style.link">
						{{ i18n.baseText('generic.documentation') }}
						<N8nIcon icon="arrow-up-right" />
					</span>
				</N8nLink>
			</N8nText>
		</div>
		<div
			v-if="moduleSettings?.roleBasedAccess"
			:class="$style.systemRoles"
			data-test-id="external-secrets-system-roles-toggle"
		>
			<div>
				<N8nText bold>{{ i18n.baseText('settings.externalSecrets.systemRoles.title') }}</N8nText>
				<N8nText tag="p" size="small" color="text-light">
					{{ i18n.baseText('settings.externalSecrets.systemRoles.description') }}
				</N8nText>
			</div>
			<ElSwitch
				:model-value="moduleSettings.systemRolesEnabled ?? false"
				:loading="isUpdatingSystemRoles"
				data-test-id="external-secrets-system-roles-switch"
				@update:model-value="onSystemRolesChange"
			/>
		</div>
		<div
			v-if="isEnterpriseExternalSecretsEnabled && activeProviders.length > 0 && canCreate"
			:class="$style.actionBar"
		>
			<N8nButton variant="solid" @click="openConnectionModal()">
				<N8nIcon icon="plus" />
				{{ i18n.baseText('settings.secretsProviderConnections.buttons.addSecretsStore') }}
			</N8nButton>
		</div>
		<div
			v-if="isEnterpriseExternalSecretsEnabled"
			data-test-id="secrets-provider-connections-content-licensed"
		>
			<N8nLoading
				v-if="isLoading && activeProviders.length === 0"
				:rows="3"
				data-test-id="secrets-providers-loading"
			/>
			<SecretsProvidersEmptyState
				v-else-if="activeProviders.length === 0"
				:provider-types="providerTypes"
				:can-create="canCreate"
				@add-secrets-store="openConnectionModal()"
			/>
			<template v-else>
				<SecretsProviderConnectionCard
					v-for="provider in sortedProviders"
					:key="provider.name"
					:provider="provider"
					:provider-type-info="providerTypeInfo(provider.type)"
					:project="projectOf(provider)"
					:can-update="canUpdate"
					@edit="openConnectionModal($event, 'connection')"
					@share="openConnectionModal($event, 'sharing')"
					@reload="reloadProvider"
					@delete="openDeleteModal"
					@activate="activateProvider"
				/>
			</template>
		</div>
		<N8nEmptyState
			v-else
			:heading="i18n.baseText('settings.externalSecrets.actionBox.title')"
			:button-text="i18n.baseText('settings.externalSecrets.actionBox.buttonText')"
			data-test-id="secrets-provider-connections-content-unlicensed"
			@click:button="goToUpgrade"
		/>
	</div>
</template>

<style lang="scss" module>
.container {
	max-width: 702px;
	margin: 0 auto;
	padding-bottom: var(--spacing--xl);
}

.header {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.link {
	display: inline-flex;
	align-items: center;
}

.systemRoles {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	margin-bottom: var(--spacing--lg);
}

.actionBar {
	display: flex;
	justify-content: flex-end;
	margin-bottom: var(--spacing--sm);
}
</style>
