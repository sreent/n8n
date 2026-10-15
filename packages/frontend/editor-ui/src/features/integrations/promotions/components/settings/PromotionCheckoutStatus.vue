<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the state of the local copy (the checkout) of one direction of
 * the instance connection, with the buttons that connect and disconnect it. See `../../FORK.md`.
 */
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import type { IconName } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import type { CheckoutState } from '../../composables/usePromotionConnectionForm';

const props = defineProps<{
	state: CheckoutState;
	/** The saved branch of the direction. */
	branch: string;
	/** The form has changes that are not saved. */
	dirty: boolean;
	busy: boolean;
}>();

const emit = defineEmits<{ connect: []; disconnect: [] }>();

const i18n = useI18n();

const icon = computed<IconName>(() => {
	if (props.state === 'connected') return 'circle-check';
	if (props.state === 'stale') return 'triangle-alert';
	return 'circle-dot';
});

const message = computed(() => {
	switch (props.state) {
		case 'unsaved':
			return i18n.baseText('settings.promotions.connection.checkout.saveFirst');
		case 'connected':
			return i18n.baseText('settings.promotions.connection.checkout.connected', {
				interpolate: { branch: props.branch },
			});
		case 'stale':
			return i18n.baseText('settings.promotions.connection.checkout.stale');
		default:
			return props.dirty
				? i18n.baseText('settings.promotions.connection.checkout.saveChangesFirst')
				: i18n.baseText('settings.promotions.connection.checkout.notConnected');
	}
});

const showConnect = computed(() => props.state !== 'connected');
const showDisconnect = computed(() => props.state === 'connected' || props.state === 'stale');
const connectDisabled = computed(() => props.state === 'unsaved' || props.dirty || props.busy);
</script>

<template>
	<div :class="$style.status" data-test-id="promotion-checkout-status">
		<N8nIcon :icon="icon" size="small" :class="$style[state]" />
		<N8nText size="small" color="text-base" :class="$style.message">{{ message }}</N8nText>
		<N8nButton
			v-if="showConnect"
			variant="outline"
			size="small"
			:disabled="connectDisabled"
			data-test-id="promotion-checkout-connect"
			@click="emit('connect')"
		>
			{{ i18n.baseText('settings.promotions.connection.checkout.connect') }}
		</N8nButton>
		<N8nButton
			v-if="showDisconnect"
			variant="subtle"
			size="small"
			:disabled="busy"
			data-test-id="promotion-checkout-disconnect"
			@click="emit('disconnect')"
		>
			{{ i18n.baseText('settings.promotions.connection.checkout.disconnect') }}
		</N8nButton>
	</div>
</template>

<style module lang="scss">
.status {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.message {
	flex: 1;
}

.connected {
	color: var(--color--success);
}

.stale {
	color: var(--color--warning);
}
</style>
