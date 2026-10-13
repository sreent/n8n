<script setup lang="ts">
// Fork code (not in upstream n8n): the default child page of the Evaluations tab: the runs of the
// workflow and, when the collections of evaluations are on, the collections below them. It
// replaces the enterprise view of the same name. See `../FORK.md`.
import { defineAsyncComponent } from 'vue';

import { useEvalCollectionsFlag } from '../composables/useEvalCollectionsFlag';
import EvaluationsView from './EvaluationsView.vue';

defineProps<{ workflowId: string }>();

// Only the users with the collections flag load the collections list.
const EvalCollectionsListView = defineAsyncComponent(
	async () => await import('./EvalCollectionsListView.vue'),
);

const collectionsEnabled = useEvalCollectionsFlag();
</script>

<template>
	<div :class="$style.page">
		<EvaluationsView :workflow-id="workflowId" />
		<EvalCollectionsListView v-if="collectionsEnabled" :workflow-id="workflowId" />
	</div>
</template>

<style module lang="scss">
.page {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xl);
}
</style>
