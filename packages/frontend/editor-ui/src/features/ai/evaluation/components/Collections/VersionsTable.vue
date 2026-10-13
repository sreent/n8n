<script setup lang="ts">
// Fork code (not in upstream n8n): the versions that a new collection can compare, with the last
// run of each version on the dataset. See `../../FORK.md`.
import type { EvalVersionEntry } from '@n8n/api-types';
import { N8nBadge, N8nCheckbox, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import dateformat from 'dateformat';

import { formatPercent } from '../../evaluation.utils';
import VersionAvatar from '../shared/VersionAvatar.vue';

export type VersionRow = { key: string; index: number; version: EvalVersionEntry };

const props = defineProps<{
	rows: VersionRow[];
	selected: string[];
	datasetName: string;
	workflowId: string;
}>();

const emit = defineEmits<{ toggle: [key: string, checked: boolean] }>();

const i18n = useI18n();

/** The page of the version: the workflow for the draft, else the version in the history. */
const viewHref = (version: EvalVersionEntry) =>
	version.workflowVersionId === null
		? `/workflow/${props.workflowId}`
		: `/workflow/${props.workflowId}/history/${version.workflowVersionId}`;
</script>

<template>
	<div :class="$style.table" data-test-id="versions-table">
		<div :class="[$style.row, $style.head]">
			<span />
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluation.setup.versions.col.version')
			}}</N8nText>
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluation.setup.versions.col.lastRun', {
					interpolate: { dataset: datasetName },
				})
			}}</N8nText>
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluation.setup.versions.col.avgScore')
			}}</N8nText>
			<span />
		</div>
		<N8nText v-if="!rows.length" size="small" color="text-light">{{
			i18n.baseText('evaluation.setup.versions.empty')
		}}</N8nText>
		<div v-for="row in rows" :key="row.key" :class="$style.row" data-test-id="versions-table-row">
			<N8nCheckbox
				data-test-id="versions-table-row-checkbox"
				:model-value="selected.includes(row.key)"
				@update:model-value="emit('toggle', row.key, $event === true)"
			/>
			<div :class="$style.version">
				<VersionAvatar :index="row.index" size="small" />
				<N8nText size="small">{{ row.version.label }}</N8nText>
				<N8nText size="xsmall" color="text-light">{{ row.version.sourceLabel }}</N8nText>
			</div>
			<div>
				<N8nText v-if="row.version.lastRun" size="small">{{
					dateformat(row.version.lastRun.runAt, 'mmm d, hh:MM TT')
				}}</N8nText>
				<N8nBadge v-else>{{ i18n.baseText('evaluation.setup.versions.noRunYet') }}</N8nBadge>
			</div>
			<div :class="$style.score">
				<N8nText size="small" bold>{{
					row.version.lastRun?.avgScore == null ? '—' : formatPercent(row.version.lastRun.avgScore)
				}}</N8nText>
				<N8nBadge v-if="row.version.lastRun?.isBest" data-test-id="versions-table-row-best"
					><N8nIcon icon="star" size="xsmall" />{{
						` ${i18n.baseText('evaluation.setup.versions.bestPill')}`
					}}</N8nBadge
				>
				<N8nBadge v-else-if="row.version.lastRun?.isCritical" data-test-id="versions-table-row-low"
					><N8nIcon icon="triangle-alert" size="xsmall" />{{
						` ${i18n.baseText('evaluation.setup.versions.lowPill')}`
					}}</N8nBadge
				>
			</div>
			<a
				:class="$style.view"
				:href="viewHref(row.version)"
				target="_blank"
				data-test-id="versions-table-row-view"
				><N8nIcon icon="arrow-up-right" size="xsmall" />{{
					` ${i18n.baseText('evaluation.setup.versions.viewAction')}`
				}}</a
			>
		</div>
	</div>
</template>

<style module lang="scss">
.table {
	display: flex;
	flex-direction: column;
	border: var(--border);
	border-radius: var(--radius);
}

.row {
	display: grid;
	grid-template-columns: auto 2fr 1.5fr 1fr auto;
	align-items: center;
	gap: var(--spacing--xs);
	padding: var(--spacing--2xs) var(--spacing--xs);

	& + & {
		border-top: var(--border);
	}
}

.head {
	background-color: var(--color--background--light-2);
}

.version,
.score {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.view {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
}
</style>
