<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the modal with the settings of one provider type, on the
 * settings page of external secrets. `../FORK.md` describes it.
 */
import type { ExternalSecretsProviderData } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nCallout, N8nLink, N8nNotice, useMessage } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, ref } from 'vue';
import { I18nT } from 'vue-i18n';

import Modal from '@/app/components/Modal.vue';
import { MODAL_CONFIRM } from '@/app/constants';
import type { IUpdateInformation } from '@/Interface';
import ParameterInputExpanded from '@/features/ndv/parameters/components/ParameterInputExpanded.vue';

import {
	isPropertyShown,
	settingsToSend,
	useExternalSecretsProvider,
} from '../composables/useExternalSecretsProvider';
import { useExternalSecretsStore } from '../externalSecrets.store';
import ExternalSecretsProviderConnectionSwitch from './ExternalSecretsProviderConnectionSwitch.vue';
import ExternalSecretsProviderImage from './ExternalSecretsProviderImage.vue';

const props = defineProps<{
	modalName: string;
	data: { name: string };
}>();

/**
 * Values for settings that were stored before a field existed. The modal sets a value when the
 * stored settings have none, and the settings then count as changed.
 */
const MISSING_SETTING_DEFAULTS: Record<string, ExternalSecretsProviderData> = {
	azureKeyVault: { environment: 'public' },
	infisical: { siteURL: 'https://app.infisical.com' },
};

const externalSecretsStore = useExternalSecretsStore();
const toast = useToast();
const message = useMessage();
const i18n = useI18n();
const { testConnection } = useExternalSecretsProvider();

const providerData = ref<ExternalSecretsProviderData>({});
/** Whether the settings changed since the modal opened or since the last save. */
const hasChanges = ref(false);
const isSaving = ref(false);

const provider = computed(() =>
	externalSecretsStore.providers.find(({ name }) => name === props.data.name),
);
const displayName = computed(() => provider.value?.displayName ?? '');
const properties = computed(() => provider.value?.properties ?? []);
const connectionState = computed(() => externalSecretsStore.connectionState[props.data.name]);
const secretsCount = computed(() => externalSecretsStore.secrets[props.data.name]?.length ?? 0);
const usageCode = computed(() => `{{ $secrets.${props.data.name}.secret_name }}`);

/** Each required field that the form shows has a value. */
const hasRequiredValues = computed(() =>
	properties.value.every((property) => {
		if (!property.required || !isPropertyShown(property, providerData.value)) return true;
		const value = providerData.value[property.name];
		return value !== undefined && value !== null && value !== '';
	}),
);
const canSave = computed(() => hasChanges.value && hasRequiredValues.value && !isSaving.value);

async function testSettings() {
	await testConnection(props.data.name, settingsToSend(properties.value, providerData.value));
}

onMounted(async () => {
	const fetched = await externalSecretsStore.getProvider(props.data.name);
	const data: ExternalSecretsProviderData = { ...(fetched.data ?? {}) };
	for (const [key, value] of Object.entries(MISSING_SETTING_DEFAULTS[fetched.name] ?? {})) {
		if (data[key] === undefined) {
			data[key] = value;
			hasChanges.value = true;
		}
	}
	providerData.value = data;
	externalSecretsStore.setConnectionState(fetched.name, fetched.state);

	if (!fetched.connected && Object.keys(fetched.data ?? {}).length > 0) await testSettings();
	if (fetched.state === 'connected') {
		try {
			await externalSecretsStore.reloadProvider(fetched.name);
			await externalSecretsStore.fetchGlobalSecrets();
		} catch {
			// As in the enterprise modal: a failed reload shows no message. The callout keeps the
			// secret names that the page read before.
		}
	}
});

function onValueChange({ name, value }: IUpdateInformation) {
	providerData.value = { ...providerData.value, [name]: value };
	hasChanges.value = true;
}

