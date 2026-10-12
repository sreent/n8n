<script setup lang="ts">
/**
 * Fork stand-in (not in upstream n8n) for the enterprise worker view, which the fork removed. The
 * page tells that the worker view is not in this build. `../FORK.md` describes it.
 */
import { N8nEmptyState, N8nHeading } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { onMounted } from 'vue';

import { useDocumentTitle } from '@/app/composables/useDocumentTitle';

const i18n = useI18n();
const documentTitle = useDocumentTitle();

onMounted(() => {
	documentTitle.set(i18n.baseText('workerList.pageTitle'));
});
</script>

<template>
	<div :class="$style.container">
		<N8nHeading size="2xlarge">{{ i18n.baseText('workerList.pageTitle') }}</N8nHeading>
		<N8nEmptyState
			data-test-id="worker-view-unlicensed"
			:heading="i18n.baseText('workerList.notInBuild.title')"
			:description="i18n.baseText('workerList.notInBuild.description')"
		/>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	padding-bottom: var(--spacing--2xl);
}
</style>
