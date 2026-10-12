<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the card of one log streaming destination on the settings page.
 * The switch turns the destination on or off. `../FORK.md` describes it.
 */
import { useToast } from '@n8n/composables/useToast';
import {
	N8nActionToggle,
	N8nCard,
	N8nHeading,
	N8nSwitch,
	N8nText,
	useMessage,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { EventDestination } from '@n8n/rest-api-client/api/eventbus';
import { computed, ref } from 'vue';

import { MODAL_CONFIRM } from '@/app/constants';

import { useLogStreamingStore } from '../logStreaming.store';
import { typeLabel } from '../logStreaming.utils';

const props = defineProps<{
	destination: EventDestination;
	readOnly?: boolean;
}>();

const emit = defineEmits<{
	open: [destination: EventDestination];
}>();

const logStreamingStore = useLogStreamingStore();
const toast = useToast();
const message = useMessage();
const i18n = useI18n();

const isSaving = ref(false);

const label = computed(() => props.destination.label ?? props.destination.id);
const actions = computed(() => [
	{ label: i18n.baseText('generic.open'), value: 'open' },
	...(props.readOnly
		? []
		: [{ label: i18n.baseText('settings.log-streaming.delete'), value: 'delete' }]),
]);

async function setEnabled(enabled: boolean) {
	isSaving.value = true;
	try {
		await logStreamingStore.saveDestination({ ...props.destination, enabled });
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.log-streaming.saveError'));
	} finally {
		isSaving.value = false;
	}
}

/** Asks first, then deletes the destination. */
async function deleteDestination() {
	const answer = await message.confirm(
		i18n.baseText('settings.log-streaming.destinationDelete.message', {
			interpolate: { destinationName: label.value },
		}),
		i18n.baseText('settings.log-streaming.destinationDelete.headline'),
		{
			type: 'warning',
			confirmButtonText: i18n.baseText(
				'settings.log-streaming.destinationDelete.confirmButtonText',
			),
			cancelButtonText: i18n.baseText('generic.cancel'),
		},
	);
	if (answer !== MODAL_CONFIRM) return;
	try {
		await logStreamingStore.deleteDestination(props.destination.id);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.log-streaming.deleteError'));
	}
}

async function onAction(action: string) {
	if (action === 'open') emit('open', props.destination);
	if (action === 'delete') await deleteDestination();
}
</script>

<template>
	<N8nCard
		:class="$style.card"
		hoverable
		data-test-id="destination-card"
		@click="emit('open', destination)"
	>
		<template #header>
			<div :class="$style.title">
				<N8nHeading tag="h2" size="small" bold>{{ label }}</N8nHeading>
				<N8nText size="small" color="text-light">
					{{ typeLabel(i18n, destination.__type) }}
				</N8nText>
			</div>
		</template>
		<template #append>
			<div :class="$style.controls" @click.stop>
				<N8nSwitch
					:model-value="destination.enabled === true"
					:disabled="readOnly || isSaving"
					:aria-label="label"
					data-test-id="workflow-activate-switch"
					@update:model-value="setEnabled"
				/>
				<N8nActionToggle :actions="actions" theme="dark" @action="onAction" />
			</div>
		</template>
	</N8nCard>
</template>

<style lang="scss" module>
.card {
	cursor: pointer;
}

.title {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.controls {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
}
</style>
