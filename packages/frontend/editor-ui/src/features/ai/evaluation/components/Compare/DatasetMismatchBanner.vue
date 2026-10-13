<script setup lang="ts">
// Fork code (not in upstream n8n): a notice that the versions of a collection ran on datasets
// with other case counts. See `../../FORK.md`.
import { N8nCallout } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

const props = defineProps<{ counts: number[] }>();

const i18n = useI18n();

const message = computed(() =>
	i18n.baseText('evaluation.compare.datasetMismatch', {
		interpolate: { counts: props.counts.join(', ') },
	}),
);
</script>

<template>
	<N8nCallout theme="warning" data-test-id="compare-dataset-mismatch">{{ message }}</N8nCallout>
</template>
