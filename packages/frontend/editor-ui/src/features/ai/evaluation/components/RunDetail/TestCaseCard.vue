<script setup lang="ts">
// Fork code (not in upstream n8n): one test case of a run: its state, its tokens and time, and a
// row for each metric or for its error. See `../../FORK.md`.
import { N8nButton, N8nCard, N8nIcon, N8nSpinner, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { useCyclingVerb } from '../../composables/useCyclingVerb';
import { TEST_CASE_ERROR_MESSAGES } from '../../evaluation.constants';
import type { MetricSource, TestCaseExecutionRecord } from '../../evaluation.types';
import {
	formatDuration,
	formatMetricLabel,
	formatPercent,
	formatTokens,
	isRunningTestCase,
	normalizeMetricValue,
	userDefinedMetricKeys,
} from '../../evaluation.utils';

const props = defineProps<{
	testCase: TestCaseExecutionRecord;
	index: number;
	metricSources: Record<string, MetricSource>;
	cancelDisabled?: boolean;
}>();

const emit = defineEmits<{ view: []; cancel: []; rerun: [] }>();

const i18n = useI18n();
const verb = useCyclingVerb();

const isRunning = computed(() => isRunningTestCase(props.testCase));
const isPending = computed(() => props.testCase.status === 'new');
const isCancelled = computed(() => props.testCase.status === 'cancelled');
const isFailed = computed(() => !!props.testCase.errorCode || props.testCase.status === 'error');
const isFinished = computed(() => !isRunning.value && !isPending.value && !isCancelled.value);

const tokens = computed(() => props.testCase.metrics?.totalTokens);
const duration = computed(() => props.testCase.metrics?.executionTime);
const hasUsage = computed(
	() => typeof tokens.value === 'number' && typeof duration.value === 'number',
);

const errorMessage = computed(() =>
	i18n.baseText(
		TEST_CASE_ERROR_MESSAGES[props.testCase.errorCode ?? ''] ??
			'evaluation.runDetail.error.unknownError',
		{ interpolate: { link: '' } },
	),
);

const metricRows = computed(() =>
	userDefinedMetricKeys(props.testCase.metrics).map((key) => {
		const source = props.metricSources[key];
		const value = props.testCase.metrics?.[key] ?? 0;
		return {
			key,
			label: formatMetricLabel(key),
			sourceNodeName: source?.nodeName,
			value: formatPercent(normalizeMetricValue(value, source?.category)),
		};
	}),
);
</script>

<template>
	<N8nCard :class="$style.card" data-test-id="test-case-card">
		<template #header>
			<div :class="$style.header" data-test-id="test-case-header">
				<N8nSpinner v-if="isRunning" size="small" />
				<N8nText size="small" bold>{{
					i18n.baseText('evaluation.runDetail.testCase.title', {
						interpolate: { index: String(index) },
					})
				}}</N8nText>
				<template v-if="isRunning">
					<N8nText size="small" color="text-light">{{ `${verb}… ` }}</N8nText>
				</template>
				<template v-else-if="isPending">
					<N8nIcon icon="circle" size="small" color="text-light" />
					<N8nButton
						data-test-id="test-case-cancel-button"
						variant="ghost"
						size="small"
						:label="i18n.baseText('evaluation.runDetail.testCase.cancel')"
						:disabled="cancelDisabled"
						@click="emit('cancel')"
					/>
				</template>
				<N8nText v-else-if="isCancelled" size="small" color="text-light">{{
					i18n.baseText('evaluation.runDetail.testCase.cancelled')
				}}</N8nText>
				<template v-else>
					<div v-if="hasUsage" :class="$style.usage">
						<N8nText size="small" color="text-light">{{ formatTokens(Number(tokens)) }}</N8nText
						><N8nText size="small" color="text-light">{{ ' · ' }}</N8nText
						><N8nText size="small" color="text-light">{{
							formatDuration(Number(duration))
						}}</N8nText>
					</div>
					<div :class="$style.actions">
						<N8nButton
							v-if="testCase.executionId"
							data-test-id="test-case-view-link"
							variant="ghost"
							size="small"
							icon="external-link"
							icon-only
							:aria-label="i18n.baseText('evaluation.runDetail.testCase.viewLink')"
							@click="emit('view')"
						/>
						<N8nButton
							v-if="isFailed"
							data-test-id="test-case-rerun-button"
							variant="outline"
							size="small"
							:label="i18n.baseText('evaluation.runDetail.testCase.rerun')"
							@click="emit('rerun')"
						/>
					</div>
				</template>
			</div>
		</template>
		<template v-if="isFinished && (isFailed || metricRows.length)">
			<div v-if="isFailed" :class="$style.metricRow" data-test-id="test-case-metric-row">
				<N8nIcon icon="circle-x" color="danger" size="small" />
				<N8nText size="small" bold>{{
					i18n.baseText('evaluation.runDetail.testCase.failed')
				}}</N8nText>
				<N8nText size="small" color="text-light">{{ errorMessage }}</N8nText>
			</div>
			<template v-else>
				<div
					v-for="row in metricRows"
					:key="row.key"
					:class="$style.metricRow"
					data-test-id="test-case-metric-row"
				>
					<N8nIcon icon="circle-check" color="success" size="small" />
					<N8nText size="small" bold>{{ row.label }}</N8nText>
					<N8nText v-if="row.sourceNodeName" size="xsmall" color="text-light">{{
						row.sourceNodeName
					}}</N8nText>
					<N8nText size="small" :class="$style.metricValue">{{ row.value }}</N8nText>
				</div>
			</template>
		</template>
	</N8nCard>
</template>

<style module lang="scss">
.card {
	flex-direction: column;
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	min-height: var(--spacing--xl);
}

.usage {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.actions {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	margin-left: auto;
}

.metricRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--3xs) 0;
}

.metricValue {
	margin-left: auto;
}
</style>
