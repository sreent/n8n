<script setup lang="ts">
// Fork code (not in upstream n8n): a case in the list of the Tests panel: its name, its input when
// open, and its result in the active run. See `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';

import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import TestCaseRunResult from './TestCaseRunResult.vue';
import { injectTestsPanel } from './testsPanel.context';

const props = defineProps<{ rowIndex: number }>();

const i18n = useI18n();
const panel = injectTestsPanel();
const wizard = useEvaluationsWizardSidepanelStore();

const expanded = ref(false);

const name = computed(
	() =>
		wizard.datasetNamesByRow[props.rowIndex] ||
		i18n.baseText('evaluations.tests.list.caseLabel', {
			interpolate: { index: String(props.rowIndex + 1) },
		}),
);
const inputs = computed(() => Object.entries(wizard.datasetInputsByRow[props.rowIndex] ?? {}));
const testCase = computed(() => panel.caseOfRow(props.rowIndex));

function edit() {
	wizard.setSeedExecution(null);
	wizard.openDetail(props.rowIndex);
}
</script>

<template>
	<div :class="$style.card" :data-test-id="`tests-result-card-${rowIndex}`">
		<div :class="$style.header">
			<button
				type="button"
				:class="$style.name"
				:data-test-id="`tests-result-edit-${rowIndex}`"
				@click="edit"
			>
				<N8nText size="small" color="text-dark" bold>{{ name }}</N8nText>
			</button>
			<button
				type="button"
				:class="$style.toggle"
				:data-test-id="`tests-result-toggle-${rowIndex}`"
				@click="expanded = !expanded"
			>
				<N8nIcon :icon="expanded ? 'chevron-up' : 'chevron-down'" size="small" />
			</button>
		</div>
		<div v-if="expanded" :class="$style.input">
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluations.tests.detail.when')
			}}</N8nText>
			<N8nText size="small" color="text-dark" bold>{{ wizard.aiNodeName }}</N8nText>
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluations.tests.detail.receivesInput')
			}}</N8nText>
			<template v-for="[field, value] in inputs" :key="field">
				<N8nText size="small" color="text-light">{{ field }}</N8nText>
				<N8nText size="small" color="text-dark">{{ value }}</N8nText>
			</template>
		</div>
		<TestCaseRunResult
			v-if="panel.activeRun.value && (panel.activeRunIsRunning.value || testCase)"
			:row-index="rowIndex"
			:run="panel.activeRun.value"
			:test-case="testCase"
			:running="panel.activeRunIsRunning.value"
			:expanded="expanded"
			load="cached"
		/>
	</div>
</template>

<style module lang="scss">
.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--xs);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.name,
.toggle {
	border: none;
	background: none;
	padding: 0;
	cursor: pointer;
	text-align: left;
}

.input {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: var(--spacing--4xs) var(--spacing--2xs);
}
</style>
