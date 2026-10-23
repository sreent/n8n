<script setup lang="ts">
// Fork code (not in upstream n8n): the detail of a case in the Tests panel: its name, the input of
// the AI node, the expected values of the checks, the run of the case and its latest result. See
// `../../FORK.md`.
import type { DropdownMenuItemProps } from '@n8n/design-system';
import {
	N8nButton,
	N8nCheckbox,
	N8nDropdownMenu,
	N8nIcon,
	N8nInlineTextEdit,
	N8nInput,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';

import { useMessage } from '@/app/composables/useMessage';
import { MODAL_CONFIRM } from '@/app/constants';
import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';

import { CANNED_METRICS, CANNED_METRIC_EXPECTED_FIELDS } from '../../wizard.constants';
import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import TestCaseRunResult from './TestCaseRunResult.vue';
import { injectTestsPanel } from './testsPanel.context';

const DELETE = 'delete';

const i18n = useI18n();
const message = useMessage();
const panel = injectTestsPanel();
const wizard = useEvaluationsWizardSidepanelStore();
const workflowDocumentStore = injectWorkflowDocumentStore();

const configOpen = ref(true);
const resultsOpen = ref(true);
/** A case that the user creates. It has "Create case" after its first run. */
const isNewCase = ref(wizard.activeRowIndex === null);

const displayName = computed(
	() =>
		wizard.caseName ||
		wizard.inputs[panel.inputFields.value[0]] ||
		i18n.baseText('evaluations.tests.newCase.title'),
);

const selectedMetrics = computed(() =>
	CANNED_METRICS.filter((metric) => wizard.selectedMetricKeys.includes(metric.key)),
);

/** The tools of the AI node: the nodes on its tool input. */
const tools = computed(() =>
	Object.entries(workflowDocumentStore.value.connectionsBySourceNode)
		.filter(([, outputs]) =>
			(outputs.ai_tool ?? []).some((targets) =>
				(targets ?? []).some((target) => target.node === wizard.aiNodeName),
			),
		)
		.map(([name]) => name),
);

const expectedTools = computed(() =>
	(wizard.expectedValues.expectedTools ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean),
);

function toggleTool(name: string, checked: boolean) {
	const next = checked
		? [...expectedTools.value, name]
		: expectedTools.value.filter((item) => item !== name);
	wizard.setExpectedValue('expectedTools', next.join(', '));
}

const menuItems = computed<DropdownMenuItemProps[]>(() => [
	{
		id: DELETE,
		label: i18n.baseText('evaluations.tests.detail.delete'),
		testId: 'tests-detail-menu-item-delete',
	},
]);

const rowIndex = computed(() => wizard.activeRowIndex);
const testCase = computed(() =>
	rowIndex.value === null ? undefined : panel.caseOfRow(rowIndex.value),
);
const showResult = computed(
	() =>
		rowIndex.value !== null &&
		!!panel.activeRun.value &&
		(panel.activeRunIsRunning.value || !!testCase.value),
);

async function onMenu(id: string) {
	if (id !== DELETE) return;
	const confirmed = await message.confirm(
		i18n.baseText('evaluations.tests.detail.delete.confirm.message'),
		i18n.baseText('evaluations.tests.detail.delete.confirm.title'),
		{
			confirmButtonText: i18n.baseText('generic.delete'),
			cancelButtonText: i18n.baseText('generic.cancel'),
		},
	);
	if (confirmed !== MODAL_CONFIRM) return;
	await panel.deleteCase();
}

async function run() {
	if (!(await panel.run())) return;
	isNewCase.value = false;
	configOpen.value = false;
	resultsOpen.value = true;
}
</script>

<template>
	<div :class="$style.detail">
		<div :class="$style.header">
			<button
				type="button"
				:class="$style.plain"
				data-test-id="tests-detail-breadcrumb-root"
				@click="panel.openList()"
			>
				<N8nText size="small" color="text-base">{{ i18n.baseText('generic.tests') }}</N8nText>
			</button>
			<N8nText size="small" color="text-light">/</N8nText>
			<div :class="$style.name" data-test-id="tests-detail-name">
				<N8nInlineTextEdit
					:model-value="wizard.caseName"
					:placeholder="displayName"
					@update:model-value="wizard.setCaseName"
				/>
			</div>
			<N8nDropdownMenu :items="menuItems" placement="bottom-end" @select="onMenu">
				<template #trigger>
					<button
						type="button"
						:class="$style.plain"
						:aria-label="i18n.baseText('workflowHistory.content.actions')"
						data-test-id="tests-detail-menu"
					>
						<N8nIcon icon="ellipsis-vertical" size="small" />
					</button>
				</template>
			</N8nDropdownMenu>
			<div :class="$style.actions">
				<N8nButton
					v-if="!isNewCase"
					variant="subtle"
					size="small"
					data-test-id="tests-detail-create-case"
					@click="panel.openCreate()"
					>{{ i18n.baseText('evaluations.tests.results.createCase') }}</N8nButton
				>
				<N8nButton variant="solid" size="small" data-test-id="tests-detail-run" @click="run">{{
					i18n.baseText('evaluations.tests.detail.run')
				}}</N8nButton>
			</div>
		</div>
		<button type="button" :class="$style.section" @click="configOpen = !configOpen">
			<N8nIcon icon="chevron-down" size="small" />
			<span>{{ i18n.baseText('evaluations.tests.detail.config') }}</span>
		</button>
		<div :class="$style.config" :hidden="!configOpen" data-test-id="tests-detail-config">
			<div :class="$style.when">
				<N8nText size="small" color="text-light">{{
					i18n.baseText('evaluations.tests.detail.when')
				}}</N8nText>
				<N8nText size="small" color="text-dark" bold data-test-id="tests-detail-ai-node">{{
					wizard.aiNodeName
				}}</N8nText>
				<N8nText size="small" color="text-light">{{
					i18n.baseText('evaluations.tests.detail.receivesInput')
				}}</N8nText>
			</div>
			<div
				v-for="field in panel.inputFields.value"
				:key="field"
				:class="$style.field"
				:data-test-id="`tests-detail-input-${field}`"
			>
				<N8nText size="small" color="text-base">{{ field }}</N8nText>
				<N8nInput
					type="textarea"
					:rows="2"
					:model-value="wizard.inputs[field] ?? ''"
					@update:model-value="(value: string) => wizard.setInputValue(field, value)"
				/>
			</div>
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluations.tests.detail.output')
			}}</N8nText>
			<div
				v-for="metric in selectedMetrics"
				:key="metric.key"
				:class="$style.field"
				:data-test-id="`tests-detail-metric-${metric.key}`"
			>
				<N8nText size="small" color="text-base">{{ i18n.baseText(metric.sentenceKey) }}</N8nText>
				<template v-if="metric.key === 'toolsUsed'">
					<N8nText v-if="tools.length === 0" size="small" color="text-light">{{
						i18n.baseText('evaluations.tests.detail.tools.empty')
					}}</N8nText>
					<N8nCheckbox
						v-for="tool in tools"
						:key="tool"
						:model-value="expectedTools.includes(tool)"
						:label="tool"
						@update:model-value="(checked: boolean) => toggleTool(tool, checked)"
					/>
				</template>
				<N8nInput
					v-else-if="CANNED_METRIC_EXPECTED_FIELDS[metric.key]"
					type="textarea"
					:rows="2"
					:model-value="
						wizard.expectedValues[CANNED_METRIC_EXPECTED_FIELDS[metric.key]?.name ?? ''] ?? ''
					"
					:data-test-id="`tests-detail-expected-${CANNED_METRIC_EXPECTED_FIELDS[metric.key]?.name}`"
					@update:model-value="
						(value: string) =>
							wizard.setExpectedValue(CANNED_METRIC_EXPECTED_FIELDS[metric.key]?.name ?? '', value)
					"
				/>
			</div>
			<div
				v-for="check in wizard.customChecks"
				:key="check.id"
				:class="$style.field"
				:data-test-id="`tests-detail-custom-${check.id}`"
			>
				<N8nText size="small" color="text-base">{{
					i18n.baseText('evaluations.tests.metric.custom.sentence')
				}}</N8nText>
				<N8nText
					size="small"
					color="text-dark"
					:data-test-id="`tests-detail-custom-expression-${check.id}`"
					>{{ check.expression }}</N8nText
				>
			</div>
		</div>
		<template v-if="showResult && panel.activeRun.value && rowIndex !== null">
			<button type="button" :class="$style.section" @click="resultsOpen = !resultsOpen">
				<N8nIcon icon="chevron-down" size="small" />
				<span>{{ i18n.baseText('evaluations.tests.detail.latestRun') }}</span>
			</button>
			<div :hidden="!resultsOpen" data-test-id="tests-detail-results">
				<TestCaseRunResult
					:row-index="rowIndex"
					:run="panel.activeRun.value"
					:test-case="testCase"
					:running="panel.activeRunIsRunning.value"
					:expanded="resultsOpen"
					load="fresh"
				/>
			</div>
		</template>
	</div>
</template>

<style module lang="scss">
.detail {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.name {
	min-width: 0;
}

.actions {
	display: flex;
	gap: var(--spacing--3xs);
	margin-left: auto;
}

.plain {
	border: none;
	background: none;
	padding: 0;
	cursor: pointer;
}

.section {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	border: none;
	background: none;
	padding: 0;
	cursor: pointer;
	font-size: var(--font-size--sm);
	color: var(--color--text);
}

.config {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.when {
	display: flex;
	gap: var(--spacing--4xs);
}

.field {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}
</style>
