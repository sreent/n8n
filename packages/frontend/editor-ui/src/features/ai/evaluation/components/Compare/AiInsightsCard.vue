<script setup lang="ts">
// Fork code (not in upstream n8n): the insights of a collection: the best version, the
// regressions of the other versions, and a next experiment. See `../../FORK.md`.
import type { AiInsightsResponse } from '@n8n/api-types';
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import dateformat from 'dateformat';

defineProps<{ insights?: AiInsightsResponse; failed?: boolean }>();

const emit = defineEmits<{ retry: [] }>();

const i18n = useI18n();
</script>

<template>
	<section :class="$style.card" data-test-id="compare-ai-insights">
		<div :class="$style.heading">
			<N8nIcon icon="wand-sparkles" size="small" />
			<N8nText bold>{{ i18n.baseText('evaluation.compare.insights.title') }}</N8nText>
			<N8nText v-if="insights && !failed" size="xsmall" color="text-light">{{
				i18n.baseText('evaluation.compare.insights.generatedAt', {
					interpolate: { time: dateformat(insights.generatedAt, 'hh:MM TT') },
				})
			}}</N8nText>
		</div>
		<div v-if="failed" :class="$style.error" data-test-id="compare-ai-insights-error">
			<N8nText size="small" color="danger">{{
				i18n.baseText('evaluation.compare.insights.error')
			}}</N8nText>
			<N8nButton
				variant="subtle"
				size="small"
				:label="i18n.baseText('evaluation.compare.insights.retry')"
				@click="emit('retry')"
			/>
		</div>
		<template v-else-if="insights">
			<div :class="$style.takeaways">
				<div :class="$style.takeaway">
					<N8nIcon icon="circle-check" size="small" color="success" />
					<N8nText size="xsmall" color="text-light">{{
						i18n.baseText('evaluation.compare.insights.winner')
					}}</N8nText>
					<N8nText size="small" bold>{{ insights.insights.winner.headline }}</N8nText>
					<N8nText size="small">{{ insights.insights.winner.body }}</N8nText>
				</div>
				<div :class="$style.takeaway">
					<template v-if="insights.insights.regressions.length">
						<N8nIcon icon="triangle-alert" size="small" color="warning" />
						<N8nText size="xsmall" color="text-light">{{
							i18n.baseText('evaluation.compare.insights.regression')
						}}</N8nText>
						<template
							v-for="regression in insights.insights.regressions"
							:key="`${regression.versionLabel}-${regression.metric}`"
						>
							<N8nText size="small" bold>{{ regression.headline }}</N8nText>
							<N8nText size="small">{{ regression.body }}</N8nText>
						</template>
					</template>
					<template v-else>
						<N8nIcon icon="circle-check" size="small" color="success" />
						<N8nText size="xsmall" color="text-light">{{
							i18n.baseText('evaluation.compare.insights.regression')
						}}</N8nText>
						<N8nText size="small">{{
							i18n.baseText('evaluation.compare.insights.noRegressions')
						}}</N8nText>
					</template>
				</div>
				<div :class="$style.takeaway">
					<N8nIcon icon="arrow-right" size="small" />
					<N8nText size="xsmall" color="text-light">{{
						i18n.baseText('evaluation.compare.insights.suggestedNext')
					}}</N8nText>
					<N8nText size="small" bold>{{ insights.insights.suggestedNext.headline }}</N8nText>
					<N8nText size="small">{{ insights.insights.suggestedNext.body }}</N8nText>
				</div>
			</div>
			<N8nText v-if="insights.status === 'fallback'" size="xsmall" color="text-light">{{
				i18n.baseText('evaluation.compare.insights.fallbackNote')
			}}</N8nText>
		</template>
	</section>
</template>

<style module lang="scss">
.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
}

.heading {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.error {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.takeaways {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: var(--spacing--sm);
}

.takeaway {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}
</style>
