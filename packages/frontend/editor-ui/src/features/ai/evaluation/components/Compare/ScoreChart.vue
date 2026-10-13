<script setup lang="ts">
// Fork code (not in upstream n8n): the average score of each metric for each version of a
// collection, as a bar chart for each metric. See `../../FORK.md`.
import { N8nSegmentControl, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';

import type { CompareMetricGroup } from '../../composables/useCompareData';
import { formatMetricLabel } from '../../evaluation.utils';
import GroupedMetricChart from '../shared/GroupedMetricChart.vue';
import MetricCriteria from './MetricCriteria.vue';

const props = defineProps<{
	metricGroups: CompareMetricGroup[];
	metricPrompts?: Record<string, string>;
}>();

const i18n = useI18n();

type Mode = 'average' | 'perCase';
const mode = ref<Mode>('average');

// The comparison case by case is not there yet, so its option is off.
const options = computed(() => [
	{ label: i18n.baseText('evaluation.compare.scoreChart.toggle.average'), value: 'average' },
	{
		label: i18n.baseText('evaluation.compare.scoreChart.toggle.perCase'),
		value: 'perCase',
		disabled: true,
	},
]);

const isMode = (value: unknown): value is Mode => value === 'average' || value === 'perCase';

function setMode(value: unknown) {
	if (isMode(value)) mode.value = value;
}

const charts = computed(() =>
	props.metricGroups.map((group) => {
		const label = formatMetricLabel(group.key);
		return { key: group.key, label, groups: [{ key: group.key, label, values: group.values }] };
	}),
);
</script>

<template>
	<section :class="$style.section" data-test-id="compare-score-chart">
		<div :class="$style.heading">
			<N8nText tag="h3" bold>{{ i18n.baseText('evaluation.compare.scoreChart.heading') }}</N8nText>
			<N8nSegmentControl
				:model-value="mode"
				:options="options"
				size="small"
				@update:model-value="setMode"
			/>
		</div>
		<N8nText v-if="!charts.length" size="small" color="text-light">{{
			i18n.baseText('evaluation.compare.scoreChart.empty')
		}}</N8nText>
		<div :class="$style.panels">
			<div
				v-for="chart in charts"
				:key="chart.key"
				:class="$style.panel"
				data-test-id="compare-score-chart-panel"
			>
				<N8nText size="small" bold>{{ chart.label }}</N8nText>
				<MetricCriteria :metric-key="chart.key" :prompt="metricPrompts?.[chart.key]" />
				<GroupedMetricChart :groups="chart.groups" variant="full" />
			</div>
		</div>
	</section>
</template>

<style module lang="scss">
.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.heading {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.panels {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--lg);
}

.panel {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}
</style>
