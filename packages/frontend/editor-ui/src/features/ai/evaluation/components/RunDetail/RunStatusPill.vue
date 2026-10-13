<script setup lang="ts">
// Fork code (not in upstream n8n): the state of a run on its detail page. See `../../FORK.md`.
import type { IconName } from '@n8n/design-system';
import { N8nIcon, N8nSpinner, N8nText } from '@n8n/design-system';
import type { BaseTextKey } from '@n8n/i18n';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import type { TestRunStatus } from '../../evaluation.types';
import { isActiveRun } from '../../evaluation.utils';

const props = defineProps<{ status: TestRunStatus }>();

const i18n = useI18n();

const FINISHED: Record<
	string,
	{ icon: IconName; label: BaseTextKey; color: 'success' | 'danger' | 'text-base' }
> = {
	completed: {
		icon: 'circle-check',
		label: 'evaluation.runDetail.runStatus.done',
		color: 'success',
	},
	error: {
		icon: 'triangle-alert',
		label: 'evaluation.runDetail.runStatus.failed',
		color: 'danger',
	},
	cancelled: {
		icon: 'status-canceled',
		label: 'evaluation.runDetail.runStatus.cancelled',
		color: 'text-base',
	},
};

const finished = computed(() => (isActiveRun(props) ? undefined : FINISHED[props.status]));
</script>

<template>
	<span :class="$style.pill" data-test-id="run-status-pill">
		<template v-if="finished">
			<N8nIcon :icon="finished.icon" :color="finished.color" size="small" />
			<N8nText size="small" bold>{{ i18n.baseText(finished.label) }}</N8nText>
		</template>
		<template v-else>
			<N8nSpinner size="small" />
			<N8nText size="small" bold>{{
				i18n.baseText('evaluation.runDetail.runStatus.running')
			}}</N8nText>
		</template>
	</span>
</template>

<style module lang="scss">
.pill {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius--full);
}
</style>
