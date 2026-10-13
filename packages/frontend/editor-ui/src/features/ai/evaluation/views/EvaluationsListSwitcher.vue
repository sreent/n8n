<script setup lang="ts">
// Fork code (not in upstream n8n): the default child page of the Evaluations tab. It replaces the
// enterprise view of the same name. See `../FORK.md`.
import EvaluationsView from './EvaluationsView.vue';

defineProps<{ workflowId: string }>();
</script>

<template>
	<EvaluationsView :workflow-id="workflowId" />
</template>
