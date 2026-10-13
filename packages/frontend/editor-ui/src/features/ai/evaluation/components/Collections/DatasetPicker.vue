<script setup lang="ts">
// Fork code (not in upstream n8n): the dataset of a new collection, with the count of versions
// that ran on it. See `../../FORK.md`.
import { N8nIcon, N8nOption, N8nSelect, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

import type { EvaluationConfig } from '../../evaluation.types';

defineProps<{ configs: EvaluationConfig[]; matchCount?: number }>();

const configId = defineModel<string | undefined>({ required: true });

const i18n = useI18n();

function pick(value: unknown) {
	if (typeof value === 'string') configId.value = value;
}
</script>

<template>
	<div :class="$style.picker" data-test-id="dataset-picker">
		<N8nIcon icon="database" size="small" />
		<N8nSelect
			:model-value="configId"
			:placeholder="i18n.baseText('evaluation.setup.dataset.placeholder')"
			@update:model-value="pick"
		>
			<N8nOption
				v-for="config in configs"
				:key="config.id"
				:value="config.id"
				:label="config.name"
			/>
		</N8nSelect>
		<N8nText v-if="matchCount !== undefined" size="small" color="text-light">{{
			i18n.baseText('evaluation.setup.dataset.matchCount', {
				adjustToNumber: matchCount,
				interpolate: { count: matchCount },
			})
		}}</N8nText>
	</div>
</template>

<style module lang="scss">
.picker {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}
</style>
