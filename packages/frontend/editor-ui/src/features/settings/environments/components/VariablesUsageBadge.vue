<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the usage syntax of a variable (`$vars.KEY`). A click copies
 * it. It replaces the enterprise component of the same name. See `../FORK.md`.
 */
import { useClipboard } from '@n8n/composables/useClipboard';
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

const props = defineProps<{
	name: string;
}>();

const i18n = useI18n();
const clipboard = useClipboard();
const { showMessage } = useToast();

const usage = computed(() => `$vars.${props.name}`);

async function onClick() {
	await clipboard.copy(usage.value);
	showMessage({
		title: i18n.baseText('variables.row.usage.copiedToClipboard'),
		type: 'success',
	});
}
</script>

<template>
	<span :class="$style.usage" @click="onClick">{{ usage }}</span>
</template>

<style module lang="scss">
.usage {
	display: inline-block;
	padding: var(--spacing--5xs) var(--spacing--3xs);
	border-radius: var(--radius);
	background-color: var(--variables-usage--syntax--color--background);
	color: var(--variables-usage--color--text);
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--2xs);
	cursor: pointer;
}
</style>
