<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): a section of a worker card that opens and closes. The title
 * shows a count when the section has one. See `../FORK.md`.
 */
import { N8nIcon, N8nText } from '@n8n/design-system';
import { ref } from 'vue';

const props = defineProps<{
	title: string;
	count?: number;
	initiallyExpanded?: boolean;
}>();

const expanded = ref(props.initiallyExpanded ?? false);
</script>

<template>
	<div :class="$style.accordion">
		<div :class="$style.header" @click="expanded = !expanded">
			<N8nIcon icon="list-checks" color="text-dark" size="small" />
			<N8nText size="small" color="text-dark" bold
				>{{ title }}<template v-if="count !== undefined"> ({{ count }}) </template></N8nText
			>
			<N8nIcon :icon="expanded ? 'chevron-up' : 'chevron-down'" color="text-dark" size="small" />
		</div>
		<div v-if="expanded" :class="$style.content">
			<slot />
		</div>
	</div>
</template>

<style lang="scss" module>
.accordion {
	border: var(--border);
	border-radius: var(--radius);
	background-color: var(--color--background--light-2);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--2xs) var(--spacing--xs);
	cursor: pointer;
}

.content {
	padding: 0 var(--spacing--xs) var(--spacing--xs);
}
</style>
