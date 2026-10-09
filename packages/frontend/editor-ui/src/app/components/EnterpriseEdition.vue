<script setup lang="ts">
// Fork component (not in upstream n8n): it shows its content only when the licence has some
// features, in place of the enterprise `EnterpriseEdition.ee.vue`. It keeps the name, so that the
// callers change only their import. packages/frontend/editor-ui/FORK.md describes it.
import { useSettingsStore } from '@n8n/stores/settings.store';
import { computed } from 'vue';

import type { EnterpriseEditionFeatureValue } from '@/Interface';

const props = withDefaults(defineProps<{ features?: EnterpriseEditionFeatureValue[] }>(), {
	features: () => [],
});

const settingsStore = useSettingsStore();

/** True when the licence has each of the features. An empty list needs none. */
const isEnabled = computed(() =>
	props.features.every((feature) => !!settingsStore.isEnterpriseFeatureEnabled[feature]),
);
</script>

<template>
	<div>
		<slot v-if="isEnabled" />
		<slot v-else name="fallback" />
	</div>
</template>
