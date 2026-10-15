<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the network interfaces of a worker. A click on an address
 * copies it. See `../FORK.md`.
 */
import type { WorkerStatus } from '@n8n/api-types';
import { useClipboard } from '@n8n/composables/useClipboard';
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';

import WorkerAccordion from './WorkerAccordion.vue';

defineProps<{ items: WorkerStatus['interfaces'] }>();

const i18n = useI18n();
const clipboard = useClipboard();
const toast = useToast();

async function copyAddress(address: string) {
	await clipboard.copy(address);
	toast.showMessage({
		title: i18n.baseText('workerList.item.copyAddressToClipboard'),
		type: 'success',
	});
}
</script>

<template>
	<WorkerAccordion :title="i18n.baseText('workerList.item.netListTitle')" :count="items.length">
		<div v-for="item in items" :key="item.address" :class="$style.interface">
			{{ item.family }}:
			<span :class="$style.address" @click="copyAddress(item.address)">{{ item.address }}</span>
			{{ item.internal ? i18n.baseText('workerList.item.net.internal') : '' }}
		</div>
	</WorkerAccordion>
</template>

<style lang="scss" module>
.interface {
	font-size: var(--font-size--2xs);
	line-height: var(--line-height--xl);
}

.address {
	cursor: pointer;
	text-decoration: underline dotted;
}
</style>
