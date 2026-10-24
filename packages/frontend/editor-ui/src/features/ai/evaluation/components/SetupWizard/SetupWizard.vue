<script setup lang="ts">
// Fork code (not in upstream n8n): the steps that set up the evaluation of a workflow: the
// evaluation trigger, the Set Outputs node, the optional Set Metrics node and the first run. It
// replaces the enterprise component of the same name. See `../../FORK.md`.
import { N8nBadge, N8nButton, N8nCallout, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';
import { I18nT } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { useUsageStore } from '@/features/settings/usage/usage.store';

import { useWorkflowEvaluationState } from '../../composables/useWorkflowEvaluationState';
import { UPGRADE_CAMPAIGN, UPGRADE_SOURCE } from '../../evaluation.constants';
import StepHeader from './StepHeader.vue';

const props = defineProps<{ workflowId: string }>();
const emit = defineEmits<{ runTest: [] }>();

const i18n = useI18n();
const router = useRouter();
const usageStore = useUsageStore();
const pageRedirectionHelper = usePageRedirectionHelper();
const { evaluationTriggerExists, evaluationSetOutputsNodeExist, evaluationSetMetricsNodeExist } =
	useWorkflowEvaluationState();

const metricsSkipped = ref(false);

const limit = computed(() => usageStore.workflowsWithEvaluationsLimit);
const quotaReached = computed(
	() => limit.value !== -1 && usageStore.workflowsWithEvaluationsCount >= limit.value,
);

const metricsDone = computed(
	() => metricsSkipped.value || (evaluationSetMetricsNodeExist.value && !quotaReached.value),
);

const activeStep = computed(() => {
	if (!evaluationTriggerExists.value) return 1;
	if (!evaluationSetOutputsNodeExist.value) return 2;
	if (!metricsDone.value) return 3;
	return 4;
});

const canRunInEditor = computed(
	() => evaluationTriggerExists.value && evaluationSetOutputsNodeExist.value,
);
const canRunEvaluation = computed(
	() => canRunInEditor.value && evaluationSetMetricsNodeExist.value && !quotaReached.value,
);

async function openEditor(
	action: 'addEvaluationTrigger' | 'addEvaluationNode' | 'executeEvaluation',
) {
	await router.push({
		name: VIEWS.WORKFLOW,
		params: { workflowId: props.workflowId },
		query: { action },
	});
}

function seePlans() {
	void pageRedirectionHelper.goToUpgrade(UPGRADE_SOURCE, UPGRADE_CAMPAIGN);
}
</script>

<template>
	<div :class="$style.wizard" data-test-id="evaluation-setup-wizard">
		<div :class="$style.step">
			<StepHeader
				:step-number="1"
				:title="i18n.baseText('evaluations.setupWizard.step1.title')"
				:is-completed="evaluationTriggerExists"
			/>
			<div v-if="activeStep === 1" :class="$style.body">
				<ul :class="$style.items">
					<li>
						<N8nText size="small" color="text-base">{{
							i18n.baseText('evaluations.setupWizard.step1.item1')
						}}</N8nText>
					</li>
					<li>
						<N8nText size="small" color="text-base">{{
							i18n.baseText('evaluations.setupWizard.step1.item2')
						}}</N8nText>
					</li>
				</ul>
				<N8nButton size="small" @click="openEditor('addEvaluationTrigger')">{{
					i18n.baseText('evaluations.setupWizard.step1.button')
				}}</N8nButton>
			</div>
		</div>

		<div :class="$style.step">
			<StepHeader
				:step-number="2"
				:title="i18n.baseText('evaluations.setupWizard.step2.title')"
				:is-completed="evaluationSetOutputsNodeExist"
			/>
			<div v-if="activeStep === 2" :class="$style.body">
				<ul :class="$style.items">
					<li>
						<N8nText size="small" color="text-base">{{
							i18n.baseText('evaluations.setupWizard.step2.item1')
						}}</N8nText>
					</li>
				</ul>
				<N8nButton size="small" @click="openEditor('addEvaluationNode')">{{
					i18n.baseText('evaluations.setupWizard.step2.button')
				}}</N8nButton>
			</div>
		</div>

		<div :class="$style.step">
			<StepHeader
				:step-number="3"
				:title="i18n.baseText('evaluations.setupWizard.step3.title')"
				:is-completed="evaluationSetMetricsNodeExist"
			>
				<N8nBadge>{{ i18n.baseText('evaluations.setupWizard.stepHeader.optional') }}</N8nBadge>
			</StepHeader>
			<div v-if="activeStep === 3" :class="$style.body">
				<template v-if="quotaReached">
					<N8nCallout theme="warning" iconless>{{
						i18n.baseText('evaluations.setupWizard.limitReached')
					}}</N8nCallout>
					<div :class="$style.actions">
						<N8nButton size="small" @click="seePlans">{{
							i18n.baseText('evaluations.setupWizard.step3.notice.link')
						}}</N8nButton>
						<N8nButton size="small" variant="outline" @click="metricsSkipped = true">{{
							i18n.baseText('evaluations.setupWizard.step3.skip')
						}}</N8nButton>
					</div>
				</template>
				<template v-else>
					<ul :class="$style.items">
						<li>
							<N8nText size="small" color="text-base">{{
								i18n.baseText('evaluations.setupWizard.step3.item1')
							}}</N8nText>
						</li>
						<li>
							<N8nText size="small" color="text-base">{{
								i18n.baseText('evaluations.setupWizard.step3.item2')
							}}</N8nText>
						</li>
					</ul>
					<div :class="$style.actions">
						<N8nButton size="small" @click="openEditor('addEvaluationNode')">{{
							i18n.baseText('evaluations.setupWizard.step3.button')
						}}</N8nButton>
						<N8nButton size="small" variant="outline" @click="metricsSkipped = true">{{
							i18n.baseText('evaluations.setupWizard.step3.skip')
						}}</N8nButton>
					</div>
					<p v-if="limit === 1" :class="$style.notice">
						<I18nT keypath="evaluations.setupWizard.step3.notice" scope="global">
							<template #link>
								<a :class="$style.link" @click="seePlans">{{
									i18n.baseText('evaluations.setupWizard.step3.notice.link')
								}}</a>
							</template>
						</I18nT>
					</p>
				</template>
			</div>
		</div>

		<div :class="$style.step">
			<div :class="$style.lastStep">
				<div :class="$style.stepNumber">4</div>
				<N8nButton v-if="canRunEvaluation" size="small" variant="solid" @click="emit('runTest')">{{
					i18n.baseText('evaluations.setupWizard.step4.button')
				}}</N8nButton>
				<N8nButton
					v-else
					size="small"
					variant="outline"
					:disabled="!canRunInEditor"
					@click="openEditor('executeEvaluation')"
					>{{ i18n.baseText('evaluations.setupWizard.step4.altButton') }}</N8nButton
				>
			</div>
		</div>
	</div>
</template>

<style module lang="scss">
.wizard {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: var(--spacing--md);
	border: var(--border);
	border-radius: var(--radius--lg);
	background-color: var(--color--background--light-3);
}

.step {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.body {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--spacing--xs);
	padding-left: var(--spacing--xl);
}

.items {
	margin: 0;
	padding-left: var(--spacing--sm);
	list-style: disc;
}

.actions {
	display: flex;
	gap: var(--spacing--2xs);
}

.notice {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.link {
	cursor: pointer;
	color: var(--color--primary);
}

.lastStep {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.stepNumber {
	display: flex;
	align-items: center;
	justify-content: center;
	width: var(--spacing--lg);
	height: var(--spacing--lg);
	border-radius: 50%;
	border: var(--border);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}
</style>
