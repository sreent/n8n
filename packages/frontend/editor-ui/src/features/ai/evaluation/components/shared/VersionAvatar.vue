<script setup lang="ts">
// Fork code (not in upstream n8n): the letter or the coloured dot of a version of a collection.
// See `../../FORK.md`.
import { computed } from 'vue';

import { versionColorVar, versionLetter } from './versionPalette';

const props = withDefaults(
	defineProps<{
		index: number;
		variant?: 'letter' | 'dot';
		size?: 'small' | 'medium';
	}>(),
	{ variant: 'letter', size: 'medium' },
);

const style = computed(() => ({ '--version-avatar--color': versionColorVar(props.index) }));
</script>

<template>
	<span
		v-if="variant === 'dot'"
		:class="$style.dot"
		:style="style"
		data-test-id="version-avatar-dot"
	/>
	<span
		v-else
		:class="[$style.avatar, $style[size]]"
		:style="style"
		data-test-id="version-avatar"
		>{{ versionLetter(index) }}</span
	>
</template>

<style module lang="scss">
.dot {
	display: inline-block;
	width: var(--spacing--2xs);
	height: var(--spacing--2xs);
	border-radius: 50%;
	background-color: var(--version-avatar--color);
}

.avatar {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: var(--radius);
	background-color: var(--version-avatar--color);
	color: var(--color--foreground--tint-2);
	font-weight: var(--font-weight--bold);
}

.small {
	width: var(--spacing--sm);
	height: var(--spacing--sm);
	font-size: var(--font-size--3xs);
}

.medium {
	width: var(--spacing--md);
	height: var(--spacing--md);
	font-size: var(--font-size--2xs);
}
</style>
