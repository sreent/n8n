<script setup lang="ts">
// Fork code (not in upstream n8n): a collection in the list of collections: its state, its
// versions with their average scores, and a chart of the scores of each metric. See
// `../../FORK.md`.
import type { EvaluationCollectionDetail, EvaluationCollectionRecord } from '@n8n/api-types';
import { normalizedScores } from '@n8n/api-types';
import { N8nBadge, N8nButton, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';

import {
	collectionState,
	collectionStateLabel,
	formatLastRun,
	versionLabel,
} from '../../evalCollections.utils';
import { formatPercent } from '../../evaluation.utils';
import GroupedMetricChart from '../shared/GroupedMetricChart.vue';
import RunningIndicator from '../shared/RunningIndicator.vue';
import VersionAvatar from '../shared/VersionAvatar.vue';

const props = defineProps<{
	collection: EvaluationCollectionRecord;
	detail: EvaluationCollectionDetail;
	workflowId: string;
	datasetName?: string;
}>();

const i18n = useI18n();
const router = useRouter();

const state = computed(() => collectionState(props.detail));
const stateLabel = computed(() => collectionStateLabel(state.value));
const lastRun = computed(() => formatLastRun(props.detail.runs));

const scores = computed(() =>
	props.detail.runs.map((run) =>
		normalizedScores(run.metrics, run.metricScales ?? props.detail.metricScales),
	),
);

/** A group of bars for each metric, labelled with the name of the metric. */
const groups = computed(() => {
	const keys = [...new Set(scores.value.flatMap((score) => Object.keys(score)))];
	return keys.map((key) => ({
		key,
		label: key,
		values: scores.value.map((score) => score[key] ?? null),
	}));
});

const ctaLabel = computed(
	() =>
		`${i18n.baseText(
			state.value.kind === 'running'
				? 'evaluation.compare.viewProgress'
				: 'evaluation.compare.openCompare',
		)} →`,
);

async function openCompare() {
	await router.push({
		name: VIEWS.EVALUATION_COLLECTION_COMPARE,
		params: { workflowId: props.workflowId, collectionId: props.collection.id },
	});
}
</script>

<template>
	<article :class="$style.card" data-test-id="eval-collections-card">
		<div :class="$style.heading">
			<N8nText bold>{{ collection.name }}</N8nText>
			<RunningIndicator v-if="state.kind === 'running'" :label="stateLabel" />
			<N8nBadge v-else>{{ stateLabel }}</N8nBadge>
		</div>
		<div :class="$style.meta">
			<N8nText size="small" color="text-light"
				><span>{{
					i18n.baseText('evaluation.collections.card.meta.versions', {
						adjustToNumber: detail.runs.length,
						interpolate: { count: detail.runs.length },
					})
				}}</span
				><span v-if="datasetName">{{ ` · ${datasetName}` }}</span
				><span v-if="lastRun">{{ ` · ${lastRun}` }}</span></N8nText
			>
			<N8nButton
				data-test-id="eval-collections-card-cta"
				variant="ghost"
				size="small"
				:label="ctaLabel"
				@click="openCompare"
			/>
		</div>
		<div :class="$style.versions">
			<div v-for="(run, index) in detail.runs" :key="run.testRunId" :class="$style.version">
				<VersionAvatar :index="index" variant="dot" />
				<N8nText size="small">{{ versionLabel(run) }}</N8nText>
				<N8nText v-if="run.avgScore !== null" size="small" bold>{{
					formatPercent(run.avgScore)
				}}</N8nText>
			</div>
		</div>
		<GroupedMetricChart v-if="groups.length" :groups="groups" variant="compact" />
	</article>
</template>

<style module lang="scss">
.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.heading,
.meta {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.meta {
	justify-content: space-between;
}

.versions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--sm);
}

.version {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}
</style>
