<script setup lang="ts">
// Fork code (not in upstream n8n): the Tests panel of the focus sidebar. It shows the cases of the
// evaluation of an AI node, a new case from an execution, and the detail of a case. It replaces
// the enterprise component of the same name. See `../../FORK.md`.
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, provide, watch } from 'vue';
import { useRouter } from 'vue-router';

import { useRunWorkflow } from '@/app/composables/useRunWorkflow';
import { NODE_CREATOR_OPEN_SOURCES } from '@/app/constants';
import { useFocusPanelStore } from '@/app/stores/focusPanel.store';
import { useNodeCreatorStore } from '@/features/shared/nodeCreator/nodeCreator.store';

import { useTestsPanel } from '../../composables/useTestsPanel';
import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import TestCaseDetail from './TestCaseDetail.vue';
import TestCaseList from './TestCaseList.vue';
import TestCaseResults from './TestCaseResults.vue';
import { TestsPanelKey } from './testsPanel.context';

const i18n = useI18n();
const router = useRouter();
const focusPanelStore = useFocusPanelStore();
const nodeCreatorStore = useNodeCreatorStore();
const wizard = useEvaluationsWizardSidepanelStore();
const { runEntireWorkflow } = useRunWorkflow({ router });

const panel = useTestsPanel();
provide(TestsPanelKey, panel);

const isShown = computed(
	() =>
		wizard.isOpen ||
		(focusPanelStore.focusPanelActive && focusPanelStore.selectedTab === 'evaluations'),
);

let probed = false;
watch(
	isShown,
	(shown) => {
		if (!shown || probed) return;
		probed = true;
		void panel.probe();
	},
	{ immediate: true },
);

const showGate = computed(() => panel.executions.value.length === 0 && !panel.hasSavedSetup.value);

function addNode() {
	nodeCreatorStore.openNodeCreatorForTriggerNodes(
		panel.workflowId.value,
		NODE_CREATOR_OPEN_SOURCES.ADD_NODE_BUTTON,
	);
}

function executeWorkflow() {
	void runEntireWorkflow('main');
}
</script>

<template>
	<div :class="$style.panel" data-test-id="tests-panel">
		<div v-if="!panel.hasNodes.value" :class="$style.empty" data-test-id="tests-panel-add-node">
			<N8nText color="text-base">{{ i18n.baseText('evaluations.tests.empty.noNode') }}</N8nText>
			<N8nButton type="secondary" data-test-id="tests-panel-add-node-button" @click="addNode">{{
				i18n.baseText('evaluations.tests.empty.noNode.button')
			}}</N8nButton>
		</div>
		<div
			v-else-if="!panel.probeComplete.value"
			:class="$style.empty"
			data-test-id="tests-panel-probe-loading"
		>
			<N8nIcon icon="spinner" spin />
		</div>
		<div v-else-if="showGate" :class="$style.empty" data-test-id="tests-panel-gate">
			<N8nText color="text-base">{{
				i18n.baseText('evaluations.tests.empty.noExecutions')
			}}</N8nText>
			<N8nButton type="primary" data-test-id="tests-panel-gate-run" @click="executeWorkflow">{{
				i18n.baseText('evaluations.tests.empty.execute')
			}}</N8nButton>
		</div>
		<TestCaseList v-else-if="wizard.viewMode === 'create'" />
		<TestCaseDetail v-else-if="wizard.viewMode === 'detail'" />
		<TestCaseResults v-else />
	</div>
</template>

<style module lang="scss">
.panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	overflow: auto;
	padding: var(--spacing--sm);
}

.empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: var(--spacing--sm);
	flex: 1;
	text-align: center;
	padding: var(--spacing--lg);
}
</style>
