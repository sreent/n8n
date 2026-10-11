<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the switch that connects and disconnects a provider type.
 * `../FORK.md` describes it.
 */
import type { ExternalSecretsProvider } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { ElSwitch } from 'element-plus';
import { computed } from 'vue';

import {
	settingsToSend,
	useExternalSecretsProvider,
} from '../composables/useExternalSecretsProvider';
import { useExternalSecretsStore } from '../externalSecrets.store';

const props = withDefaults(
	defineProps<{
		provider: ExternalSecretsProvider;
		/** Disable the switch of a provider type that is not connected. */
		disabled?: boolean;
		/** Test the stored settings before a connect. The modal tests after the change. */
		testBeforeConnect?: boolean;
	}>(),
	{ disabled: false, testBeforeConnect: true },
);

const emit = defineEmits<{
	change: [connected: boolean];
}>();

const externalSecretsStore = useExternalSecretsStore();
const toast = useToast();
const i18n = useI18n();
const { testConnection } = useExternalSecretsProvider();

const connectionState = computed(() => externalSecretsStore.connectionState[props.provider.name]);

/** A connected provider type can always be disconnected. */
const isDisabled = computed(
	() => !props.provider.connected && (props.disabled || connectionState.value === 'error'),
);

/** Read the stored settings again and test them. Only a passing test allows the connect. */
async function testStoredSettings() {
	const provider = await externalSecretsStore.getProvider(props.provider.name);
	const state = await testConnection(
		provider.name,
		settingsToSend(provider.properties ?? [], provider.data ?? {}),
	);
	return state !== 'error';
}

async function onUpdateConnected(value: string | number | boolean) {
	const connected = value === true;
	if (connected && props.testBeforeConnect && !(await testStoredSettings())) return;

	try {
		await externalSecretsStore.updateProviderConnected(props.provider.name, connected);
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
		return;
	}
	await externalSecretsStore.fetchGlobalSecrets();
	emit('change', connected);
}
</script>

<template>
	<div :class="$style.switch">
		<N8nIcon v-if="provider.state === 'error'" icon="triangle-alert" color="danger" />
		<N8nText size="small" color="text-base">
			{{
				provider.connected
					? i18n.baseText('settings.externalSecrets.card.connected')
					: i18n.baseText('settings.externalSecrets.card.disconnected')
			}}
		</N8nText>
		<ElSwitch
			:model-value="provider.connected"
			:disabled="isDisabled"
			:title="
				i18n.baseText('settings.externalSecrets.card.connectedSwitch.title', {
					interpolate: { provider: provider.displayName },
				})
			"
			data-test-id="settings-external-secrets-connected-switch"
			@update:model-value="onUpdateConnected"
		/>
	</div>
</template>

<style lang="scss" module>
.switch {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}
</style>
