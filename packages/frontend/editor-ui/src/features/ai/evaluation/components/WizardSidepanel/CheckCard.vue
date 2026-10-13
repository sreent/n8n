<script setup lang="ts">
// Fork code (not in upstream n8n): a tile of a check: its icon, its name, a tag for a check with an
// AI judge, and what it checks. See `../../FORK.md`.
import { N8nBadge, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { LLM_JUDGE_METRIC_KEYS, type CannedMetric } from '../../wizard.constants';

const props = defineProps<{ metric: CannedMetric; selected?: boolean }>();

const emit = defineEmits<{ toggle: [key: CannedMetric['key']] }>();

const i18n = useI18n();

const isJudge = computed(() => LLM_JUDGE_METRIC_KEYS.includes(props.metric.key));
</script>

<template>
	<div :class="[$style.card, { [$style.selected]: selected }]" @click="emit('toggle', metric.key)">
		<div :class="[$style.icon, $style[metric.key]]">
			<N8nIcon :icon="metric.icon" size="medium" />
		</div>
		<div :class="$style.text">
			<div :class="$style.title">
				<N8nText size="small" color="text-dark" bold>{{ i18n.baseText(metric.labelKey) }}</N8nText
				><template v-if="isJudge"
					>{{ ' '
					}}<N8nBadge size="xsmall">{{
						i18n.baseText('evaluations.wizardSidepanel.metric.judgeTag')
					}}</N8nBadge></template
				>
			</div>
			<N8nText size="xsmall" color="text-base">{{ i18n.baseText(metric.descriptionKey) }}</N8nText>
		</div>
	</div>
</template>

<style module lang="scss">
.card {
	display: flex;
	gap: var(--spacing--2xs);
	width: 240px;
	flex-shrink: 0;
	padding: var(--spacing--xs);
	border: var(--border);
	border-radius: var(--radius--lg);
	background-color: var(--color--background--light-3);
}

.selected {
	border-color: var(--color--primary);
}

.icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	flex-shrink: 0;
	border-radius: var(--radius);
}

.correctness {
	background-color: var(--color--green--tint-3);
	color: var(--color--green--shade-1);
}

.helpfulness {
	background-color: var(--color--blue--tint-3);
	color: var(--color--blue--shade-1);
}

.stringSimilarity {
	background-color: var(--color--purple--tint-3);
	color: var(--color--purple--shade-1);
}

.categorization {
	background-color: var(--color--yellow--tint-3);
	color: var(--color--yellow--shade-1);
}

.toolsUsed {
	background-color: var(--color--teal--tint-3);
	color: var(--color--teal--shade-1);
}

.text {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.title {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}
</style>
