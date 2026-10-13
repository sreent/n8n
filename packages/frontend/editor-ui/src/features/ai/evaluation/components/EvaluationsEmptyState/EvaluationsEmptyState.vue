<script setup lang="ts">
// Fork code (not in upstream n8n): the first page of the Evaluations tab when the evaluation
// configs are on. It tells what evaluations do, and "Get started" opens the Tests panel on the
// canvas. See `../../FORK.md`.
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import type { IconName } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { BaseTextKey } from '@n8n/i18n';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';

const props = defineProps<{ workflowId: string }>();

const i18n = useI18n();
const router = useRouter();

const FEATURES: Array<{ icon: IconName; title: BaseTextKey; description: BaseTextKey }> = [
	{
		icon: 'bug',
		title: 'evaluations.emptyState.catchIssues.title',
		description: 'evaluations.emptyState.catchIssues.description',
	},
	{
		icon: 'blocks',
		title: 'evaluations.emptyState.buildConfidence.title',
		description: 'evaluations.emptyState.buildConfidence.description',
	},
	{
		icon: 'gauge',
		title: 'evaluations.emptyState.measurePerformance.title',
		description: 'evaluations.emptyState.measurePerformance.description',
	},
];

/** The canvas opens the Tests panel for this action (see NodeView). */
async function getStarted() {
	await router.push({
		name: VIEWS.WORKFLOW,
		params: { workflowId: props.workflowId },
		query: { action: 'openEvaluationsWizard' },
	});
}
</script>

<template>
	<div :class="$style.container" data-test-id="evaluations-empty-state">
		<div :class="$style.header">
			<N8nText tag="h2" size="xlarge" color="text-dark" bold>{{
				i18n.baseText('evaluations.emptyState.title')
			}}</N8nText>
			<N8nText tag="p" color="text-base">{{
				i18n.baseText('evaluations.emptyState.description')
			}}</N8nText>
		</div>
		<ul :class="$style.features">
			<li v-for="feature in FEATURES" :key="feature.title" :class="$style.feature">
				<N8nIcon :icon="feature.icon" size="large" color="primary" />
				<div :class="$style.featureText">
					<N8nText tag="p" color="text-dark" bold>{{ i18n.baseText(feature.title) }}</N8nText>
					<N8nText tag="p" size="small" color="text-base">{{
						i18n.baseText(feature.description)
					}}</N8nText>
				</div>
			</li>
		</ul>
		<div>
			<N8nButton
				type="primary"
				size="large"
				data-test-id="evaluations-empty-state-get-started"
				:label="i18n.baseText('evaluations.emptyState.getStarted')"
				@click="getStarted"
			/>
		</div>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	max-width: 720px;
	margin: 0 auto;
	padding-top: var(--spacing--2xl);
}

.header {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.features {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: var(--spacing--md);
	padding: 0;
	margin: 0;
	list-style: none;
}

.feature {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: var(--spacing--md);
	border: var(--border);
	border-radius: var(--radius--lg);
	background-color: var(--color--background--light-3);
}

.featureText {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}
</style>
