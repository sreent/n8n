<script setup lang="ts">
// Fork code (not in upstream n8n): the comparison of the versions of a collection: the score of
// each metric, the insights, and the cases, outputs, metrics and workflows of the versions. It
// replaces the enterprise view of the same name. See `../FORK.md`.
import type { EvaluationCollectionDetail } from '@n8n/api-types';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';

import AiInsightsCard from '../components/Compare/AiInsightsCard.vue';
import CasesTable from '../components/Compare/CasesTable.vue';
import CompareHeader from '../components/Compare/CompareHeader.vue';
import CompareTabs from '../components/Compare/CompareTabs.vue';
import DatasetMismatchBanner from '../components/Compare/DatasetMismatchBanner.vue';
import MetricsTab from '../components/Compare/MetricsTab.vue';
import OutputsTab from '../components/Compare/OutputsTab.vue';
import ScoreChart from '../components/Compare/ScoreChart.vue';
import WorkflowDiffTab from '../components/Compare/WorkflowDiffTab.vue';
import { type CompareTab, useCompareData } from '../composables/useCompareData';
import { useEvaluationsLicense } from '../composables/useEvaluationsLicense';
import { isActiveCollection, useEvalCollectionsStore } from '../evalCollections.store';
import { canHaveInsights } from '../evalCollections.utils';
import * as evaluationApi from '../evaluation.api';
import { useEvaluationStore } from '../evaluation.store';
import type { TestCaseExecutionRecord } from '../evaluation.types';

const props = defineProps<{ workflowId: string; collectionId: string }>();

const i18n = useI18n();
const toast = useToast();
const router = useRouter();
const telemetry = useTelemetry();
const rootStore = useRootStore();
const collectionsStore = useEvalCollectionsStore();
const evaluationStore = useEvaluationStore();
const { ensureLicenseLoaded } = useEvaluationsLicense();

const notFound = ref(false);
const isRerunning = ref(false);
const casesByRunId = ref<Record<string, TestCaseExecutionRecord[]>>({});
const casesLoaded = ref(false);
const casesFailed = ref(false);
const insightsFailed = ref(false);
const tab = ref<CompareTab>('cases');
const selectedCase = ref(0);

const detail = computed(() => collectionsStore.getDetail(props.collectionId));
const isRunning = computed(() => (detail.value ? isActiveCollection(detail.value) : false));
const showInsights = computed(() => (detail.value ? canHaveInsights(detail.value) : false));
const insights = computed(() => collectionsStore.getInsights(props.collectionId));

const { versions, metricGroups, caseRows, datasetMismatch } = useCompareData(detail, casesByRunId);

/** The prompt of each metric with an LLM judge, for the criteria of the metric. */
const metricPrompts = computed(() => {
	const config = (evaluationStore.evaluationConfigsByWorkflowId[props.workflowId] ?? []).find(
		(item) => item.id === detail.value?.evaluationConfigId,
	);
	const prompts: Record<string, string> = {};
	for (const metric of config?.metrics ?? []) {
		if (metric.type === 'llm_judge' && metric.config.prompt) {
			prompts[metric.name] = metric.config.prompt;
		}
	}
	return prompts;
});

const statusOf = (error: unknown) =>
	typeof error === 'object' && error !== null && 'httpStatusCode' in error
		? error.httpStatusCode
		: undefined;

/** Loads the cases of some runs of the collection. A run without cases has an empty list. */
async function loadCases(runIds: string[]) {
	const cases = await Promise.all(
		runIds.map(
			async (runId) =>
				await evaluationApi
					.getTestCaseExecutions(rootStore.restApiContext, props.workflowId, runId)
					.catch((): TestCaseExecutionRecord[] => {
						casesFailed.value = true;
						return [];
					}),
		),
	);
	const byRunId = { ...casesByRunId.value };
	runIds.forEach((runId, index) => {
		byRunId[runId] = cases[index];
	});
	casesByRunId.value = byRunId;
}

async function loadInsights(forceRegenerate: boolean) {
	insightsFailed.value = false;
	try {
		await collectionsStore.generateInsights(props.workflowId, props.collectionId, forceRegenerate);
	} catch {
		insightsFailed.value = true;
	}
}

/**
 * After each answer of the polling: the cases of the runs that were active, and the insights when
 * the last run finished.
 */
async function onPolled(
	previous: EvaluationCollectionDetail | undefined,
	current: EvaluationCollectionDetail,
) {
	const wasActive = (previous?.runs ?? []).filter(
		(run) => run.status === 'running' || run.status === 'new',
	);
	if (wasActive.length) await loadCases(wasActive.map((run) => run.testRunId));
	if (previous && isActiveCollection(previous) && !isActiveCollection(current)) {
		if (canHaveInsights(current)) await loadInsights(false);
	}
}

