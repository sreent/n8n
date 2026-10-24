<script setup lang="ts">
// Fork code (not in upstream n8n): the change of a metric from the previous run. The sign of
// `delta` gives the direction, and `label` is the change as the run detail shows it. See
// `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';

defineProps<{ delta: number; label: string }>();
</script>

<template>
	<span
		:class="[$style.badge, delta > 0 ? $style.up : $style.down]"
		data-test-id="trend-delta-badge"
	>
		<N8nIcon :icon="delta > 0 ? 'trending-up' : 'trending-down'" size="small" />
		<N8nText size="xsmall" bold>{{ label }}</N8nText>
	</span>
</template>

<style module lang="scss">
.badge {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	padding: 0 var(--spacing--3xs);
	border-radius: var(--radius--full);
}

.up {
	color: var(--color--success);
}

.down {
	color: var(--color--danger);
}
</style>
