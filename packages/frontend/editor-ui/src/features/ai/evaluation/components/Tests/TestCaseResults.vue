<script setup lang="ts">
// Fork code (not in upstream n8n): the start view of the Tests panel: the setup of the evaluation
// and the cases of the dataset with their results. See `../../FORK.md`.
import { N8nButton, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import SuiteConfig from './SuiteConfig.vue';
import TestCaseResultCard from './TestCaseResultCard.vue';
import { injectTestsPanel } from './testsPanel.context';

const i18n = useI18n();
const panel = injectTestsPanel();
const wizard = useEvaluationsWizardSidepanelStore();

const rowIndexes = computed(() => wizard.datasetNamesByRow.map((_, index) => index));
</script>

<template>
	<div :class="$style.results" data-test-id="tests-results">
		<div :class="$style.header">
			<N8nText tag="h2" size="large" color="text-dark" bold>{{
				i18n.baseText('generic.tests')
			}}</N8nText>
			<div :class="$style.actions">
				<N8nButton
					variant="subtle"
					size="small"
					data-test-id="tests-results-create-case"
					@click="panel.openCreate()"
					>{{ i18n.baseText('evaluations.tests.results.createCase') }}</N8nButton
				>
				<N8nButton
					variant="solid"
					size="small"
					:disabled="rowIndexes.length === 0"
					data-test-id="tests-results-run-all"
					@click="panel.runAll()"
					>{{ i18n.baseText('evaluations.tests.runAll') }}</N8nButton
				>
			</div>
		</div>
		<SuiteConfig />
		<template v-if="rowIndexes.length">
			<TestCaseResultCard v-for="index in rowIndexes" :key="index" :row-index="index" />
		</template>
		<N8nText v-else size="small" color="text-light">{{
			i18n.baseText('evaluations.tests.results.empty')
		}}</N8nText>
	</div>
</template>

<style module lang="scss">
.results {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
}

.actions {
	display: flex;
	gap: var(--spacing--3xs);
}
</style>
