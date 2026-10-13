<script setup lang="ts">
// Fork code (not in upstream n8n): the tabs of the comparison of a collection, with the content of
// the open tab below them. See `../../FORK.md`.
import { N8nTabs } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import type { CompareTab } from '../../composables/useCompareData';

const tab = defineModel<CompareTab>({ required: true });

const i18n = useI18n();

const options = computed(() => [
	{ value: 'cases' as const, label: i18n.baseText('evaluation.compare.tabs.cases') },
	{ value: 'outputs' as const, label: i18n.baseText('evaluation.compare.tabs.outputs') },
	{ value: 'metrics' as const, label: i18n.baseText('evaluation.compare.tabs.metrics') },
	{ value: 'workflowDiff' as const, label: i18n.baseText('evaluation.compare.tabs.workflowDiff') },
]);
</script>

<template>
	<section :class="$style.tabs" data-test-id="compare-tabs">
		<N8nTabs v-model="tab" :options="options" />
		<slot />
	</section>
</template>

<style module lang="scss">
.tabs {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
</style>
