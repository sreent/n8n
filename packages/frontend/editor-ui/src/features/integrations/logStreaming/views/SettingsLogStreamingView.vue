<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the settings page of log streaming. It replaces the enterprise
 * page of the same name. The fork needs no licence: the page works while the module
 * `log-streaming` is on, and the module starts with the licence value that the fork switch gives.
 * `../FORK.md` describes it.
 */
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nCallout, N8nEmptyState, N8nHeading, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { EventDestination } from '@n8n/rest-api-client/api/eventbus';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { computed, onMounted } from 'vue';

import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { EnterpriseEditionFeature } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';

import EventDestinationCard from '../components/EventDestinationCard.vue';
import {
	LOG_STREAM_MODAL_KEY,
	LOG_STREAMING_MODULE_ID,
	type LogStreamModalData,
} from '../logStreaming.constants';
import { useLogStreamingStore } from '../logStreaming.store';

const logStreamingStore = useLogStreamingStore();
const settingsStore = useSettingsStore();
const uiStore = useUIStore();
const toast = useToast();
const documentTitle = useDocumentTitle();
const i18n = useI18n();

const isModuleActive = computed(
	() => settingsStore.isModuleActive(LOG_STREAMING_MODULE_ID) === true,
);
// Without the licence value, the fork switch is off, and the module does not start.
const moduleOffDescription = computed(() =>
	settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.LogStreaming]
		? i18n.baseText('settings.log-streaming.moduleOff.description')
		: i18n.baseText('settings.log-streaming.moduleOff.forkFeaturesOff'),
);
const managedByEnv = computed(() => settingsStore.settings.logStreaming?.managedByEnv === true);

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.log-streaming.heading'));
	if (!isModuleActive.value) return;
	try {
		await Promise.all([logStreamingStore.fetchDestinations(), logStreamingStore.fetchEventNames()]);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.log-streaming.loadError'));
	}
});

function openDestination(destination?: EventDestination) {
	const data: LogStreamModalData = { destination, isNew: destination === undefined };
	uiStore.openModalWithData({ name: LOG_STREAM_MODAL_KEY, data });
}
</script>

<template>
	<div :class="$style.container">
		<N8nHeading size="2xlarge">{{ i18n.baseText('settings.log-streaming.heading') }}</N8nHeading>
		<template v-if="isModuleActive">
			<N8nCallout v-if="managedByEnv" theme="info" data-test-id="log-streaming-managed-by-env">
				{{ i18n.baseText('settings.log-streaming.managedByEnv') }}
			</N8nCallout>
			<N8nText v-n8n-html="i18n.baseText('settings.log-streaming.infoText')" tag="p" />
			<div v-if="logStreamingStore.destinations.length > 0" :class="$style.destinations">
				<EventDestinationCard
					v-for="destination in logStreamingStore.destinations"
					:key="destination.id"
					:destination="destination"
					:read-only="managedByEnv"
					@open="openDestination"
				/>
				<div v-if="!managedByEnv" :class="$style.add">
					<N8nButton
						:label="i18n.baseText('settings.log-streaming.add')"
						size="large"
						@click="openDestination()"
					/>
				</div>
			</div>
			<N8nEmptyState
				v-else
				data-test-id="action-box-licensed"
				:heading="i18n.baseText('settings.log-streaming.addFirstTitle')"
				:description="i18n.baseText('settings.log-streaming.addFirst')"
				:button-text="managedByEnv ? undefined : i18n.baseText('settings.log-streaming.add')"
				@click:button="openDestination()"
			/>
		</template>
		<N8nEmptyState
			v-else
			data-test-id="action-box-unlicensed"
			:heading="i18n.baseText('settings.log-streaming.moduleOff.title')"
			:description="moduleOffDescription"
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

.destinations {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.add {
	display: flex;
	justify-content: flex-end;
}
</style>