/** Store the settings, then test them. A failed save keeps the changes. */
async function save() {
	isSaving.value = true;
	try {
		await externalSecretsStore.updateProvider(props.data.name, {
			data: settingsToSend(properties.value, providerData.value),
		});
		await externalSecretsStore.fetchGlobalSecrets();
		hasChanges.value = false;
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	}
	await testSettings();
	isSaving.value = false;
}

/** Ask before a close throws away changes. Only the answer "Keep editing" keeps the modal open. */
async function onBeforeClose() {
	if (!hasChanges.value) return true;

	const answer = await message.confirm(
		i18n.baseText('settings.externalSecrets.provider.closeWithoutSaving.description', {
			interpolate: { provider: displayName.value },
		}),
		{
			title: i18n.baseText('settings.externalSecrets.provider.closeWithoutSaving.title'),
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
</script>

<template>
	<Modal :name="modalName" :title="displayName" width="812px" :before-close="onBeforeClose">
		<template #header>
			<div :class="$style.header">
				<div :class="$style.title">
					<ExternalSecretsProviderImage v-if="provider" :provider="provider" />
					<span>{{ displayName }}</span>
				</div>
				<div :class="$style.actions">
					<ExternalSecretsProviderConnectionSwitch
						v-if="provider"
						:provider="provider"
						:disabled="connectionState === 'initializing'"
						:test-before-connect="false"
						@change="testSettings"
					/>
					<N8nButton :disabled="!canSave" :loading="isSaving" @click="save">
						{{
							isSaving
								? i18n.baseText('settings.externalSecrets.provider.buttons.saving')
								: i18n.baseText('settings.externalSecrets.provider.buttons.save')
						}}
					</N8nButton>
				</div>
			</div>
		</template>
		<template #content>
			<div :class="$style.content">
				<hr />
				<div v-if="provider && (connectionState === 'connected' || connectionState === 'tested')">
					<N8nCallout theme="success">
						<template v-if="provider.connected">
							{{
								i18n.baseText(
									'settings.externalSecrets.provider.testConnection.success.connected',
									{
										interpolate: { count: `${secretsCount}`, provider: displayName },
									},
								)
							}}
							<span>
								<I18nT
									keypath="settings.externalSecrets.provider.testConnection.success.connected.usage"
									scope="global"
								>
									<template #code>
										<br />
										<code>{{ usageCode }}</code>
									</template>
								</I18nT>
								<N8nLink :to="i18n.baseText('settings.externalSecrets.docs.use')" size="small">
									{{
										i18n.baseText(
											'settings.externalSecrets.provider.testConnection.success.connected.docs',
										)
									}}
								</N8nLink>
							</span>
						</template>
						<template v-else>
							{{
								i18n.baseText('settings.externalSecrets.provider.testConnection.success', {
									interpolate: { provider: displayName },
								})
							}}
						</template>
					</N8nCallout>
				</div>
				<div v-else-if="provider && connectionState === 'error'">
					<N8nCallout theme="danger">
						{{
							i18n.baseText(
								provider.connected
									? 'settings.externalSecrets.provider.testConnection.error.connected'
									: 'settings.externalSecrets.provider.testConnection.error',
								{ interpolate: { provider: displayName } },
							)
						}}
					</N8nCallout>
				</div>
				<!-- As in the enterprise modal, a field that its display options hide stays in the page, hidden. -->
				<form
					v-for="property in properties"
					v-show="isPropertyShown(property, providerData)"
					:key="property.name"
					autocomplete="off"
					data-test-id="external-secrets-provider-properties-form"
					@submit.prevent
				>
					<N8nNotice v-if="property.type === 'notice'" :content="property.displayName" />
					<ParameterInputExpanded
						v-else
						:parameter="property"
						:value="providerData[property.name]"
						:label="{ size: 'medium' }"
						@update="onValueChange"
					/>
				</form>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.title {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	font-size: var(--font-size--xl);
}

.actions {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);

	hr {
		width: 100%;
		border: 0;
		border-top: var(--border-width) var(--border-style) var(--color--foreground);
	}
}
</style>
