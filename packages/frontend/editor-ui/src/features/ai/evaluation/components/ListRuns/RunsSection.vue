<script setup lang="ts">
// Fork code (not in upstream n8n): the chart of a chosen metric and the table of all runs of a
// workflow. See `../../FORK.md`.
import { N8nHeading, N8nOption, N8nSelect } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';

import type { IndexedTestRun } from '../../evaluation.utils';
import { collectMetricKeys, isOperationalMetric, newestFirst } from '../../evaluation.utils';
import MetricsChart from './MetricsChart.vue';
import TestRunsTable from './TestRunsTable.vue';

const props = defineProps<{
	/** The runs, the oldest first. */
	runs: IndexedTestRun[];
	workflowId: string;
}>();

const selectedMetric = defineModel<string>('selectedMetric', { required: true });

const i18n = useI18n();
const router = useRouter();

const metricKeys = computed(() => collectMetricKeys(props.runs));
const userMetricKeys = computed(() => metricKeys.value.filter((key) => !isOperationalMetric(key)));
const tableRuns = computed(() => newestFirst(props.runs));
const runsHeading = computed(
	() =>
		`${i18n.baseText('evaluation.listRuns.pastRuns.total', { adjustToNumber: props.runs.length })} (${props.runs.length})`,
);

// The chart shows the first metric of the workflow until the user picks another one.
watch(
	userMetricKeys,
	(keys) => {
		if (!keys.includes(selectedMetric.value)) selectedMetric.value = keys[0] ?? '';
	},
	{ immediate: true },
);

async function openRun(testRun: IndexedTestRun) {
	await router.push({
		name: VIEWS.EVALUATION_RUNS_DETAIL,
		params: { workflowId: props.workflowId, runId: testRun.id },
	});
}
</script>

<template>
	<div :class="$style.section">
		<div :class="$style.chartCard">
			<div :class="$style.chartHeader">
				<N8nSelect
					v-model="selectedMetric"
					size="small"
					:class="$style.metricSelect"
					:placeholder="i18n.baseText('evaluation.listRuns.selectMetric')"
				>
					<N8nOption v-for="key in userMetricKeys" :key="key" :label="key" :value="key" />
				</N8nSelect>
			</div>
			<MetricsChart :runs="runs" :selected-metric="selectedMetric" />
		</div>
		<div :class="$style.runs" data-test-id="past-runs-table">
			<N8nHeading size="small" bold>{{ runsHeading }}</N8nHeading
			>{{ ' ' }}<TestRunsTable :runs="tableRuns" :metric-keys="metricKeys" @row-click="openRun" />
		</div>
	</div>
</template>

<style module lang="scss">
.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
}

.chartCard {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.chartHeader {
	display: flex;
	justify-content: flex-end;
}

.metricSelect {
	width: 200px;
}

.runs {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}
</style>
