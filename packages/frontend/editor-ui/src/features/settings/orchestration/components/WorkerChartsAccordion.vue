<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the charts of a worker over its last statuses: the running
 * jobs, the mean load of the processor and the used memory in percent. See `../FORK.md`.
 */
import type { ChartData, ChartOptions } from 'chart.js';
import { useI18n } from '@n8n/i18n';
import { ref, watch } from 'vue';
import { Line } from 'vue-chartjs';

import { useOrchestrationStore, WORKER_HISTORY_LENGTH } from '../orchestration.store';
import { averageWorkerLoadFromLoads, workerMemoryUsage } from '../orchestration.utils';
import WorkerAccordion from './WorkerAccordion.vue';

const props = defineProps<{ workerId: string }>();

const i18n = useI18n();
const orchestrationStore = useOrchestrationStore();

type Series = { labels: string[]; jobs: number[]; load: number[]; memory: number[] };

/** Fills the series up to the length of the history, so that new points come in from the right. */
function padded<T>(values: T[], blank: T): T[] {
	return [...Array<T>(WORKER_HISTORY_LENGTH - values.length).fill(blank), ...values];
}

function emptySeries(): Series {
	return {
		labels: Array<string>(WORKER_HISTORY_LENGTH).fill(''),
		jobs: Array<number>(WORKER_HISTORY_LENGTH).fill(0),
		load: Array<number>(WORKER_HISTORY_LENGTH).fill(0),
		memory: Array<number>(WORKER_HISTORY_LENGTH).fill(0),
	};
}

const series = ref<Series>(emptySeries());

function updateSeries() {
	const history = orchestrationStore.getWorkerStatusHistory(props.workerId);
	const entries = history.slice(-WORKER_HISTORY_LENGTH);
	series.value = {
		labels: padded(
			entries.map((entry) => new Date(entry.timestamp).toLocaleTimeString()),
			'',
		),
		jobs: padded(
			entries.map((entry) => entry.data.runningJobsSummary.length),
			0,
		),
		load: padded(
			entries.map((entry) => averageWorkerLoadFromLoads(entry.data.loadAvg)),
			0,
		),
		memory: padded(
			entries.map((entry) => workerMemoryUsage(entry.data)),
			0,
		),
	};
}

// The charts follow each new status of any worker. The watcher runs in the update of the store,
// before the store adds the status to the history, so the newest point comes with the next status.
watch(() => orchestrationStore.workers, updateSeries, { deep: true, flush: 'sync' });

function chartData(label: string, data: number[], color: string): ChartData<'line'> {
	return {
		labels: series.value.labels,
		datasets: [{ label, data, borderColor: color, backgroundColor: color, fill: false }],
	};
}

function chartOptions(suggestedMax: number): ChartOptions<'line'> {
	return {
		responsive: true,
		maintainAspectRatio: true,
		scales: {
			y: { type: 'linear', display: true, position: 'left', min: 0, suggestedMax },
		},
	};
}
</script>

<template>
	<WorkerAccordion :title="i18n.baseText('workerList.item.chartsTitle')">
		<div :class="$style.charts">
			<div :class="$style.chart">
				<Line
					:data="chartData(i18n.baseText('workerList.item.chart.jobCount'), series.jobs, '#ff6d5a')"
					:options="chartOptions(5)"
				/>
			</div>
			<div :class="$style.chart">
				<Line
					:data="
						chartData(i18n.baseText('workerList.item.chart.processorUsage'), series.load, '#5a9cff')
					"
					:options="chartOptions(100)"
				/>
			</div>
			<div :class="$style.chart">
				<Line
					:data="
						chartData(i18n.baseText('workerList.item.chart.memoryUsage'), series.memory, '#38b26a')
					"
					:options="chartOptions(100)"
				/>
			</div>
		</div>
	</WorkerAccordion>
</template>

<style lang="scss" module>
.charts {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--xs);
}

.chart {
	flex: 1 1 0;
	min-width: 0;
}
</style>
