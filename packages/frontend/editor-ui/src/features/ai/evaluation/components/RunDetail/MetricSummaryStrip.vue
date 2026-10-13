<script setup lang="ts">
// Fork code (not in upstream n8n): a card for each metric of a run, with its average and the
// change from the previous run. See `../../FORK.md`.
import { N8nText } from '@n8n/design-system';
import { ElScrollbar } from 'element-plus';
import { computed } from 'vue';

import type { MetricSource, MetricValues } from '../../evaluation.types';
import {
	formatMetricLabel,
	formatPercent,
	normalizeMetricValue,
	userDefinedMetricKeys,
} from '../../evaluation.utils';
import TrendDeltaBadge from './TrendDeltaBadge.vue';

const props = defineProps<{
	currentMetrics: MetricValues;
	previousMetrics: MetricValues | null;
	metricSources: Record<string, MetricSource>;
}>();

const cards = computed(() =>
	userDefinedMetricKeys(props.currentMetrics).map((key) => {
		const category = props.metricSources[key]?.category;
		const current = normalizeMetricValue(props.currentMetrics[key], category);
		const previousValue = props.previousMetrics?.[key];
		const delta =
			previousValue === undefined
				? 0
				: Math.round((current - normalizeMetricValue(previousValue, category)) * 100) / 100;
		return { key, label: formatMetricLabel(key), value: formatPercent(current), delta };
	}),
);
</script>

<template>
	<ElScrollbar data-test-id="metric-summary-strip">
		<div :class="$style.strip">
			<div
				v-for="card in cards"
				:key="card.key"
				:class="$style.card"
				data-test-id="metric-summary-card"
			>
				<N8nText size="small" color="text-base">{{ card.label }}</N8nText>
				<div :class="$style.values">
					<span :class="$style.value">{{ card.value }}</span>
					<TrendDeltaBadge v-if="card.delta !== 0" :delta="card.delta" />
				</div>
			</div>
		</div>
	</ElScrollbar>
</template>

<style module lang="scss">
.strip {
	display: flex;
	gap: var(--spacing--xs);
	padding-bottom: var(--spacing--2xs);
}

.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	min-width: 160px;
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.values {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.value {
	font-size: var(--font-size--xl);
	font-weight: var(--font-weight--bold);
}
</style>
