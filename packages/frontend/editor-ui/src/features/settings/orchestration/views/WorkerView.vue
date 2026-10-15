<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the page Settings > Workers. In queue mode with the worker
 * view, it asks the workers for their status each second and shows a card for each worker. It
 * replaces the enterprise page of the same name. `../FORK.md` describes it.
 */
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { N8nEmptyState, N8nHeading, N8nSpinner } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onBeforeUnmount, onMounted } from 'vue';

import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';

import WorkerCard from '../components/WorkerCard.vue';
import { useOrchestrationStore } from '../orchestration.store';

const i18n = useI18n();
const documentTitle = useDocumentTitle();
const telemetry = useTelemetry();
const pageRedirectionHelper = usePageRedirectionHelper();
const settingsStore = useSettingsStore();
const rootStore = useRootStore();
const orchestrationStore = useOrchestrationStore();

const isAvailable = computed(
	() => settingsStore.isWorkerViewAvailable && settingsStore.isQueueModeEnabled,
);
const workerIds = computed(() => Object.keys(orchestrationStore.workers));

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('worker-view', 'upgrade-worker-view');
}

onMounted(() => {
	documentTitle.set(i18n.baseText('workerList.pageTitle'));
	if (!isAvailable.value) return;
	telemetry.track('User viewed worker view', { instance_id: rootStore.instanceId });
	orchestrationStore.startWorkerStatusPolling();
});

onBeforeUnmount(() => {
	orchestrationStore.stopWorkerStatusPolling();
});
</script>

<template>
	<div v-if="isAvailable" :class="$style.container" data-test-id="worker-view-licensed">
		<N8nHeading tag="h1" size="2xlarge">{{ i18n.baseText('workerList.pageTitle') }}</N8nHeading>
		<div v-if="!orchestrationStore.initialStatusReceived" :class="$style.loading">
			<N8nSpinner />
		</div>
		<div v-else-if="workerIds.length === 0">{{ i18n.baseText('workerList.empty') }}</div>
		<div v-else :class="$style.workers">
			<WorkerCard
				v-for="workerId in workerIds"
				:key="workerId"
				:worker-id="workerId"
				data-test-id="worker-card"
			/>
		</div>
	</div>
	<N8nEmptyState
		v-else
		data-test-id="worker-view-unlicensed"
		:heading="i18n.baseText('workerList.actionBox.title')"
		:description="i18n.baseText('workerList.actionBox.description')"
		:button-text="i18n.baseText('workerList.actionBox.buttonText')"
		@click:button="goToUpgrade"
	>
		<template #description>
			{{ i18n.baseText('workerList.actionBox.description') }}
			<a :href="i18n.baseText('workerList.docs.url')" target="_blank">
				{{ i18n.baseText('workerList.actionBox.description.link') }}
			</a>
		</template>
	</N8nEmptyState>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	padding-bottom: var(--spacing--2xl);
}

.loading {
	display: flex;
	justify-content: center;
}

.workers {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
</style>
