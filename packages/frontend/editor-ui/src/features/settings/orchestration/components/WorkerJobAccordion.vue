<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the running jobs of a worker, with links to the execution and
 * to the workflow. The section is open at first. See `../FORK.md`.
 */
import type { RunningJobSummary } from '@n8n/api-types';
import { N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';

import { runningSince } from '../orchestration.utils';
import WorkerAccordion from './WorkerAccordion.vue';

const props = defineProps<{ items: RunningJobSummary[] }>();

const i18n = useI18n();
const router = useRouter();

// The lines are made again only when the jobs change, so the run time is the one of the newest
// status.
const lines = computed(() =>
	props.items.map((item) => {
		const startedAt = new Date(item.startedAt);
		const details = [
			'',
			`${i18n.baseText('workerList.item.job.startedAt')}: ${startedAt.toLocaleTimeString()}`,
			`${i18n.baseText('workerList.item.job.runningFor')} ${runningSince(startedAt)}`,
			...(item.retryOf ? [`${i18n.baseText('workerList.item.job.retryOf')}: ${item.retryOf}`] : []),
			'',
		].join(' | ');
		return {
			executionId: item.executionId,
			executionUrl: router.resolve({
				name: VIEWS.EXECUTION_PREVIEW,
				params: { workflowId: item.workflowId, executionId: item.executionId },
			}).href,
			executionLabel: i18n.baseText('workerList.item.job.execution', {
				interpolate: { executionId: item.executionId, workflowName: item.workflowName },
			}),
			details,
			workflowUrl: router.resolve({
				name: VIEWS.WORKFLOW,
				params: { workflowId: item.workflowId },
			}).href,
		};
	}),
);
</script>

<template>
	<WorkerAccordion
		:title="i18n.baseText('workerList.item.jobListTitle')"
		:count="items.length"
		:initially-expanded="true"
	>
		<N8nText v-if="items.length === 0" size="small" color="text-base">{{
			i18n.baseText('workerList.item.jobList.empty')
		}}</N8nText>
		<!-- The space at the start of each line keeps the lines apart in the text of the page. -->
		<div v-for="line in lines" :key="line.executionId" :class="$style.job">
			{{ ' ' }}<a :href="line.executionUrl" target="_blank">{{ line.executionLabel }}</a
			>{{ line.details
			}}<a :href="line.workflowUrl" target="_blank">{{
				i18n.baseText('workerList.item.job.openWorkflow')
			}}</a>
		</div>
	</WorkerAccordion>
</template>

<style lang="scss" module>
.job {
	font-size: var(--font-size--2xs);
	line-height: var(--line-height--xl);
}
</style>
