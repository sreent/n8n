<script setup lang="ts">
// Fork code (not in upstream n8n): what a metric measures: the prompt of its LLM judge, or the
// description of a built-in metric. See `../../FORK.md`.
import { N8nText } from '@n8n/design-system';
import type { BaseTextKey } from '@n8n/i18n';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

const props = defineProps<{ metricKey: string; prompt?: string }>();

const i18n = useI18n();

const DESCRIPTIONS: Record<string, BaseTextKey> = {
	correctness: 'evaluation.metric.description.correctness',
	helpfulness: 'evaluation.metric.description.helpfulness',
	stringSimilarity: 'evaluation.metric.description.stringSimilarity',
	categorization: 'evaluation.metric.description.categorization',
	toolsUsed: 'evaluation.metric.description.toolsUsed',
};

const description = computed(() => {
	const key = DESCRIPTIONS[props.metricKey];
	return key ? i18n.baseText(key) : undefined;
});
</script>

<template>
	<div v-if="prompt || description" :class="$style.criteria" data-test-id="metric-criteria">
		<N8nText v-if="prompt" size="xsmall" color="text-light"
			>{{ i18n.baseText('evaluation.metric.criteria.label') }} {{ prompt }}</N8nText
		>
		<N8nText v-else size="xsmall" color="text-light">{{ description }}</N8nText>
	</div>
</template>

<style module lang="scss">
.criteria {
	max-width: 480px;
}
</style>
