<script setup lang="ts">
// Fork code (not in upstream n8n): the score of each case for each version of a collection, the
// best version of the case, and the largest fall from it. See `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';

import type { CompareCaseRow, CompareVersion } from '../../composables/useCompareData';
import { formatPercent } from '../../evaluation.utils';
import { versionLetter } from '../shared/versionPalette';

const props = defineProps<{ versions: CompareVersion[]; caseRows: CompareCaseRow[] }>();

const emit = defineEmits<{ drilldown: [runIndex: number] }>();

const i18n = useI18n();

type SortKey = 'index' | 'best' | 'delta';
const sortKey = ref<SortKey>('delta');
const ascending = ref(true);

/** A click on the sorted column turns the order around. A click on another column sorts by it. */
function sortBy(key: SortKey) {
	if (sortKey.value === key) ascending.value = !ascending.value;
	else {
		sortKey.value = key;
		ascending.value = true;
	}
}

const sortValue = (row: CompareCaseRow, key: SortKey) => {
	if (key === 'index') return row.runIndex;
	if (key === 'best') return row.bestIndex ?? Number.MAX_SAFE_INTEGER;
	return row.worst?.delta ?? 0;
};

/** The largest fall comes first by default. */
const rows = computed(() =>
	[...props.caseRows].sort((a, b) => {
		const difference = sortValue(a, sortKey.value) - sortValue(b, sortKey.value);
		return (ascending.value ? difference : -difference) || a.runIndex - b.runIndex;
	}),
);

const formatDelta = (delta: number) => `${Math.round(delta * 100)}%`;
</script>

<template>
	<table :class="$style.table" data-test-id="compare-cases-table">
		<thead>
			<tr>
				<th role="button" @click="sortBy('index')">
					{{ i18n.baseText('evaluation.compare.cases.col.index') }}
				</th>
				<th>{{ i18n.baseText('evaluation.compare.cases.col.input') }}</th>
				<th v-for="version in versions" :key="version.testRunId">
					{{ versionLetter(version.index) }}
				</th>
				<th role="button" @click="sortBy('best')">
					{{ i18n.baseText('evaluation.compare.cases.col.best') }}
				</th>
				<th role="button" @click="sortBy('delta')">
					{{ i18n.baseText('evaluation.compare.cases.col.deltaVsBest') }}
				</th>
				<th />
			</tr>
		</thead>
		<tbody>
			<tr
				v-for="row in rows"
				:key="row.runIndex"
				:class="$style.row"
				data-test-id="compare-cases-row"
				@click="emit('drilldown', row.runIndex)"
			>
				<td>{{ row.runIndex + 1 }}</td>
				<td>
					<span :class="$style.input">{{ row.input }}</span>
				</td>
				<td v-for="(value, index) in row.values" :key="index">
					<N8nText size="small" :color="value === null ? 'text-light' : undefined">{{
						value === null ? '⊘' : formatPercent(value)
					}}</N8nText>
				</td>
				<td>
					<N8nText v-if="row.bestIndex !== null" size="small" bold>{{
						i18n.baseText('evaluation.compare.cases.bestPill', {
							interpolate: { letter: versionLetter(row.bestIndex) },
						})
					}}</N8nText>
				</td>
				<td>
					<N8nText v-if="row.worst" size="small" color="danger">{{
						`${versionLetter(row.worst.index)} ${formatDelta(row.worst.delta)}`
					}}</N8nText>
				</td>
				<td><N8nIcon icon="chevron-right" size="small" /></td>
			</tr>
		</tbody>
	</table>
</template>

<style module lang="scss">
.table {
	width: 100%;
	border-collapse: collapse;

	th,
	td {
		padding: var(--spacing--2xs);
		text-align: left;
		border-bottom: var(--border);
	}
}

.row {
	cursor: pointer;
}

.input {
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}
</style>
