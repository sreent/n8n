<script setup lang="ts">
import { useDocumentTitle } from '@n8n/composables/useDocumentTitle';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nCallout,
	N8nLoading,
	N8nSettingsLayout,
	N8nSettingsPageHeader,
	N8nSwitch,
	N8nTabs,
	N8nText,
	type TabOptions,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { computed, onMounted, ref } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';
import AiGatewayBudgets from '../components/AiGatewayBudgets.vue';
import AiGatewayOverview from '../components/AiGatewayOverview.vue';
import AiGatewayPrices from '../components/AiGatewayPrices.vue';
import AiGatewayProviders from '../components/AiGatewayProviders.vue';
import AiGatewayTopUps from '../components/AiGatewayTopUps.vue';
import AiGatewayUsage from '../components/AiGatewayUsage.vue';

type Tab = 'overview' | 'providers' | 'budgets' | 'topUps' | 'prices' | 'usage';

const i18n = useI18n();
const toast = useToast();
const settingsStore = useSettingsStore();
const store = useAiGatewayAdminStore();
const documentTitle = useDocumentTitle({ releaseChannel: settingsStore.settings.releaseChannel });

const loading = ref(true);
const activeTab = ref<Tab>('overview');

const tabs = computed<Array<TabOptions<Tab>>>(() => [
	{ value: 'overview', label: i18n.baseText('settings.forkAiGateway.tab.overview') },
	{ value: 'providers', label: i18n.baseText('settings.forkAiGateway.tab.providers') },
	{ value: 'budgets', label: i18n.baseText('settings.forkAiGateway.tab.budgets') },
	{ value: 'topUps', label: i18n.baseText('settings.forkAiGateway.tab.topUps') },
	{ value: 'prices', label: i18n.baseText('settings.forkAiGateway.tab.prices') },
	{ value: 'usage', label: i18n.baseText('settings.forkAiGateway.tab.usage') },
]);

const enabled = computed(() => store.settings?.enabled ?? false);

async function onEnabledChange(value: boolean) {
	try {
		await store.saveSettings({ enabled: value });
		toast.showMessage({ title: i18n.baseText('settings.forkAiGateway.saved'), type: 'success' });
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.saveError'));
	}
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.forkAiGateway.title'));
	try {
		await store.fetchAll();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.loadError'));
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<N8nSettingsLayout full-width data-test-id="settings-fork-ai-gateway">
		<N8nSettingsPageHeader
			:title="i18n.baseText('settings.forkAiGateway.title')"
			:description="i18n.baseText('settings.forkAiGateway.description')"
			:show-docs-link="false"
		/>

		<N8nLoading v-if="loading" :loading="true" variant="p" :rows="5" />
		<template v-else-if="store.settings">
			<div :class="$style.status">
				<N8nSwitch
					:model-value="enabled"
					:label="i18n.baseText('settings.forkAiGateway.enabled')"
					:disabled="store.saving"
					data-test-id="ai-gateway-enabled"
					@update:model-value="onEnabledChange"
				/>
				<N8nText size="small" :bold="true" data-test-id="ai-gateway-status">
					{{
						enabled && store.baseUrl
							? i18n.baseText('settings.forkAiGateway.status.on')
							: i18n.baseText('settings.forkAiGateway.status.off')
					}}
				</N8nText>
			</div>
			<N8nCallout
				v-if="enabled && !store.hasProvider"
				theme="warning"
				data-test-id="ai-gateway-no-provider"
			>
				{{ i18n.baseText('settings.forkAiGateway.status.noProvider') }}
			</N8nCallout>
			<N8nText v-if="store.baseUrl" size="small" color="text-light" data-test-id="ai-gateway-url">
				{{
					i18n.baseText('settings.forkAiGateway.baseUrl', { interpolate: { url: store.baseUrl } })
				}}
			</N8nText>

			<N8nTabs v-model="activeTab" :options="tabs" data-test-id="ai-gateway-tabs" />

			<AiGatewayOverview
				v-if="activeTab === 'overview' && store.overview"
				:overview="store.overview"
			/>
			<AiGatewayProviders v-else-if="activeTab === 'providers'" />
			<AiGatewayBudgets v-else-if="activeTab === 'budgets'" />
			<AiGatewayTopUps v-else-if="activeTab === 'topUps'" />
			<AiGatewayPrices v-else-if="activeTab === 'prices'" />
			<AiGatewayUsage v-else-if="activeTab === 'usage'" />
		</template>
	</N8nSettingsLayout>
</template>

<style lang="scss" module>
.status {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
}
</style>
