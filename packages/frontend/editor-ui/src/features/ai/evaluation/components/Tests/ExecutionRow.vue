<script setup lang="ts">
// Fork code (not in upstream n8n): a recent execution in the new case view: its date, its input
// and output when open, and the button that makes a case from it. See `../../FORK.md`.
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import dateformat from 'dateformat';
import { computed, ref } from 'vue';

import { useExecutionsStore } from '@/features/execution/executions/executions.store';
import type {
	ExecutionSummaryWithScopes,
	IExecutionResponse,
} from '@/features/execution/executions/executions.types';

import { fieldText, readNodeOutput } from '../../wizard.utils';
import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import { injectTestsPanel } from './testsPanel.context';

const props = defineProps<{ execution: ExecutionSummaryWithScopes }>();

const i18n = useI18n();
const panel = injectTestsPanel();
const wizard = useEvaluationsWizardSidepanelStore();
const executionsStore = useExecutionsStore();

const open = ref(false);
const detail = ref<IExecutionResponse>();

const date = computed(() =>
	dateformat(props.execution.startedAt ?? props.execution.createdAt, 'mmm d, HH:MM:ss'),
);

const input = computed(() =>
	Object.entries(detail.value ? (panel.readAiNodeInputOf(detail.value) ?? {}) : {}),
);
const output = computed(() =>
	Object.entries(readNodeOutput(detail.value?.data?.resultData?.runData, wizard.aiNodeName) ?? {}),
);

async function toggle() {
	open.value = !open.value;
	if (!open.value || detail.value) return;
	try {
		detail.value = await executionsStore.fetchExecution(props.execution.id);
	} catch {
		open.value = false;
	}
}
</script>

<template>
	<div :class="$style.row">
		<div :class="$style.header">
			<button
				type="button"
				:class="$style.toggle"
				:data-test-id="`tests-execution-toggle-${execution.id}`"
				@click="toggle"
			>
				<N8nIcon :icon="open ? 'chevron-down' : 'chevron-right'" size="small" />
			</button>
			<N8nText size="small" color="text-dark">{{ date }}</N8nText>
			<N8nIcon
				v-if="execution.mode === 'manual'"
				icon="flask-conical"
				size="small"
				:title="i18n.baseText('evaluations.tests.executions.manualBadge')"
				:data-test-id="`tests-execution-manual-${execution.id}`"
			/>
			<N8nButton
				variant="outline"
				size="small"
				:class="$style.use"
				:data-test-id="`tests-execution-create-${execution.id}`"
				@click="panel.useExecution(execution.id)"
				>{{ i18n.baseText('evaluations.tests.executions.createCase') }}</N8nButton
			>
		</div>
		<div
			v-if="open && detail"
			:class="$style.detail"
			:data-test-id="`tests-execution-detail-${execution.id}`"
		>
			<template v-if="input.length">
				<N8nText size="small" color="text-light" bold>{{
					i18n.baseText('evaluations.tests.executions.input')
				}}</N8nText>
				<div :class="$style.fields">
					<template v-for="[key, value] in input" :key="key">
						<N8nText size="small" color="text-light">{{ key }}</N8nText>
						<N8nText size="small" color="text-dark">{{ fieldText(value) }}</N8nText>
					</template>
				</div>
			</template>
			<N8nText v-if="output.length" size="small" color="text-light" bold>{{
				i18n.baseText('evaluations.tests.executions.output')
			}}</N8nText>
			<div v-if="output.length" :class="$style.fields">
				<template v-for="[key, value] in output" :key="key">
					<N8nText size="small" color="text-light">{{ key }}</N8nText>
					<N8nText size="small" color="text-dark">{{ fieldText(value) }}</N8nText>
				</template>
			</div>
		</div>
	</div>
</template>

<style module lang="scss">
.row {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	padding: var(--spacing--2xs) 0;
	border-bottom: var(--border);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.toggle {
	border: none;
	background: none;
	padding: 0;
	cursor: pointer;
}

.use {
	margin-left: auto;
}

.detail {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	padding-left: var(--spacing--md);
}

.fields {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: var(--spacing--4xs) var(--spacing--2xs);
	word-break: break-word;
}
</style>
