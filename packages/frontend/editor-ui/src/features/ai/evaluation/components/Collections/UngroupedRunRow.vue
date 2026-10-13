<script setup lang="ts">
// Fork code (not in upstream n8n): a run that is not part of a collection, in the list of
// collections. See `../../FORK.md`.
import { averageNormalizedScore } from '@n8n/api-types';
import { N8nBadge, N8nText } from '@n8n/design-system';
import type { BaseTextKey } from '@n8n/i18n';
import { useI18n } from '@n8n/i18n';
import dateformat from 'dateformat';
import { computed } from 'vue';

import type { TestRunRecord } from '../../evaluation.types';
import { formatPercent } from '../../evaluation.utils';

const props = defineProps<{ run: TestRunRecord; datasetName?: string }>();

const i18n = useI18n();

const STATUS_LABELS: Record<string, BaseTextKey> = {
	completed: 'evaluation.collections.row.status.done',
	running: 'evaluation.collections.row.status.running',
	new: 'evaluation.collections.row.status.queued',
	error: 'evaluation.collections.row.status.failed',
	cancelled: 'evaluation.collections.row.status.cancelled',
	warning: 'evaluation.collections.row.status.warning',
};

const runAt = computed(() => {
	const time = props.run.runAt ?? props.run.createdAt;
	return `${dateformat(time, 'mmm d')} · ${dateformat(time, 'hh:MM TT')}`;
});

/** The average of the scores of the run, from 0 to 1, by the scales of their names. */
const score = computed(() => averageNormalizedScore(props.run.metrics));

const statusLabel = computed(() =>
	i18n.baseText(STATUS_LABELS[props.run.status] ?? STATUS_LABELS.completed),
);
</script>

<template>
	<div :class="$style.row" data-test-id="eval-collections-ungrouped-row">
		<N8nText size="small" bold>{{ `#${run.id}` }}</N8nText>
		<N8nText size="small" color="text-light">{{ runAt }}</N8nText>
		<N8nBadge v-if="datasetName">{{ datasetName }}</N8nBadge>
		<N8nText v-else size="small" color="text-light">{{
			i18n.baseText('evaluation.collections.row.noDataset')
		}}</N8nText>
		<N8nText size="small" bold>{{ score === null ? '—' : formatPercent(score) }}</N8nText>
		<N8nBadge>{{ statusLabel }}</N8nBadge>
	</div>
</template>

<style module lang="scss">
.row {
	display: grid;
	grid-template-columns: auto auto 1fr auto auto;
	align-items: center;
	gap: var(--spacing--sm);
	padding: var(--spacing--2xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius);
}
</style>
