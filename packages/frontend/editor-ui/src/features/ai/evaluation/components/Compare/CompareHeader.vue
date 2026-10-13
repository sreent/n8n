<script setup lang="ts">
// Fork code (not in upstream n8n): the heading of the comparison of a collection: its name and
// state, the re-run button, and each version with its average score. See `../../FORK.md`.
import type { EvaluationCollectionDetail } from '@n8n/api-types';
import { N8nBadge, N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import type { CompareVersion } from '../../composables/useCompareData';
import { collectionState, collectionStateLabel } from '../../evalCollections.utils';
import { formatPercent } from '../../evaluation.utils';
import RunningIndicator from '../shared/RunningIndicator.vue';
import VersionAvatar from '../shared/VersionAvatar.vue';

const props = defineProps<{
	detail: EvaluationCollectionDetail;
	versions: CompareVersion[];
	isRerunning?: boolean;
}>();

const emit = defineEmits<{ rerun: [] }>();

const i18n = useI18n();

const state = computed(() => collectionState(props.detail));
const stateLabel = computed(() => collectionStateLabel(state.value));

const isActive = (version: CompareVersion) =>
	version.status === 'running' || version.status === 'new';
</script>

<template>
	<header :class="$style.header" data-test-id="compare-header">
		<div :class="$style.title">
			<N8nText tag="h2" size="xlarge" bold>{{ detail.name }}</N8nText>
			<RunningIndicator v-if="state.kind === 'running'" :label="stateLabel" />
			<N8nBadge v-else>{{ stateLabel }}</N8nBadge>
			<N8nButton
				v-if="state.kind !== 'running'"
				data-test-id="compare-rerun"
				variant="subtle"
				size="small"
				icon="refresh-cw"
				:label="i18n.baseText('evaluation.compare.rerun')"
				:disabled="isRerunning"
				@click="emit('rerun')"
			/>
		</div>
		<div :class="$style.versions">
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluation.collections.card.meta.versions', {
					adjustToNumber: versions.length,
					interpolate: { count: versions.length },
				})
			}}</N8nText>
			<a
				v-for="version in versions"
				:key="version.testRunId"
				:class="$style.version"
				:title="
					isActive(version)
						? i18n.baseText('evaluation.compare.versionsLegend.running')
						: i18n.baseText('evaluation.compare.versionsLegend.inspectRun')
				"
				data-test-id="compare-header-version"
			>
				<VersionAvatar :index="version.index" size="small" />
				<N8nText size="small">{{ version.label }}</N8nText>
				<N8nText v-if="version.avgScore !== null" size="small" bold>{{
					`${formatPercent(version.avgScore)} `
				}}</N8nText>
				<N8nText v-if="version.isBest" size="xsmall" color="success">{{
					i18n.baseText('evaluation.compare.versionsLegend.best')
				}}</N8nText>
				<N8nIcon v-if="isActive(version)" icon="spinner" size="small" spin />
			</a>
		</div>
	</header>
</template>

<style module lang="scss">
.header {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.title {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.versions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--sm);
}

.version {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
}
</style>
