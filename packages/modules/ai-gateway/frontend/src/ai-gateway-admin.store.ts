import {
	AI_GATEWAY_USAGE_DEFAULT_PAGE_SIZE,
	type AiGatewayAdminUsageEntry,
	type AiGatewayOption,
	type AiGatewayOverview,
	type AiGatewayPriceTable,
	type AiGatewayProviderInfo,
	type AiGatewaySettings,
	type AiGatewaySettingsResponse,
	type AiGatewayTopUpEntry,
} from '@n8n/api-types';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
	addAiGatewayTopUp,
	getAiGatewayOverview,
	getAiGatewayPrices,
	getAiGatewaySettings,
	getAiGatewayTopUps,
	getAiGatewayUsage,
	updateAiGatewaySettings,
	type AiGatewayUsageFilters,
} from './ai-gateway.api';
import { AI_GATEWAY_ADMIN_STORE } from './ai-gateway.constants';

/**
 * The state of the page **Settings > AI gateway**: the settings, the overview of the month, the
 * top-ups, the prices and one page of calls. A save sends the full settings, so the store keeps
 * the last settings that the backend gave.
 */
export const useAiGatewayAdminStore = defineStore(AI_GATEWAY_ADMIN_STORE, () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	const settings = ref<AiGatewaySettings | null>(null);
	const providers = ref<AiGatewayProviderInfo[]>([]);
	const projects = ref<AiGatewayOption[]>([]);
	const baseUrl = ref<string | null>(null);
	const overview = ref<AiGatewayOverview | null>(null);
	const topUps = ref<AiGatewayTopUpEntry[]>([]);
	const priceTable = ref<AiGatewayPriceTable | null>(null);

	const usage = ref<AiGatewayAdminUsageEntry[]>([]);
	const usageCount = ref(0);
	const usageFilters = ref<AiGatewayUsageFilters>({});
	const usagePage = ref(0);
	const usagePageSize = ref(AI_GATEWAY_USAGE_DEFAULT_PAGE_SIZE);
	const loadingUsage = ref(false);
	const saving = ref(false);

	/** Whether at least one provider has a credential. Without one, the gateway stays off. */
	const hasProvider = computed(() =>
		providers.value.some((provider) => provider.credential !== null),
	);

	function providerName(slug: string) {
		return providers.value.find((provider) => provider.slug === slug)?.displayName ?? slug;
	}

	function applySettings(response: AiGatewaySettingsResponse) {
		settings.value = response.settings;
		providers.value = response.providers;
		projects.value = response.projects;
		baseUrl.value = response.baseUrl;
	}

	async function fetchSettings() {
		applySettings(await getAiGatewaySettings(rootStore.restApiContext));
	}

	async function fetchOverview() {
		overview.value = await getAiGatewayOverview(rootStore.restApiContext);
	}

	async function fetchTopUps() {
		topUps.value = await getAiGatewayTopUps(rootStore.restApiContext);
	}

	async function fetchPrices() {
		priceTable.value = await getAiGatewayPrices(rootStore.restApiContext);
	}

	// Only the newest request may change the list. An older response that comes later is ignored.
	let latestUsageRequest = 0;

	async function fetchUsage() {
		const request = ++latestUsageRequest;
		loadingUsage.value = true;
		try {
			const result = await getAiGatewayUsage(
				rootStore.restApiContext,
				usageFilters.value,
				usagePage.value * usagePageSize.value,
				usagePageSize.value,
			);
			if (request !== latestUsageRequest) return;
			usage.value = result.entries;
			usageCount.value = result.count;
		} finally {
			if (request === latestUsageRequest) loadingUsage.value = false;
		}
	}

	async function fetchAll() {
		await Promise.all([fetchSettings(), fetchOverview(), fetchTopUps(), fetchPrices()]);
	}

	/** Saves the settings with a change, then reads the overview again. */
	async function saveSettings(change: Partial<AiGatewaySettings>) {
		if (!settings.value) return;
		saving.value = true;
		try {
			applySettings(
				await updateAiGatewaySettings(rootStore.restApiContext, { ...settings.value, ...change }),
			);
			await Promise.all([fetchOverview(), fetchPrices()]);
		} finally {
			saving.value = false;
		}
		if (change.enabled !== undefined || change.providers !== undefined) {
			// The editor offers Use Gateway credits only while the gateway is on.
			await settingsStore.getSettings().catch(() => undefined);
		}
	}

	async function addTopUp(amount: number, note?: string) {
		const trimmed = note?.trim();
		overview.value = await addAiGatewayTopUp(rootStore.restApiContext, {
			amount,
			...(trimmed ? { note: trimmed } : {}),
		});
		await fetchTopUps();
	}

	function setUsageFilters(filters: AiGatewayUsageFilters) {
		usageFilters.value = filters;
		usagePage.value = 0;
	}

	return {
		settings,
		providers,
		projects,
		baseUrl,
		overview,
		topUps,
		priceTable,
		usage,
		usageCount,
		usageFilters,
		usagePage,
		usagePageSize,
		loadingUsage,
		saving,
		hasProvider,
		providerName,
		fetchSettings,
		fetchOverview,
		fetchTopUps,
		fetchPrices,
		fetchUsage,
		fetchAll,
		saveSettings,
		addTopUp,
		setUsageFilters,
	};
});
