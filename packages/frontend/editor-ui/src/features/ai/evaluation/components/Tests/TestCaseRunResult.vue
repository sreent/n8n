<script setup lang="ts">
// Fork code (not in upstream n8n): the result of a case in a run: its state, its scores, and when
// open, the answer of the AI node and the tokens and the time. See `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { BaseTextKey } from '@n8n/i18n';
import dateformat from 'dateformat';
import { computed, watch } from 'vue';

import { OPERATIONAL_METRIC_KEYS, TEST_CASE_ERROR_MESSAGES } from '../../evaluation.constants';
import type { TestCaseExecutionRecord } from '../../evaluation.types';
import type { IndexedTestRun } from '../../evaluation.utils';
import { cannedMetric, isCannedMetricKey } from '../../wizard.constants';
import { answerText, readNodeOutput } from '../../wizard.utils';
import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import { injectTestsPanel } from './testsPanel.context';

const props = defineProps<{
	rowIndex: number;
	run: IndexedTestRun;
	testCase?: TestCaseExecutionRecord;
	running: boolean;
	expanded: boolean;
	/** `fresh` asks for the execution of the case each time the result opens. */
	load: 'cached' | 'fresh';
}>();

const i18n = useI18n();
const panel = injectTestsPanel();
const wizard = useEvaluationsWizardSidepanelStore();

const failed = computed(() => props.testCase?.status === 'error');
const errorText = computed(() => {
	const key = props.testCase?.errorCode
		? TEST_CASE_ERROR_MESSAGES[props.testCase.errorCode]
		: undefined;
	return i18n.baseText(key ?? 'evaluations.tests.results.runFailed');
});

const runLabel = computed(() =>
	i18n.baseText('evaluations.tests.results.runLabel', {
		interpolate: {
			number: String(props.run.index),
			date: props.run.runAt ? dateformat(props.run.runAt, 'mmm d HH:MM') : '',
		},
	}),
);

const metrics = computed(() => props.testCase?.metrics ?? {});

const badges = computed(() =>
	Object.entries(metrics.value)
		.filter(([key]) => !OPERATIONAL_METRIC_KEYS.includes(key))
		.map(([key, value]) => {
			const metric = isCannedMetricKey(key) ? cannedMetric(key) : undefined;
			const label = metric ? i18n.baseText(metric.optionLabelKey ?? metric.labelKey) : key;
			const text =
				typeof value === 'boolean'
					? String(value)
					: metric?.category === 'aiBased'
						? `${value}/5`
						: String(value);
			return { key, label, text };
		}),
);

const OPERATIONAL_LABELS: Record<string, BaseTextKey> = {
	promptTokens: 'evaluations.tests.results.metric.promptTokens',
	completionTokens: 'evaluations.tests.results.metric.completionTokens',
	totalTokens: 'evaluations.tests.results.metric.totalTokens',
	executionTime: 'evaluations.tests.results.metric.executionTime',
};

const operational = computed(() =>
	OPERATIONAL_METRIC_KEYS.filter((key) => typeof metrics.value[key] === 'number').map((key) => {
		const value = metrics.value[key];
		const text = key === 'executionTime' ? `${value}ms` : String(value);
		return {
			key,
			text: `${i18n.baseText(OPERATIONAL_LABELS[key])} ${text}`,
		};
	}),
);

const outputText = computed(() => {
	const executionId = props.testCase?.executionId;
	const execution = executionId ? panel.caseExecutions.value[executionId] : undefined;
	const output = execution
		? readNodeOutput(execution.data?.resultData?.runData, wizard.answerNodeName)
		: undefined;
	return answerText(output ?? props.testCase?.outputs ?? {});
});

let loadedFor: string | undefined;
watch(
	() => [props.expanded, props.testCase?.executionId] as const,
	([expanded, executionId]) => {
		if (!expanded || !executionId || loadedFor === executionId) return;
		loadedFor = executionId;
		void panel.loadCaseExecution(executionId, props.load === 'fresh');
	},
	{ immediate: true },
);
</script>

<template>
	<div v-if="running" :class="$style.header" :data-test-id="`tests-result-running-${rowIndex}`">
		<N8nIcon icon="spinner" spin size="small" />
		<N8nText size="small" color="text-base">{{
			i18n.baseText('evaluations.tests.results.running')
		}}</N8nText>
	</div>
	<div v-else :class="$style.result" :data-test-id="`tests-result-result-${rowIndex}`">
		<div :class="$style.header">
			<N8nIcon :icon="failed ? 'x' : 'check'" :color="failed ? 'danger' : 'success'" size="small" />
			<N8nText size="small" color="text-base">{{ runLabel }}</N8nText>
			<N8nText
				v-if="failed"
				size="small"
				color="danger"
				:data-test-id="`tests-result-error-${rowIndex}`"
				>{{ errorText }}</N8nText
			>
		</div>
		<N8nText v-if="expanded" size="small" color="text-light" bold>{{
			i18n.baseText('evaluations.tests.detail.output')
		}}</N8nText>
		<div v-if="badges.length" :class="$style.badges">
			<span
				v-for="badge in badges"
				:key="badge.key"
				:class="$style.badge"
				:data-test-id="`tests-result-badge-${rowIndex}-${badge.key}`"
				>{{ badge.label }} <strong>{{ badge.text }}</strong></span
			>
		</div>
		<template v-if="expanded">
			<N8nText size="small" color="text-dark" :class="$style.output">{{ outputText }}</N8nText>
			<div
				v-if="operational.length"
				:class="$style.operational"
				:data-test-id="`tests-result-operational-${rowIndex}`"
			>
				<N8nText v-for="item in operational" :key="item.key" size="xsmall" color="text-light">{{
					item.text
				}}</N8nText>
			</div>
		</template>
	</div>
</template>

<style module lang="scss">
.result {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.badges {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--3xs);
}

.badge {
	padding: var(--spacing--5xs) var(--spacing--3xs);
	border-radius: var(--radius);
	background-color: var(--color--background--light-1);
	font-size: var(--font-size--2xs);
}

.output {
	white-space: pre-wrap;
	word-break: break-word;
}

.operational {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--xs);
}
</style>
