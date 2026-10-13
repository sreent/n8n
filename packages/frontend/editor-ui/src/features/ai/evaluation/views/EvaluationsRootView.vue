<script setup lang="ts">
// Fork code (not in upstream n8n): the Evaluations tab of a workflow. Before the first run it
// shows the setup steps (or the paywall without a licence), and after it the page of the child
// route: the list of runs, the detail of a run or a comparison. It replaces the enterprise view of
// the same name. See `../FORK.md`.
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useToast } from '@n8n/composables/useToast';
import { N8nLink, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useUsageStore } from '@/features/settings/usage/usage.store';

import EvaluationsPaywall from '../components/Paywall/EvaluationsPaywall.vue';
import SetupWizard from '../components/SetupWizard/SetupWizard.vue';
import { useWorkflowEvaluationState } from '../composables/useWorkflowEvaluationState';
import { EVALUATION_DOCS_URL } from '../evaluation.constants';
import { useEvaluationStore } from '../evaluation.store';

const props = defineProps<{ workflowId: string }>();

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const usageStore = useUsageStore();
const workflowsStore = useWorkflowsStore();
const evaluationStore = useEvaluationStore();
const { evaluationTriggerExists, evaluationSetOutputsNodeExist, evaluationSetMetricsNodeExist } =
	useWorkflowEvaluationState();

const isReady = ref(false);

const runs = computed(() => evaluationStore.testRunsByWorkflowId[props.workflowId] ?? []);
const showSetup = computed(() => runs.value.length === 0);
const isLicensed = computed(() => usageStore.workflowsWithEvaluationsLimit !== 0);
const quotaReached = computed(() => {
	const limit = usageStore.workflowsWithEvaluationsLimit;
	return limit !== -1 && usageStore.workflowsWithEvaluationsCount >= limit;
});

async function load() {
	try {
		await Promise.all([
			usageStore.getLicenseInfo(),
			workflowsStore.isWorkflowSaved[props.workflowId]
				? evaluationStore.fetchTestRuns(props.workflowId)
				: undefined,
		]);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantFetchTestRuns'));
	}
}

function trackView() {
	const common = { workflow_id: props.workflowId, test_type: 'evaluation' };
	if (showSetup.value) {
		telemetry.track('User viewed tests tab', {
			...common,
			view: 'setup',
			trigger_set_up: evaluationTriggerExists.value,
			output_set_up: evaluationSetOutputsNodeExist.value,
			metrics_set_up: evaluationSetMetricsNodeExist.value,
			quota_reached: quotaReached.value,
		});
	} else {
		telemetry.track('User viewed tests tab', {
			...common,
			view: 'overview',
			run_count: runs.value.length,
		});
	}
}

/** The first run, from the last setup step. It runs one case at a time. */
async function runFirstTest() {
	try {
		await evaluationStore.startTestRun(props.workflowId);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantStartTestRun'));
	}
	try {
		await evaluationStore.fetchTestRuns(props.workflowId);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.listRuns.error.cantFetchTestRuns'));
	}
}

onMounted(async () => {
	await load();
	isReady.value = true;
	trackView();
});

onUnmounted(() => {
	evaluationStore.cleanupPolling();
});
</script>

<template>
	<div :class="$style.container">
		<template v-if="isReady">
			<div v-if="showSetup" :class="$style.setup">
				<div :class="$style.intro">
					<N8nText tag="h3" size="xlarge" color="text-dark" bold>{{
						i18n.baseText('evaluations.setupWizard.title')
					}}</N8nText>
					<N8nText tag="p" color="text-base"
						>{{ i18n.baseText('evaluations.setupWizard.description') }}
						<N8nLink :to="EVALUATION_DOCS_URL" new-window>{{
							i18n.baseText('evaluations.setupWizard.moreInfo')
						}}</N8nLink></N8nText
					>
				</div>
				<EvaluationsPaywall v-if="!isLicensed" />
				<SetupWizard v-else :workflow-id="workflowId" @run-test="runFirstTest" />
			</div>
			<RouterView v-else />
		</template>
	</div>
</template>

<style module lang="scss">
.container {
	height: 100%;
	width: 100%;
	overflow: auto;
	padding: var(--spacing--lg) var(--spacing--xl);
}

.setup {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	max-width: 720px;
	margin: 0 auto;
}

.intro {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}
</style>
