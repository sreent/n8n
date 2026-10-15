<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the card of one worker on the page Settings > Workers. The age
 * of the newest status counts up each half second, and a worker without a status for more than
 * 10 seconds shows as stale. See `../FORK.md`.
 */
import { N8nCard, N8nHeading, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { useOrchestrationStore } from '../orchestration.store';
import {
	averageWorkerLoadFromLoadsAsString,
	memAsGb,
	upTime,
	workerMemoryTotal,
} from '../orchestration.utils';
import WorkerChartsAccordion from './WorkerChartsAccordion.vue';
import WorkerJobAccordion from './WorkerJobAccordion.vue';
import WorkerMemoryAccordion from './WorkerMemoryAccordion.vue';
import WorkerNetAccordion from './WorkerNetAccordion.vue';

const props = defineProps<{ workerId: string }>();

const AGE_UPDATE_INTERVAL_MS = 500;
const STALE_AFTER_SECONDS = 10;

const i18n = useI18n();
const orchestrationStore = useOrchestrationStore();

const worker = computed(() => orchestrationStore.getWorkerStatus(props.workerId));
const secondsSinceLastUpdate = ref(0);
const isStale = computed(() => secondsSinceLastUpdate.value > STALE_AFTER_SECONDS);

// The leading space keeps the text of a card apart from the text before it, as in upstream n8n.
// A browser does not show it.
const nameLine = computed(() => {
	if (!worker.value) return '';
	const { senderId, hostname, poolName, queueName } = worker.value;
	const pool = poolName || i18n.baseText('workerList.item.pool.default');
	const parts = [
		`${i18n.baseText('workerList.item.name')}: ${senderId} (${hostname})`,
		`${i18n.baseText('workerList.item.pool')}: ${pool}`,
		`${i18n.baseText('workerList.item.queue')}: ${queueName}`,
	];
	return ` ${parts.join(' | ')}`;
});

const loadLine = computed(() => {
	if (!worker.value) return '';
	const free = memAsGb(worker.value.process.memory.available);
	const total = memAsGb(workerMemoryTotal(worker.value));
	return [
		`${i18n.baseText('workerList.item.averageLoad')}: ${averageWorkerLoadFromLoadsAsString(worker.value.loadAvg)}`,
		`${i18n.baseText('workerList.item.freeMemory')}: ${free}GB / ${total}GB`,
	].join(' | ');
});

const detailsLine = computed(() => {
	if (!worker.value) return '';
	const { version, arch, platform, uptime } = worker.value;
	return [
		`${i18n.baseText('workerList.item.lastUpdated')} ${i18n.baseText('workerList.item.secondsAgo', {
			interpolate: { seconds: String(secondsSinceLastUpdate.value) },
		})}`,
		`${i18n.baseText('workerList.item.version')}: ${version}`,
		`${i18n.baseText('workerList.item.architecture')}: ${arch} ( ${platform})`,
		`${i18n.baseText('workerList.item.uptime')}: ${upTime(uptime)}`,
	].join(' | ');
});

const sortedInterfaces = computed(() =>
	[...(worker.value?.interfaces ?? [])].sort((a, b) => a.family.localeCompare(b.family)),
);

function updateAge() {
	const lastUpdated = orchestrationStore.getWorkerLastUpdated(props.workerId);
	secondsSinceLastUpdate.value = Math.ceil((Date.now() - lastUpdated) / 1_000);
}

let ageInterval: ReturnType<typeof setInterval> | undefined;

// The age shows 0 until the first update, half a second after the card appears.
onMounted(() => {
	ageInterval = setInterval(updateAge, AGE_UPDATE_INTERVAL_MS);
});

onBeforeUnmount(() => {
	clearInterval(ageInterval);
});
</script>

<template>
	<N8nCard v-if="worker" :class="$style.card">
		<template #header>
			<N8nHeading tag="h2" size="small" bold :class="$style.name" data-test-id="worker-card-name">
				{{ nameLine }}<br />
				{{ loadLine }}
				<span v-if="isStale" :class="$style.stale">{{
					i18n.baseText('workerList.item.stale')
				}}</span>
			</N8nHeading>
		</template>
		<div :class="$style.body">
			<N8nText size="small" color="text-light">{{ detailsLine }}</N8nText>
			<WorkerJobAccordion :items="worker.runningJobsSummary" />
			<WorkerNetAccordion :items="sortedInterfaces" />
			<WorkerChartsAccordion :worker-id="workerId" />
			<WorkerMemoryAccordion :worker="worker" />
		</div>
		<template #append>
			<div :class="$style.actions" />
		</template>
	</N8nCard>
</template>

<style lang="scss" module>
.card {
	align-items: flex-start;
}

.name {
	line-height: var(--line-height--xl);
}

.stale {
	color: var(--color--danger);
}

.body {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	margin-top: var(--spacing--2xs);
}

.actions {
	display: flex;
	gap: var(--spacing--2xs);
}
</style>
