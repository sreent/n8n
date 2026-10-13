<script setup lang="ts">
// Fork code (not in upstream n8n): a spinner with a label, for a collection that runs. See
// `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';

defineProps<{ label: string }>();
</script>

<template>
	<span :class="$style.indicator" data-test-id="eval-running-indicator">
		<N8nIcon icon="spinner" size="small" spin />
		<N8nText size="small" color="text-light">{{ label }}</N8nText>
	</span>
</template>

<style module lang="scss">
.indicator {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
}
</style>