async function load() {
	let collection: EvaluationCollectionDetail;
	try {
		collection = await collectionsStore.fetchCollectionDetail(props.workflowId, props.collectionId);
	} catch (error) {
		notFound.value = true;
		if (statusOf(error) !== 404) {
			toast.showError(error, i18n.baseText('evaluation.compare.errors.loadFailed'));
		}
		return;
	}
	await Promise.all([
		loadCases(collection.runs.map((run) => run.testRunId)),
		ensureLicenseLoaded(),
		evaluationStore.fetchEvaluationConfigs(props.workflowId).catch(() => []),
	]);
	casesLoaded.value = true;
	telemetry.track('Eval collection compared opened', {
		workflow_id: props.workflowId,
		collection_id: props.collectionId,
		version_count: collection.runs.length,
		case_count: caseRows.value.length,
	});
	if (canHaveInsights(collection)) await loadInsights(false);
	if (isActiveCollection(collection)) {
		collectionsStore.startPolling(props.workflowId, props.collectionId, onPolled);
	}
}

async function rerun() {
	isRerunning.value = true;
	try {
		await collectionsStore.rerunCollection(props.workflowId, props.collectionId);
		collectionsStore.startPolling(props.workflowId, props.collectionId, onPolled);
		await collectionsStore.fetchCollectionDetail(props.workflowId, props.collectionId);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.compare.errors.rerunFailed'));
	} finally {
		isRerunning.value = false;
	}
}

function drilldown(runIndex: number) {
	selectedCase.value = runIndex;
	tab.value = 'outputs';
}

async function back() {
	await router.push({ name: VIEWS.EVALUATION_EDIT, params: { workflowId: props.workflowId } });
}

onMounted(load);
onUnmounted(() => collectionsStore.stopPolling(props.collectionId));
</script>

<template>
	<div :class="$style.container" data-test-id="compare-collection-view">
		<div>
			<N8nButton
				data-test-id="compare-back"
				variant="ghost"
				size="small"
				icon="arrow-left"
				:label="i18n.baseText('evaluation.compare.backToList')"
				@click="back"
			/>
		</div>
		<div v-if="notFound" :class="$style.empty" data-test-id="compare-empty">
			<N8nText color="text-light">{{
				i18n.baseText('evaluation.compare.errors.notFound')
			}}</N8nText>
		</div>
		<template v-else-if="detail">
			<DatasetMismatchBanner v-if="datasetMismatch" :counts="datasetMismatch" />
			<CompareHeader
				:detail="detail"
				:versions="versions"
				:is-rerunning="isRerunning"
				@rerun="rerun"
			/>
			<div :class="$style.summary">
				<ScoreChart :metric-groups="metricGroups" :metric-prompts="metricPrompts" />
				<AiInsightsCard
					v-if="showInsights"
					:insights="insights"
					:failed="insightsFailed"
					@retry="loadInsights(true)"
				/>
			</div>
			<CompareTabs v-model="tab">
				<template v-if="tab === 'cases'">
					<N8nText
						v-if="isRunning"
						size="small"
						color="text-light"
						data-test-id="compare-cases-running"
						>{{ i18n.baseText('evaluation.compare.cases.running') }}</N8nText
					>
					<N8nText v-if="casesFailed" size="small" color="warning">{{
						i18n.baseText('evaluation.compare.cases.loadError')
					}}</N8nText>
					<N8nText v-if="!casesLoaded" size="small" color="text-light">{{
						i18n.baseText('evaluation.compare.cases.loading')
					}}</N8nText>
					<CasesTable
						v-else-if="caseRows.length"
						:versions="versions"
						:case-rows="caseRows"
						@drilldown="drilldown"
					/>
					<N8nText v-else-if="!isRunning" size="small" color="text-light">{{
						i18n.baseText('evaluation.compare.cases.empty')
					}}</N8nText>
				</template>
				<OutputsTab
					v-else-if="tab === 'outputs'"
					v-model:selected-index="selectedCase"
					:versions="versions"
					:case-rows="caseRows"
					:workflow-id="workflowId"
				/>
				<MetricsTab
					v-else-if="tab === 'metrics'"
					:metric-groups="metricGroups"
					:versions="versions"
					:metric-prompts="metricPrompts"
				/>
				<WorkflowDiffTab v-else :versions="versions" :workflow-id="workflowId" />
			</CompareTabs>
		</template>
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

.empty {
	display: flex;
	justify-content: center;
	padding: var(--spacing--xl);
}

.summary {
	display: grid;
	grid-template-columns: 3fr 2fr;
	gap: var(--spacing--sm);
}
</style>
