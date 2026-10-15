import { useSettingsStore } from '@n8n/stores/settings.store';
import { createPinia, setActivePinia } from 'pinia';

import { overview, priceTable, settingsResponse, topUps, usagePage } from './__tests__/fixtures';
import { useAiGatewayAdminStore } from './ai-gateway-admin.store';

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext: { baseUrl: '/rest', pushRef: '' } }),
}));

type ApiMock = (...args: unknown[]) => Promise<unknown>;
const api = {
	getAiGatewaySettings: vi.fn<ApiMock>(),
	updateAiGatewaySettings: vi.fn<ApiMock>(),
	getAiGatewayOverview: vi.fn<ApiMock>(),
	getAiGatewayTopUps: vi.fn<ApiMock>(),
	addAiGatewayTopUp: vi.fn<ApiMock>(),
	getAiGatewayPrices: vi.fn<ApiMock>(),
	getAiGatewayUsage: vi.fn<ApiMock>(),
};
vi.mock('./ai-gateway.api', () => ({
	getAiGatewaySettings: async (...args: unknown[]) => await api.getAiGatewaySettings(...args),
	updateAiGatewaySettings: async (...args: unknown[]) => await api.updateAiGatewaySettings(...args),
	getAiGatewayOverview: async (...args: unknown[]) => await api.getAiGatewayOverview(...args),
	getAiGatewayTopUps: async (...args: unknown[]) => await api.getAiGatewayTopUps(...args),
	addAiGatewayTopUp: async (...args: unknown[]) => await api.addAiGatewayTopUp(...args),
	getAiGatewayPrices: async (...args: unknown[]) => await api.getAiGatewayPrices(...args),
	getAiGatewayUsage: async (...args: unknown[]) => await api.getAiGatewayUsage(...args),
}));

const context = { baseUrl: '/rest', pushRef: '' };

/** A promise that the test resolves later. */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

describe('useAiGatewayAdminStore', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		api.getAiGatewaySettings.mockResolvedValue(settingsResponse());
		api.updateAiGatewaySettings.mockResolvedValue(settingsResponse());
		api.getAiGatewayOverview.mockResolvedValue(overview());
		api.getAiGatewayTopUps.mockResolvedValue(topUps());
		api.addAiGatewayTopUp.mockResolvedValue(overview());
		api.getAiGatewayPrices.mockResolvedValue(priceTable());
		api.getAiGatewayUsage.mockResolvedValue(usagePage());
	});

	it('loads the settings, the overview, the top-ups and the prices', async () => {
		const store = useAiGatewayAdminStore();
		await store.fetchAll();

		expect(store.settings?.monthlyBudget).toBe(100);
		expect(store.providers).toHaveLength(4);
		expect(store.projects).toEqual([
			{ id: 'project-a', name: 'Team A' },
			{ id: 'project-b', name: 'Team B' },
		]);
		expect(store.baseUrl).toBe('http://127.0.0.1:5678/ai-gateway');
		expect(store.hasProvider).toBe(true);
		expect(store.providerName('google')).toBe('Google Gemini');
		expect(store.providerName('unknown')).toBe('unknown');
		expect(store.overview?.remaining).toBe(112.6544);
		expect(store.topUps).toHaveLength(1);
		expect(store.priceTable?.listPricesDate).toBe('2026-10-15');
	});

	it('saves the full settings with a change, and reads the editor settings when the gateway changes', async () => {
		const store = useAiGatewayAdminStore();
		await store.fetchAll();
		const getSettings = vi.spyOn(useSettingsStore(), 'getSettings').mockResolvedValue();

		await store.saveSettings({ monthlyBudget: 250 });
		expect(api.updateAiGatewaySettings).toHaveBeenLastCalledWith(context, {
			...settingsResponse().settings,
			monthlyBudget: 250,
		});
		expect(getSettings).not.toHaveBeenCalled();

		await store.saveSettings({ enabled: false });
		expect(getSettings).toHaveBeenCalledTimes(1);
		expect(api.getAiGatewayOverview).toHaveBeenCalledTimes(3);
	});

	it('adds a top-up without an empty note, and reads the top-ups again', async () => {
		const store = useAiGatewayAdminStore();
		await store.addTopUp(10, '  ');
		expect(api.addAiGatewayTopUp).toHaveBeenCalledWith(context, { amount: 10 });
		await store.addTopUp(5, ' Q4 ');
		expect(api.addAiGatewayTopUp).toHaveBeenLastCalledWith(context, { amount: 5, note: 'Q4' });
		expect(api.getAiGatewayTopUps).toHaveBeenCalledTimes(2);
		expect(store.overview?.topUpBalance).toBe(25);
	});

	it('reads a page of calls with the filters, and keeps only the newest answer', async () => {
		const store = useAiGatewayAdminStore();
		store.setUsageFilters({ provider: 'openai' });
		store.usagePage = 2;
		store.usagePageSize = 25;

		const slow = deferred<unknown>();
		api.getAiGatewayUsage.mockReturnValueOnce(slow.promise);
		const first = store.fetchUsage();
		const second = store.fetchUsage();
		await second;
		slow.resolve({ count: 99, entries: [] });
		await first;

		expect(api.getAiGatewayUsage).toHaveBeenLastCalledWith(context, { provider: 'openai' }, 50, 25);
		expect(store.usageCount).toBe(1);
		expect(store.usage[0].model).toBe('gpt-4o');
		expect(store.loadingUsage).toBe(false);
	});

	it('goes back to the first page when the filters change', () => {
		const store = useAiGatewayAdminStore();
		store.usagePage = 3;
		store.setUsageFilters({ model: 'gpt-4o' });
		expect(store.usagePage).toBe(0);
		expect(store.usageFilters).toEqual({ model: 'gpt-4o' });
	});
});
