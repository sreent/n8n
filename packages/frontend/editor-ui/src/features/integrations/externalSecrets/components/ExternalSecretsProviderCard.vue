<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the card of a provider type on the settings page of external
 * secrets. `../FORK.md` describes it.
 */
import type { ExternalSecretsProvider } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { N8nActionToggle, N8nButton, N8nCard, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import dateformat from 'dateformat';
import { computed } from 'vue';

import { EXTERNAL_SECRETS_PROVIDER_MODAL_KEY } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';

import { useExternalSecretsStore } from '../externalSecrets.store';
import ExternalSecretsProviderConnectionSwitch from './ExternalSecretsProviderConnectionSwitch.vue';
import ExternalSecretsProviderImage from './ExternalSecretsProviderImage.vue';

type CardAction = 'setup' | 'reload';

const props = defineProps<{
	provider: ExternalSecretsProvider;
}>();

const externalSecretsStore = useExternalSecretsStore();
const uiStore = useUIStore();
const toast = useToast();
const i18n = useI18n();

/** A connected provider type, or one with stored settings, shows its switch. Else Set Up shows. */
const isSetUp = computed(
	() => props.provider.connected || Object.keys(props.provider.data ?? {}).length > 0,
);

const secretsCount = computed(() => externalSecretsStore.secrets[props.provider.name]?.length ?? 0);

/** Without a connection time, the card shows today, as the enterprise page does. */
const connectedAt = computed(() =>
	dateformat(props.provider.connectedAt || undefined, 'dd mmm yyyy'),
);

const actions = computed(() => [
	{
		label: i18n.baseText('settings.externalSecrets.card.actionDropdown.setup'),
		value: 'setup' as const,
	},
	...(props.provider.connected
		? [
				{
					label: i18n.baseText('settings.externalSecrets.card.actionDropdown.reload'),
					value: 'reload' as const,
				},
			]
		: []),
]);

function openModal() {
	uiStore.openModalWithData({
		name: EXTERNAL_SECRETS_PROVIDER_MODAL_KEY,
		data: { name: props.provider.name },
	});
}

async function reloadSecrets() {
	try {
		await externalSecretsStore.reloadProvider(props.provider.name);
		await externalSecretsStore.fetchGlobalSecrets();
		toast.showMessage({
			title: i18n.baseText('settings.externalSecrets.card.reload.success.title'),
			message: i18n.baseText('settings.externalSecrets.card.reload.success.description', {
				interpolate: { provider: props.provider.displayName },
			}),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	}
}

async function onAction(action: CardAction) {
	if (action === 'setup') openModal();
	if (action === 'reload') await reloadSecrets();
}
</script>

<template>
	<N8nCard>
		<div :class="$style.card">
			<ExternalSecretsProviderImage :provider="provider" />
			<div :class="$style.details">
				<N8nText bold>{{ provider.displayName }}</N8nText>
				<N8nText v-if="provider.connected" size="small" color="text-light">
					<span>
						{{
							i18n.baseText('settings.externalSecrets.card.secretsCount', {
								adjustToNumber: secretsCount,
								interpolate: { count: `${secretsCount}` },
							})
						}}
					</span>
					|
					<span>
						{{
							i18n.baseText('settings.externalSecrets.card.connectedAt', {
								interpolate: { date: connectedAt },
							})
						}}
					</span>
				</N8nText>
			</div>
			<div v-if="isSetUp" :class="$style.actions">
				<ExternalSecretsProviderConnectionSwitch :provider="provider" />
				<N8nActionToggle :actions="actions" @action="onAction" />
			</div>
			<N8nButton v-else variant="subtle" @click="openModal">
				{{ i18n.baseText('settings.externalSecrets.card.setUp') }}
			</N8nButton>
		</div>
	</N8nCard>
</template>

<style lang="scss" module>
.card {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
	width: 100%;
}

.details {
	display: flex;
	flex-direction: column;
	flex: 1;
	gap: var(--spacing--4xs);
}

.actions {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}
</style>
