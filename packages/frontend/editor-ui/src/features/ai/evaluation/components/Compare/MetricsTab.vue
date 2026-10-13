<script setup lang="ts">
// Fork code (not in upstream n8n): the average score of each metric for each version of a
// collection, as a table. See `../../FORK.md`.
import { N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

import type { CompareMetricGroup, CompareVersion } from '../../composables/useCompareData';
import { formatMetricLabel, formatPercent } from '../../evaluation.utils';
import { versionColorVar, versionLetter } from '../shared/versionPalette';
import MetricCriteria from './MetricCriteria.vue';

defineProps<{
	metricGroups: CompareMetricGroup[];
	versions: CompareVersion[];
	metricPrompts?: Record<string, string>;
}>();

const i18n = useI18n();
</script>

<template>
	<div data-test-id="compare-metrics-tab">
		<N8nText v-if="!metricGroups.length" size="small" color="text-light">{{
			i18n.baseText('evaluation.compare.metrics.empty')
		}}</N8nText>
		<table v-else :class="$style.table">
			<thead>
				<tr>
					<th>{{ i18n.baseText('evaluation.compare.metrics.col.metric') }}</th>
					<th v-for="version in versions" :key="version.testRunId">
						<span :class="$style.letter"
							><span
								:class="$style.dot"
								:style="{ backgroundColor: versionColorVar(version.index) }"
							/>{{ ` ${versionLetter(version.index)}` }}</span
						>
					</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="group in metricGroups" :key="group.key" data-test-id="compare-metrics-row">
					<td>
						<N8nText size="small" bold>{{ formatMetricLabel(group.key) }}</N8nText>
						<MetricCriteria :metric-key="group.key" :prompt="metricPrompts?.[group.key]" />
					</td>
					<td v-for="(value, index) in group.values" :key="index">
						<N8nText size="small">{{ value === null ? '—' : formatPercent(value) }}</N8nText>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>

<style module lang="scss">
.table {
	width: 100%;
	border-collapse: collapse;

	th,
	td {
		padding: var(--spacing--2xs);
		text-align: left;
		vertical-align: top;
		border-bottom: var(--border);
	}
}

.letter {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.dot {
	display: inline-block;
	width: var(--spacing--2xs);
	height: var(--spacing--2xs);
	border-radius: 50%;
}
</style>
