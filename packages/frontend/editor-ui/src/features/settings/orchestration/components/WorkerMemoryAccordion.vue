<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the memory of a worker and of its host. A worker in a
 * container also shows the memory limit of the container. See `../FORK.md`.
 */
import type { WorkerStatus } from '@n8n/api-types';
import { N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { memAsGb, memAsMb } from '../orchestration.utils';
import WorkerAccordion from './WorkerAccordion.vue';

const props = defineProps<{ worker: WorkerStatus }>();

const i18n = useI18n();

const hostRows = computed(() => [
	{
		label: i18n.baseText('workerList.item.memory.total'),
		value: `${memAsGb(props.worker.host.memory.total)}GB`,
	},
	{
		label: i18n.baseText('workerList.item.memory.free'),
		value: `${memAsGb(props.worker.host.memory.free)}GB`,
	},
]);

const processRows = computed(() => {
	const { memory } = props.worker.process;
	return [
		...(props.worker.isInContainer
			? [
					{
						label: i18n.baseText('workerList.item.memory.constraint'),
						value: `${memAsMb(memory.constraint)}MB`,
					},
				]
			: []),
		{
			label: i18n.baseText('workerList.item.memory.available'),
			value: `${memAsMb(memory.available)}MB`,
		},
		{ label: i18n.baseText('workerList.item.memory.rss'), value: `${memAsMb(memory.rss)}MB` },
		{
			label: i18n.baseText('workerList.item.memory.heapTotal'),
			value: `${memAsMb(memory.heapTotal)}MB`,
		},
		{
			label: i18n.baseText('workerList.item.memory.heapUsed'),
			value: `${memAsMb(memory.heapUsed)}MB`,
		},
	];
});
</script>

<template>
	<WorkerAccordion :title="i18n.baseText('workerList.item.memoryMonitorTitle')">
		<div :class="$style.memory">
			<N8nText size="small" bold>{{ i18n.baseText('workerList.item.memory.host') }}</N8nText>
			<div v-for="row in hostRows" :key="row.label" :class="$style.row">
				<N8nText size="small" color="text-base">{{ row.label }}</N8nText>
				<N8nText size="small">{{ row.value }}</N8nText>
			</div>
			<N8nText size="small" bold>{{ i18n.baseText('workerList.item.memory.process') }}</N8nText>
			<div v-for="row in processRows" :key="row.label" :class="$style.row">
				<N8nText size="small" color="text-base">{{ row.label }}</N8nText>
				<N8nText size="small">{{ row.value }}</N8nText>
			</div>
		</div>
	</WorkerAccordion>
</template>

<style lang="scss" module>
.memory {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.row {
	display: flex;
	gap: var(--spacing--xs);
}
</style>
