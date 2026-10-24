<script setup lang="ts">
// Fork code (not in upstream n8n): the setup of the evaluation above the cases: the AI node under
// test and the checks of its answer. See `../../FORK.md`.
import type { DropdownMenuItemProps } from '@n8n/design-system';
import {
	N8nButton,
	N8nDropdownMenu,
	N8nIcon,
	N8nInput,
	N8nOption,
	N8nSelect,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { CANNED_METRICS, isCannedMetricKey } from '../../wizard.constants';
import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import { injectTestsPanel } from './testsPanel.context';

const CUSTOM = 'custom';

const i18n = useI18n();
const panel = injectTestsPanel();
const wizard = useEvaluationsWizardSidepanelStore();

const selectedMetrics = computed(() =>
	CANNED_METRICS.filter((metric) => wizard.selectedMetricKeys.includes(metric.key)),
);

const addItems = computed<DropdownMenuItemProps[]>(() => [
	...CANNED_METRICS.filter(
		(metric) => metric.optionLabelKey && !wizard.selectedMetricKeys.includes(metric.key),
	).map((metric) => ({
		id: metric.key,
		label: i18n.baseText(metric.optionLabelKey ?? metric.labelKey),
		testId: `tests-suite-config-add-metric-item-${metric.key}`,
	})),
	{
		id: CUSTOM,
		label: i18n.baseText('evaluations.tests.detail.addMetric.custom'),
		testId: `tests-suite-config-add-metric-item-${CUSTOM}`,
	},
]);

function onAdd(id: string) {
	if (id === CUSTOM) wizard.addCustomCheck();
	else if (isCannedMetricKey(id)) wizard.toggleMetric(id);
}

function onSelectNode(name: string) {
	panel.selectAiNode(name);
}
</script>

<template>
	<section :class="$style.suite" data-test-id="tests-suite-config">
		<N8nText size="small" color="text-base">{{
			i18n.baseText('evaluations.tests.detail.when')
		}}</N8nText>
		<N8nSelect
			:model-value="wizard.aiNodeName"
			size="small"
			filterable
			:placeholder="i18n.baseText('evaluations.tests.chooseAiNode.placeholder')"
			:class="$style.select"
			data-test-id="tests-suite-config-ai-node-select"
			@update:model-value="onSelectNode"
		>
			<N8nOption
				v-for="node in panel.aiRootNodes.value"
				:key="node.name"
				:label="node.name"
				:value="node.name"
			/>
		</N8nSelect>
		<N8nText size="small" color="text-base">{{
			i18n.baseText('evaluations.tests.suite.receivesInput')
		}}</N8nText>
		<N8nButton
			v-for="metric in selectedMetrics"
			:key="metric.key"
			variant="outline"
			size="small"
			:aria-label="i18n.baseText('evaluations.tests.detail.removeMetric')"
			:data-test-id="`tests-suite-config-metric-${metric.key}`"
			@click="wizard.toggleMetric(metric.key)"
			>{{ i18n.baseText(metric.optionLabelKey ?? metric.labelKey) }}<N8nIcon icon="x" size="xsmall"
		/></N8nButton>
		<div
			v-for="check in wizard.customChecks"
			:key="check.id"
			:class="$style.custom"
			:data-test-id="`tests-suite-config-custom-${check.id}`"
		>
			<N8nInput
				:model-value="check.expression"
				size="small"
				:placeholder="i18n.baseText('evaluations.tests.metric.custom.placeholder')"
				@update:model-value="(value: string) => wizard.updateCustomCheck(check.id, value)"
			/>
			<button
				type="button"
				:class="$style.remove"
				:aria-label="i18n.baseText('evaluations.tests.detail.removeMetric')"
				:data-test-id="`tests-suite-config-custom-remove-${check.id}`"
				@click="wizard.removeCustomCheck(check.id)"
			>
				<N8nIcon icon="x" size="xsmall" />
			</button>
		</div>
		<N8nDropdownMenu :items="addItems" placement="bottom-start" @select="onAdd">
			<template #trigger>
				<N8nButton variant="ghost" size="small" data-test-id="tests-suite-config-add-metric"
					>{{ i18n.baseText('evaluations.tests.detail.addMetric')
					}}<N8nIcon icon="plus" size="xsmall"
				/></N8nButton>
			</template>
		</N8nDropdownMenu>
	</section>
</template>

<style module lang="scss">
.suite {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--xs);
	border: var(--border);
	border-radius: var(--radius--lg);
	background-color: var(--color--background--light-2);
}

.select {
	width: 160px;
}

.custom {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.remove {
	border: none;
	background: none;
	padding: 0;
	cursor: pointer;
}
</style>
