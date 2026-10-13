<script setup lang="ts">
// Fork code (not in upstream n8n): the outputs of one case for each version of a collection, side
// by side, with the scores of the case. See `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';

import type { CompareCaseRow, CompareVersion } from '../../composables/useCompareData';
import { firstText } from '../../composables/useCompareData';
import { formatMetricLabel, formatPercent } from '../../evaluation.utils';
import VersionAvatar from '../shared/VersionAvatar.vue';

const props = defineProps<{
	versions: CompareVersion[];
	caseRows: CompareCaseRow[];
	workflowId: string;
}>();

const selectedIndex = defineModel<number>('selectedIndex', { required: true });

const i18n = useI18n();
const router = useRouter();

const selected = computed(
	() => props.caseRows.find((row) => row.runIndex === selectedIndex.value) ?? props.caseRows[0],
);

/** Opens the execution of the case for a version in a new tab. */
function inspect(executionId: string) {
	const { href } = router.resolve({
		name: VIEWS.EXECUTION_PREVIEW,
		params: { workflowId: props.workflowId, executionId },
	});
	window.open(href, '_blank');
}
</script>

<template>
	<div :class="$style.tab" data-test-id="compare-outputs-tab">
		<aside :class="$style.cases">
			<N8nText size="small" bold>{{
				i18n.baseText('evaluation.compare.outputs.casesSidebarTitle')
			}}</N8nText>
			<button
				v-for="row in caseRows"
				:key="row.runIndex"
				type="button"
				:class="[$style.case, { [$style.active]: row.runIndex === selected?.runIndex }]"
				data-test-id="compare-outputs-case"
				@click="selectedIndex = row.runIndex"
			>
				<N8nText size="xsmall" color="text-light">{{ `#${row.runIndex + 1}` }}</N8nText>
				<N8nText size="small">{{ row.input }}</N8nText>
			</button>
		</aside>
		<div v-if="selected" :class="$style.detail">
			<div :class="$style.input">
				<N8nText size="xsmall" color="text-light">{{
					i18n.baseText('evaluation.compare.outputs.input')
				}}</N8nText>
				<N8nText size="small">{{ selected.input }}</N8nText>
			</div>
			<div :class="$style.columns">
				<article
					v-for="version in versions"
					:key="version.testRunId"
					:class="$style.column"
					data-test-id="compare-outputs-column"
				>
					<div :class="$style.columnHeading">
						<VersionAvatar :index="version.index" size="small" />
						<N8nText size="small">{{ version.label }}</N8nText>
						<button
							v-if="selected.executionIds[version.index]"
							type="button"
							:class="$style.inspect"
							data-test-id="compare-outputs-inspect"
							@click="inspect(selected.executionIds[version.index] ?? '')"
						>
							<N8nText size="xsmall">{{
								i18n.baseText('evaluation.compare.outputs.inspectRun')
							}}</N8nText>
							<N8nIcon icon="external-link" size="xsmall" />
						</button>
					</div>
					<N8nText v-if="selected.outputs[version.index]" size="small">{{
						firstText(selected.outputs[version.index])
					}}</N8nText>
					<N8nText v-else size="small" color="text-light">{{
						i18n.baseText('evaluation.compare.outputs.noOutput')
					}}</N8nText>
					<div
						v-for="(score, key) in selected.metrics[version.index]"
						:key="key"
						:class="$style.metric"
					>
						<N8nText size="xsmall" color="text-light">{{ formatMetricLabel(String(key)) }}</N8nText>
						<N8nText size="xsmall" bold>{{ formatPercent(score) }}</N8nText>
					</div>
				</article>
			</div>
		</div>
	</div>
</template>

<style module lang="scss">
.tab {
	display: grid;
	grid-template-columns: 240px 1fr;
	gap: var(--spacing--sm);
}

.cases {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.case {
	display: flex;
	gap: var(--spacing--3xs);
	padding: var(--spacing--3xs) var(--spacing--2xs);
	border: none;
	border-radius: var(--radius);
	background: none;
	text-align: left;
	cursor: pointer;
}

.active {
	background-color: var(--color--background--shade-1);
}

.detail {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.input {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.columns {
	display: grid;
	grid-auto-flow: column;
	grid-auto-columns: minmax(200px, 1fr);
	gap: var(--spacing--sm);
}

.column {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.columnHeading,
.metric {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.inspect {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	margin-left: auto;
	border: none;
	background: none;
	cursor: pointer;
}
</style>
