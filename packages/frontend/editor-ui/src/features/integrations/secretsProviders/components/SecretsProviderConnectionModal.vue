<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the modal that adds, edits and shares a connection of external
 * secrets. The settings page of the connections and the settings of a project open it.
 * `../FORK.md` describes it.
 */
import type { SecretProviderTypeResponse } from '@n8n/api-types';
import {
	N8nAlert,
	N8nCallout,
	N8nIcon,
	N8nIconButton,
	N8nInput,
	N8nInputLabel,
	N8nLink,
	N8nMenuItem,
	N8nNotice,
	N8nOption,
	N8nSelect,
	N8nText,
	type IMenuItem,
	useMessage,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { createEventBus } from '@n8n/utils/event-bus';
import type { INodeProperties } from 'n8n-workflow';
import { computed, onMounted, ref } from 'vue';

import Modal from '@/app/components/Modal.vue';
import SaveButton from '@/app/components/SaveButton.vue';
import { DELETE_SECRETS_PROVIDER_MODAL_KEY, MODAL_CONFIRM } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import type { IUpdateInformation } from '@/Interface';
import ParameterInputExpanded from '@/features/ndv/parameters/components/ParameterInputExpanded.vue';
import { useRBACStore } from '@n8n/stores/rbac.store';

import { useConnectionModal } from '../composables/useConnectionModal';
import SecretsProviderImage from './SecretsProviderImage.vue';

type ModalTab = 'connection' | 'sharing';

const props = defineProps<{
	modalName: string;
	data: {
		activeTab?: ModalTab;
		providerKey?: string;
		providerTypes?: SecretProviderTypeResponse[];
		existingProviderNames?: string[];
		projectId?: string;
		onClose?: () => void | Promise<void>;
	};
}>();

/** The value of the scope select for global connections. */
const GLOBAL_SCOPE = 'global';

const i18n = useI18n();
const message = useMessage();
const uiStore = useUIStore();
const rbacStore = useRBACStore();
const modalBus = createEventBus();

const modal = useConnectionModal({
	providerTypes: computed(() => props.data.providerTypes ?? []),
	providerKey: props.data.providerKey,
	projectId: props.data.projectId,
	existingProviderNames: computed(() => props.data.existingProviderNames ?? []),
});
const {
	canDelete,
	canSave,
	canShareGlobally,
	connectionName,
	connectionNameBlurred,
	connectionNameError,
	connectionSettings,
	expressionExample,
	hasUnsavedChanges,
	isEditMode,
	isReadOnly,
	isSaving,
	isScopedMode,
	isSharedGlobally,
	projectIds,
	projectOptions,
	properties,
	providerKey,
	providerSecretsCount,
	selectedProviderType,
} = modal;
const { connectionState, connectionError, isLoading } = modal.connection;

const activeTab = ref<ModalTab>(props.data.activeTab ?? 'connection');
const showErrorDetails = ref(false);

const sidebarItems = computed<IMenuItem[]>(() => [
	{
		id: 'sidebar-item-connection',
		label: i18n.baseText('settings.secretsProviderConnections.modal.items.connection'),
	},
	{
		id: 'sidebar-item-sharing',
		label: i18n.baseText('settings.secretsProviderConnections.modal.items.scope'),
	},
]);

const showSharing = computed(() => canShareGlobally.value && activeTab.value === 'sharing');

const providerTypeOptions = computed(() =>
	(props.data.providerTypes ?? []).map(({ type, displayName }) => ({
		value: type,
		label: displayName,
	})),
);

const readOnlyNotice = computed(() =>
	i18n.baseText(
		rbacStore.hasScope('externalSecretsProvider:update')
			? 'settings.secretsProviderConnections.modal.readOnly.notice.admin'
			: 'settings.secretsProviderConnections.modal.readOnly.notice.noPermission',
	),
);

const scopeOptions = computed(() => [
	{
		value: GLOBAL_SCOPE,
		label: i18n.baseText('settings.secretsProviderConnections.modal.scope.global'),
		icon: 'globe',
	},
	...projectOptions.value.map((project) => ({
		value: project.id,
		label: project.name ?? project.id,
		icon: project.icon?.type === 'icon' ? project.icon.value : 'layer-group',
	})),
]);

const scopeValue = computed(() =>
	isSharedGlobally.value ? GLOBAL_SCOPE : (projectIds.value[0] ?? GLOBAL_SCOPE),
);

const scopeIcon = computed(
	() => scopeOptions.value.find(({ value }) => value === scopeValue.value)?.icon ?? 'globe',
);

function onScopeChange(value: string) {
	if (value === GLOBAL_SCOPE) {
		modal.setScopeState([], true);
	} else {
		modal.setScopeState([value], false);
	}
}

function onTypeChange(type: string) {
	modal.selectProviderType(type);
}

function onFieldChange({ name, value }: IUpdateInformation) {
	modal.updateSettings(name, value);
}

function isFieldShown(property: INodeProperties) {
	return modal.shouldDisplayProperty(property);
}

async function onSave() {
	await modal.saveConnection();
}

function openDeleteModal() {
	if (!providerKey.value) return;

	uiStore.openModalWithData({
		name: DELETE_SECRETS_PROVIDER_MODAL_KEY,
		data: {
			providerKey: providerKey.value,
			providerName: providerKey.value,
			secretsCount: providerSecretsCount.value,
			projectId: props.data.projectId ?? modal.connectionProjects.value[0]?.id,
			onConfirm: async () => {
				await props.data.onClose?.();
				modalBus.emit('close');
			},
		},
	});
}

/** Ask before a close throws away changes. Only the answer "Keep editing" keeps the modal open. */
async function onBeforeClose() {
	if (!hasUnsavedChanges.value) return true;

	const answer = await message.confirm(
		i18n.baseText('settings.secretsProviderConnections.modal.unsavedChanges.text'),
		{
			title: i18n.baseText('settings.secretsProviderConnections.modal.unsavedChanges.title'),
			confirmButtonText: i18n.baseText(
				'settings.externalSecrets.provider.closeWithoutSaving.confirm',
			),
			cancelButtonText: i18n.baseText(
				'settings.externalSecrets.provider.closeWithoutSaving.cancel',
			),
		},
	);
	return answer !== MODAL_CONFIRM;
}

modalBus.on('closed', () => {
	void props.data.onClose?.();
});

onMounted(async () => {
	if (isEditMode.value) await modal.loadConnection();
});
</script>

<template>
	<Modal
		:name="modalName"
		:custom-class="$style.secretsProviderConnectionModal"
		:event-bus="modalBus"
		:before-close="onBeforeClose"
		width="70%"
		height="80%"
	>
		<template #header>
			<div :class="$style.header">
				<div :class="$style.providerInfo">
					<SecretsProviderImage v-if="selectedProviderType" :provider="selectedProviderType" />
					<N8nIcon v-else icon="vault" :size="24" />
					<div :class="$style.providerName">
						<N8nText v-if="isEditMode" tag="p" bold>{{ providerKey }}</N8nText>
						<N8nText size="small" tag="p" color="text-light">{{
							selectedProviderType?.displayName ??
							i18n.baseText('settings.secretsProviderConnections.modal.providerType.placeholder')
						}}</N8nText>
					</div>
				</div>
				<div :class="$style.actions">
					<N8nIconButton
						v-if="isEditMode && canDelete"
						variant="outline"
						icon="trash-2"
						:disabled="isSaving"
						data-test-id="secrets-provider-delete-button"
						@click="openDeleteModal"
					/>
					<SaveButton
						v-if="!isReadOnly"
						:saved="isEditMode && !hasUnsavedChanges"
						:is-saving="isSaving"
						:disabled="!canSave"
						:saving-label="i18n.baseText('settings.secretsProviderConnections.modal.saving')"
						data-test-id="secrets-provider-connection-save-button"
						@click="onSave"
					/>
				</div>
			</div>
		</template>
		<template #content>
			<div :class="$style.container">
				<div v-if="canShareGlobally" :class="$style.sidebar">
					<N8nMenuItem
						v-for="item in sidebarItems"
						:key="item.id"
						:item="item"
						:active="activeTab === (item.id === 'sidebar-item-sharing' ? 'sharing' : 'connection')"
						@click="activeTab = item.id === 'sidebar-item-sharing' ? 'sharing' : 'connection'"
					/>
				</div>
				<div :class="$style.main">
					<N8nNotice
						v-if="isReadOnly && !isLoading"
						:content="readOnlyNotice"
						data-test-id="secrets-provider-read-only-notice"
					/>
					<div v-if="showSharing" :class="$style.section">
						<N8nAlert
							type="info"
							:title="i18n.baseText('settings.secretsProviderConnections.modal.scope.info')"
						/>
						<div>
							<N8nInputLabel
								:label="i18n.baseText('settings.secretsProviderConnections.modal.scope.label')"
							/>
							<N8nSelect
								:model-value="scopeValue"
								:disabled="isScopedMode"
								filterable
								data-test-id="secrets-provider-scope-select"
								@update:model-value="onScopeChange"
							>
								<template #prefix>
									<N8nIcon :icon="scopeIcon" />
								</template>
								<N8nOption
									v-for="option in scopeOptions"
									:key="option.value"
									:value="option.value"
									:label="option.label"
								>
									<div :class="$style.option">
										<N8nIcon :icon="option.icon" />
										<span>{{ option.label }}</span>
									</div>
								</N8nOption>
							</N8nSelect>
						</div>
					</div>
					<div v-else-if="!isLoading" :class="$style.section">
						<N8nCallout
							v-if="isEditMode && connectionState === 'connected'"
							theme="success"
							data-test-id="connection-success-callout"
						>
							<div>
								{{
									i18n.baseText(
										'settings.secretsProviderConnections.modal.testConnection.success.serviceEnabled',
										{
											interpolate: {
												count: String(providerSecretsCount),
												providerName: providerKey ?? '',
											},
										},
									)
								}}
							</div>
							<div>
								{{
									i18n.baseText(
										'settings.secretsProviderConnections.modal.testConnection.success.reference',
									)
								}}
							</div>
							<code>{{ expressionExample }}</code>
						</N8nCallout>
						<N8nCallout
							v-else-if="isEditMode && connectionState === 'error'"
							theme="danger"
							data-test-id="connection-error-banner"
						>
							{{ i18n.baseText('settings.secretsProviderConnections.modal.testConnection.error') }}
							<template v-if="connectionError" #actions>
								<N8nText v-if="showErrorDetails" size="small">{{ connectionError }}</N8nText>
								<N8nLink v-else size="small" @click="showErrorDetails = true">
									{{
										i18n.baseText(
											'settings.secretsProviderConnections.modal.testConnection.error.moreDetails',
										)
									}}
								</N8nLink>
							</template>
						</N8nCallout>
						<div>
							<N8nInputLabel
								:label="i18n.baseText('settings.secretsProviderConnections.modal.connectionName')"
							/>
							<N8nInput
								v-model="connectionName"
								:disabled="isEditMode"
								placeholder="myVault"
								data-test-id="provider-name"
								@blur="connectionNameBlurred = true"
							/>
							<N8nText
								v-if="connectionNameBlurred && connectionNameError"
								size="small"
								color="danger"
							>
								{{ connectionNameError }}
							</N8nText>
							<N8nText v-else-if="!isEditMode" size="small" color="text-light">
								{{ i18n.baseText('settings.secretsProviderConnections.modal.connectionName.hint') }}
							</N8nText>
						</div>
						<div>
							<N8nInputLabel
								:label="i18n.baseText('settings.secretsProviderConnections.modal.providerType')"
							/>
							<N8nSelect
								:model-value="selectedProviderType?.type"
								:disabled="isEditMode"
								data-test-id="provider-type-select"
								@update:model-value="onTypeChange"
							>
								<N8nOption
									v-for="option in providerTypeOptions"
									:key="option.value"
									:value="option.value"
									:label="option.label"
								/>
							</N8nSelect>
						</div>
						<template v-for="property in properties" :key="property.name">
							<N8nNotice v-if="property.type === 'notice'" :content="property.displayName" />
							<ParameterInputExpanded
								v-else
								v-show="isFieldShown(property)"
								:parameter="property"
								:value="connectionSettings[property.name]"
								:label="{ size: 'medium' }"
								@update="onFieldChange"
							/>
						</template>
					</div>
				</div>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.secretsProviderConnectionModal {
	:global(.el-dialog__body) {
		padding: 0;
	}
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.providerInfo {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.providerName {
	display: flex;
	flex-direction: column;
}

.actions {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.container {
	display: flex;
	gap: var(--spacing--lg);
	height: 100%;
}

.sidebar {
	flex: 0 0 170px;
}

.main {
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	overflow-y: auto;
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.option {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}
</style>
