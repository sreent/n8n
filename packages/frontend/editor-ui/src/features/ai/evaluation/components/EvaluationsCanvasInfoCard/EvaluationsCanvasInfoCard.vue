<script setup lang="ts">
// Fork code (not in upstream n8n): the card on the canvas that offers evaluations for a published
// workflow with an AI node and no evaluation config yet. "Setup" opens the Tests panel, and the
// close button hides the card for the workflow in this browser. It replaces the enterprise
// component of the same name. See `../../FORK.md`.
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useLocalStorage } from '@vueuse/core';
import { computed, onMounted, ref, watch } from 'vue';

import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { useEvaluationsWizardSidepanelExperiment } from '@/experiments/evaluationsWizardSidepanel/useEvaluationsWizardSidepanelExperiment';

import { useAiRootNodes } from '../../composables/useAiRootNodes';
import { useEvaluationsLicense } from '../../composables/useEvaluationsLicense';
import { useEvaluationStore } from '../../evaluation.store';
import { CANNED_METRICS, CANVAS_INFO_CARD_DISMISSED_KEY } from '../../wizard.constants';
import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import CheckCard from '../WizardSidepanel/CheckCard.vue';

const i18n = useI18n();
const telemetry = useTelemetry();
const wizard = useEvaluationsWizardSidepanelStore();
const evaluationStore = useEvaluationStore();
const workflowDocumentStore = injectWorkflowDocumentStore();
const aiRootNodes = useAiRootNodes();
const { isFeatureEnabled } = useEvaluationsWizardSidepanelExperiment();
const { isLicensed, ensureLicenseLoaded } = useEvaluationsLicense();

/** The checks run past twice, so that the strip has no gap. */
const marqueeMetrics = [...CANNED_METRICS, ...CANNED_METRICS];

const dismissedStorage = useLocalStorage<string | null>(CANVAS_INFO_CARD_DISMISSED_KEY, null);
const dismissedSet = computed(
	() => new Set((dismissedStorage.value ?? '').split(',').filter(Boolean)),
);

/** True when the workflow has an evaluation config, or when they fail to load. */
const hasConfigs = ref<boolean | null>(null);
let inFlightWorkflowId: string | null = null;

const workflowId = computed(() => workflowDocumentStore.value.workflowId);
const isWorkflowActive = computed(() => workflowDocumentStore.value.active);
const isDismissed = computed(() => dismissedSet.value.has(workflowId.value));

const qualifies = computed(
	() =>
		isFeatureEnabled.value &&
		isLicensed.value &&
		aiRootNodes.value.length > 0 &&
		isWorkflowActive.value &&
		!isDismissed.value,
);

const isVisible = computed(() => qualifies.value && hasConfigs.value === false && !wizard.isOpen);

async function checkConfigs(id: string) {
	if (inFlightWorkflowId === id) return;
	inFlightWorkflowId = id;
	try {
		const configs = await evaluationStore.fetchEvaluationConfigs(id);
		if (inFlightWorkflowId === id) hasConfigs.value = configs.length > 0;
	} catch {
		if (inFlightWorkflowId === id) hasConfigs.value = true;
	} finally {
		if (inFlightWorkflowId === id) inFlightWorkflowId = null;
	}
}

watch(
	[qualifies, workflowId],
	([qualified, id]) => {
		if (qualified && id && hasConfigs.value === null) void checkConfigs(id);
	},
	{ immediate: true },
);

watch(workflowId, () => {
	hasConfigs.value = null;
});

function dismiss() {
	dismissedStorage.value = [...dismissedSet.value, workflowId.value].join(',');
}

function openWizard() {
	telemetry.track('User opened evaluations wizard', {
		source: 'canvas_info_card',
		workflow_id: workflowId.value,
	});
	wizard.open(0);
}

onMounted(() => {
	void ensureLicenseLoaded();
});
</script>

<template>
	<aside
		v-if="isVisible"
		:class="$style.card"
		role="complementary"
		data-test-id="evaluations-canvas-info-card"
	>
		<button
			type="button"
			:class="$style.dismiss"
			:aria-label="i18n.baseText('evaluations.canvasInfoCard.dismiss')"
			data-test-id="evaluations-canvas-info-card-dismiss"
			@click="dismiss"
		>
			<N8nIcon icon="x" size="small" />
		</button>
		<div :class="$style.marquee">
			<div :class="$style.track">
				<CheckCard
					v-for="(metric, index) in marqueeMetrics"
					:key="`${metric.key}-${index}`"
					:metric="metric"
				/>
			</div>
		</div>
		<div :class="$style.body">
			<N8nText size="medium" color="text-dark" bold>{{
				i18n.baseText('evaluations.canvasInfoCard.title')
			}}</N8nText>
			<N8nText size="small" color="text-base">{{
				i18n.baseText('evaluations.canvasInfoCard.description')
			}}</N8nText>
			<div>
				<N8nButton
					variant="solid"
					size="small"
					data-test-id="evaluations-canvas-info-card-setup"
					@click="openWizard"
					>{{ i18n.baseText('evaluations.canvasInfoCard.setup') }}</N8nButton
				>
			</div>
		</div>
	</aside>
</template>

<style module lang="scss">
.card {
	position: relative;
	display: flex;
	flex-direction: column;
	width: 360px;
	overflow: hidden;
	border: var(--border);
	border-radius: var(--radius--lg);
	background-color: var(--color--background--light-3);
	box-shadow: var(--shadow--light);
}

.dismiss {
	position: absolute;
	top: var(--spacing--2xs);
	right: var(--spacing--2xs);
	z-index: 1;
	border: none;
	background: none;
	padding: 0;
	cursor: pointer;
	color: var(--color--text--tint-1);
}

.marquee {
	overflow: hidden;
	padding: var(--spacing--sm) 0;
	background-color: var(--color--background--light-2);
}

.track {
	display: flex;
	gap: var(--spacing--xs);
	width: max-content;
	animation: marquee 40s linear infinite;
}

@keyframes marquee {
	from {
		transform: translateX(0);
	}

	to {
		transform: translateX(-50%);
	}
}

@media (prefers-reduced-motion: reduce) {
	.track {
		animation: none;
	}
}

.body {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm);
}
</style>
