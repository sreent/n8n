<script setup lang="ts">
// Fork code (not in upstream n8n): the list of runs of a workflow, with the button that starts or
// stops a run. It replaces the enterprise view of the same name. See `../FORK.md`.
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useToast } from '@n8n/composables/useToast';
import { N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, ref, watch } from 'vue';

import ParallelEvalControls from '../components/ListRuns/ParallelEvalControls.vue';
import RunsSection from '../components/ListRuns/RunsSection.vue';
import { useEvaluationStore } from '../evaluation.store';
import { indexTestRuns } from '../evaluation.utils';
import { useParallelEvalStore } from '../parallelEval.store';

const props = defineProps<{ workflowId: string; runsPageSize?: number }>();

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const evaluationStore = useEvaluationStore();
const parallelEvalStore = useParallelEvalStore();

const selectedMetric = ref('');
const isCancelling = ref(false);

const runs = computed(() =>
	indexTestRuns(evaluationStore.testRunsByWorkflowId[props.workflowId] ?? []),
);
const runningRun = computed(() => runs.value.find((testRun) => testRun.status === 'running'));

// A cancel waits for the backend to stop the run, and the next run can be cancelled again.
watch(
	() => runningRun.value?.id,
	() => {
		isCancelling.value = false;
	},
);

async function runTest() {
	const concurrency = parallelEvalStore.effectiveConcurrency(props.workflowId);
	try {
		await evaluationStore.startTestRun(
			props.workflowId,
			concurrency === undefined ? undefined : { concurrency },
		);
		telemetry.track('User ran evaluation', {
			workflow_id: props.workflowId,
			run_type: 'direct',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantStartTestRun'));
	}
	try {
		await evaluationStore.fetchTestRuns(props.workflowId);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantFetchTestRuns'));
	}
}

async function stopTest() {
	if (!runningRun.value) return;
	isCancelling.value = true;
	try {
		await evaluationStore.cancelTestRun(props.workflowId, runningRun.value.id);
	} catch (error) {
		isCancelling.value = false;
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantStopTestRun'));
	}
}

onMounted(async () => {
	try {
		await evaluationStore.fetchEvaluationConfigs(props.workflowId);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantFetchConfigs'));
	}
});
</script>

<template>
	<div :class="$style.container">
		<div :class="$style.header">
			<N8nButton
				v-if="runningRun"
				data-test-id="stop-test-button"
				variant="subtle"
				:label="i18n.baseText('evaluation.stopTest')"
				:disabled="isCancelling"
				@click="stopTest"
			/>
			<template v-else>
				<N8nButton
					data-test-id="run-test-button"
					:label="i18n.baseText('evaluation.runTest')"
					@click="runTest"
				/>
				<ParallelEvalControls
					v-if="parallelEvalStore.isConcurrencyAvailable"
					:workflow-id="workflowId"
				/>
			</template>
		</div>
		<RunsSection v-model:selected-metric="selectedMetric" :runs="runs" :workflow-id="workflowId" />
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

.header {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--4xs);
}
</style>
