<script setup lang="ts">
// Fork code (not in upstream n8n): the table of the runs of a workflow, the newest first, with a
// column for each metric. See `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { ElTable, ElTableColumn } from 'element-plus';

import AnimatedSpinner from '@/app/components/AnimatedSpinner.vue';

import { TEST_RUN_ERROR_MESSAGES, TEST_RUN_STATUS_ICONS } from '../../evaluation.constants';
import type { IndexedTestRun } from '../../evaluation.utils';
import { formatMetricValue, formatRunAt } from '../../evaluation.utils';

defineProps<{
	runs: IndexedTestRun[];
	metricKeys: string[];
}>();

const emit = defineEmits<{ rowClick: [run: IndexedTestRun] }>();

const i18n = useI18n();

function errorMessage(testRun: IndexedTestRun) {
	const message =
		TEST_RUN_ERROR_MESSAGES[testRun.errorCode ?? ''] ?? TEST_RUN_ERROR_MESSAGES.UNKNOWN_ERROR;
	return {
		text: i18n.baseText(message.key, { interpolate: { description: '' } }),
		description: message.description ? i18n.baseText(message.description) : undefined,
	};
}

const hasStatusIcon = (testRun: IndexedTestRun) => testRun.status in TEST_RUN_STATUS_ICONS;
const statusIcon = (testRun: IndexedTestRun) => TEST_RUN_STATUS_ICONS[testRun.status] ?? 'circle';
</script>

<template>
	<ElTable
		:data="runs"
		border
		:class="$style.table"
		:row-class-name="() => $style.row"
		@row-click="(row: IndexedTestRun) => emit('rowClick', row)"
	>
		<ElTableColumn
			data-test-id="table-column"
			prop="index"
			:label="i18n.baseText('evaluation.listRuns.runNumber')"
			width="80"
			show-overflow-tooltip
		>
			<template #default="{ row }">#{{ row.index }}</template>
		</ElTableColumn>
		<ElTableColumn data-test-id="table-column" prop="runAt" min-width="160" show-overflow-tooltip>
			<template #header>
				<div :class="$style.sortedHeader">
					<div>{{ i18n.baseText('evaluation.listRuns.runAt') }}</div>
					<N8nIcon icon="arrow-up" size="small" />
				</div>
			</template>
			<template #default="{ row }">{{ formatRunAt(row.runAt) }}</template>
		</ElTableColumn>
		<ElTableColumn
			data-test-id="table-column"
			prop="status"
			:label="i18n.baseText('evaluation.listRuns.status')"
			min-width="200"
		>
			<template #default="{ row }">
				<div v-if="row.status === 'error'" :class="$style.error">
					<N8nIcon icon="triangle-alert" color="danger" size="small" />
					<N8nText size="small" color="danger"
						>{{ errorMessage(row).text
						}}<span v-if="errorMessage(row).description" :class="$style.description">{{
							errorMessage(row).description
						}}</span></N8nText
					>
				</div>
				<div v-else :class="$style.status">
					{{ row.status
					}}<N8nText v-if="row.status === 'running'" color="secondary"><AnimatedSpinner /></N8nText
					><N8nIcon v-else-if="hasStatusIcon(row)" :icon="statusIcon(row)" size="small" />
				</div>
			</template>
		</ElTableColumn>
		<ElTableColumn
			v-for="key in metricKeys"
			:key="key"
			data-test-id="table-column"
			:prop="`metrics.${key}`"
			:label="key"
			min-width="120"
		>
			<template #default="{ row }">{{ formatMetricValue(row.metrics?.[key]) }}</template>
		</ElTableColumn>
	</ElTable>
</template>

<style module lang="scss">
.table {
	width: 100%;
}

.row {
	cursor: pointer;
}

.sortedHeader {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.status {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.error {
	display: flex;
	align-items: flex-start;
	gap: var(--spacing--3xs);
}

.description {
	display: block;
	color: var(--color--text--tint-1);
}
</style>
