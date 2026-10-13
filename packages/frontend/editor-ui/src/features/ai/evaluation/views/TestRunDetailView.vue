<script setup lang="ts">
// Fork code (not in upstream n8n): the detail of one run: its state, the average of each metric
// with the change from the previous run, and a card for each test case. It replaces the
// enterprise view of the same name. See `../FORK.md`.
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useToast } from '@n8n/composables/useToast';
import { N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';

import MetricSummaryStrip from '../components/RunDetail/MetricSummaryStrip.vue';
import RunStatusPill from '../components/RunDetail/RunStatusPill.vue';
import TestCaseCard from '../components/RunDetail/TestCaseCard.vue';
import { useWorkflowEvaluationState } from '../composables/useWorkflowEvaluationState';
import { POLLING_INTERVAL_MS } from '../evaluation.constants';
import { useEvaluationStore } from '../evaluation.store';
import type { TestCaseExecutionRecord } from '../evaluation.types';
import {
	indexTestRuns,
	isActiveRun,
	sortTestCases,
	userDefinedMetricKeys,
} from '../evaluation.utils';

const props = defineProps<{ workflowId: string; runId: string }>();

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const router = useRouter();
const evaluationStore = useEvaluationStore();
const { metricSourceByKey } = useWorkflowEvaluationState();

const workflowId = computed(() => props.workflowId);
const runId = computed(() => props.runId);

const cancellingCaseIds = ref(new Set<string>());
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let unmounted = false;

const runs = computed(() =>
	indexTestRuns(evaluationStore.testRunsByWorkflowId[workflowId.value] ?? []),
);
const run = computed(() => evaluationStore.testRunsById[runId.value]);
const index = computed(() => runs.value.find((item) => item.id === runId.value)?.index ?? 0);
/** The last completed run before this run, for the change of each metric. */
const previousRun = computed(() =>
	runs.value.findLast((item) => item.index < index.value && item.status === 'completed'),
);
const testCases = computed(() =>
	sortTestCases(
		Object.values(evaluationStore.testCaseExecutionsById).filter(
			(testCase) => testCase.testRunId === runId.value,
		),
	),
);
const hasMetrics = computed(() => userDefinedMetricKeys(run.value?.metrics).length > 0);

async function loadRun() {
	const testRun = await evaluationStore.getTestRun({
		workflowId: workflowId.value,
		runId: runId.value,
	});
	await evaluationStore.fetchTestCaseExecutions({
		workflowId: workflowId.value,
		runId: runId.value,
	});
	return testRun;
}

/** Asks for the run and its cases each second while it is active. */
function schedulePoll() {
	pollTimer = setTimeout(async () => {
		try {
			const testRun = await loadRun();
			if (!unmounted && isActiveRun(testRun)) schedulePoll();
		} catch {
			// The next visit of the page shows the error.
		}
	}, POLLING_INTERVAL_MS);
}

function trackView() {
	telemetry.track('User viewed run detail', {
		workflow_id: workflowId.value,
		run_id: runId.value,
		test_case_count: testCases.value.length,
		failed_test_case_count: testCases.value.filter((testCase) => testCase.status === 'error')
			.length,
		metric_count: userDefinedMetricKeys(run.value?.metrics).length,
		has_previous_run: previousRun.value !== undefined,
	});
}

async function backToRuns() {
	await router.push({ name: VIEWS.EVALUATION_EDIT, params: { workflowId: workflowId.value } });
}

function openExecution(testCase: TestCaseExecutionRecord) {
	if (!testCase.executionId) return;
	telemetry.track('User opened execution from run detail', {
		workflow_id: workflowId.value,
		run_id: runId.value,
		test_case_id: testCase.id,
	});
	const { href } = router.resolve({
		name: VIEWS.EXECUTION_PREVIEW,
		params: { workflowId: workflowId.value, executionId: testCase.executionId },
	});
	window.open(href, '_blank');
}

async function cancelCase(testCase: TestCaseExecutionRecord) {
	cancellingCaseIds.value.add(testCase.id);
	try {
		await evaluationStore.cancelTestCase({
			workflowId: workflowId.value,
			runId: runId.value,
			caseId: testCase.id,
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.runDetail.testCase.cancelError'));
	} finally {
		cancellingCaseIds.value.delete(testCase.id);
	}
}

/** Starts a new run of the workflow and opens it. */
async function rerun() {
	try {
		const { testRunId } = await evaluationStore.startTestRun(workflowId.value);
		telemetry.track('User ran evaluation', {
			workflow_id: workflowId.value,
			run_id: testRunId,
			run_type: 'direct',
		});
		await evaluationStore.fetchTestRuns(workflowId.value);
		await router.push({
			name: VIEWS.EVALUATION_RUNS_DETAIL,
			params: { workflowId: workflowId.value, runId: testRunId },
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantStartTestRun'));
	}
}

onMounted(async () => {
	try {
		const [, testRun] = await Promise.all([
			evaluationStore.fetchTestRuns(workflowId.value),
			loadRun(),
		]);
		trackView();
		if (isActiveRun(testRun)) schedulePoll();
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.toast.error.fetchTestCases'));
	}
});

onUnmounted(() => {
	unmounted = true;
	clearTimeout(pollTimer);
});
</script>

<template>
	<div :class="$style.container" data-test-id="test-definition-run-detail">
		<button type="button" :class="$style.back" @click="backToRuns">
			<N8nIcon icon="arrow-left" size="small" />
			<N8nText size="small">{{ i18n.baseText('evaluation.runDetail.backToRuns') }}</N8nText>
		</button>
		<div :class="$style.title">
			<h1 :class="$style.heading">
				{{
					i18n.baseText('evaluation.listRuns.testCasesListHeader', {
						interpolate: { index: String(index) },
					})
				}}
			</h1>
			<RunStatusPill v-if="run" :status="run.status" />
		</div>
		<MetricSummaryStrip
			v-if="run?.metrics && hasMetrics"
			:current-metrics="run.metrics"
			:previous-metrics="previousRun?.metrics ?? null"
			:metric-sources="metricSourceByKey"
		/>
		<div :class="$style.cases">
			<TestCaseCard
				v-for="(testCase, position) in testCases"
				:key="testCase.id"
				:test-case="testCase"
				:index="position + 1"
				:metric-sources="metricSourceByKey"
				:cancel-disabled="cancellingCaseIds.has(testCase.id)"
				@view="openExecution(testCase)"
				@cancel="cancelCase(testCase)"
				@rerun="rerun"
			/>
		</div>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
	max-width: 1200px;
	margin: 0 auto;
}

.back {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	width: fit-content;
	padding: 0;
	border: none;
	background: none;
	color: var(--color--text--tint-1);
	cursor: pointer;
}

.title {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
}

.heading {
	margin: 0;
	font-size: var(--font-size--xl);
	font-weight: var(--font-weight--bold);
}

.cases {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}
</style>
