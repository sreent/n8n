<script setup lang="ts">
// Fork code (not in upstream n8n): the number or the check mark of a setup step, with its title.
// See `../../FORK.md`.
import { N8nIcon, N8nText } from '@n8n/design-system';

defineProps<{
	stepNumber: number;
	title: string;
	isCompleted: boolean;
}>();
</script>

<template>
	<div :class="$style.header">
		<div :class="[$style.indicator, { [$style.completed]: isCompleted }]">
			<N8nIcon v-if="isCompleted" icon="check" size="small" />
			<div v-else>{{ stepNumber }}</div>
		</div>
		<N8nText size="medium" color="text-dark" bold>{{ title }}</N8nText>
		<slot />
	</div>
</template>

<style module lang="scss">
.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.indicator {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	width: var(--spacing--lg);
	height: var(--spacing--lg);
	border-radius: 50%;
	border: var(--border);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.completed {
	border-color: var(--color--success);
	background-color: var(--color--success);
	color: var(--color--foreground--tint-2);
}
</style>
