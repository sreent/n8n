import type { EventDestination } from '@n8n/rest-api-client/api/eventbus';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createTestingPinia } from '@pinia/testing';
import { fireEvent, screen, waitFor } from '@testing-library/vue';
import { setActivePinia } from 'pinia';

import { createMockEnterpriseSettings } from '@/__tests__/mocks';
import { renderComponent } from '@/__tests__/render';
import { mockedStore } from '@/__tests__/utils';
import { useUIStore } from '@/app/stores/ui.store';

import { LOG_STREAM_MODAL_KEY } from '../logStreaming.constants';
import { useLogStreamingStore } from '../logStreaming.store';
import SettingsLogStreamingView from '../views/SettingsLogStreamingView.vue';

vi.mock('@n8n/composables/useToast', () => {
	const showError = vi.fn();
	return { useToast: () => ({ showError, showMessage: vi.fn() }) };
});

const destination: EventDestination = {
	id: 'destination-1',
	__type: '$$MessageEventBusDestinationWebhook',
	label: 'SIEM',
	enabled: true,
	url: 'https://example.com/events',
};

describe('SettingsLogStreamingView', () => {
	let settingsStore: ReturnType<typeof mockedStore<typeof useSettingsStore>>;
	let logStreamingStore: ReturnType<typeof mockedStore<typeof useLogStreamingStore>>;
	let uiStore: ReturnType<typeof mockedStore<typeof useUIStore>>;

	beforeEach(() => {
		setActivePinia(createTestingPinia());
		settingsStore = mockedStore(useSettingsStore);
		logStreamingStore = mockedStore(useLogStreamingStore);
		uiStore = mockedStore(useUIStore);
		settingsStore.isModuleActive.mockReturnValue(true);
		settingsStore.settings.logStreaming = { managedByEnv: false };
		logStreamingStore.destinations = [];
	});

	it('tells how to turn the module on while it is off', () => {
		settingsStore.isModuleActive.mockReturnValue(false);
		settingsStore.isEnterpriseFeatureEnabled = createMockEnterpriseSettings({ logStreaming: true });

		renderComponent(SettingsLogStreamingView);

		const box = screen.getByTestId('action-box-unlicensed');
		expect(box).toHaveTextContent('Log streaming is off');
		expect(box).toHaveTextContent('N8N_DISABLED_MODULES');
		expect(logStreamingStore.fetchDestinations).not.toHaveBeenCalled();
	});

	it('tells how to turn on the fork features while the fork switch is off', () => {
		settingsStore.isModuleActive.mockReturnValue(false);
		settingsStore.isEnterpriseFeatureEnabled = createMockEnterpriseSettings({
			logStreaming: false,
		});

		renderComponent(SettingsLogStreamingView);

		const box = screen.getByTestId('action-box-unlicensed');
		expect(box).toHaveTextContent('Log streaming is off');
		expect(box).toHaveTextContent('N8N_FORK_FEATURES_ENABLED');
		expect(box).not.toHaveTextContent('N8N_DISABLED_MODULES');
	});

	it('loads the destinations and the event names, and opens a new destination', async () => {
		renderComponent(SettingsLogStreamingView);

		expect(logStreamingStore.fetchDestinations).toHaveBeenCalled();
		expect(logStreamingStore.fetchEventNames).toHaveBeenCalled();
		const box = screen.getByTestId('action-box-licensed');
		await fireEvent.click(box.querySelector('button') as HTMLButtonElement);

		expect(uiStore.openModalWithData).toHaveBeenCalledWith({
			name: LOG_STREAM_MODAL_KEY,
			data: { destination: undefined, isNew: true },
		});
	});

	it('shows a card for each destination, and opens a destination', async () => {
		logStreamingStore.destinations = [destination];

		renderComponent(SettingsLogStreamingView);

		const card = await screen.findByTestId('destination-card');
		expect(card).toHaveTextContent('SIEM');
		expect(card).toHaveTextContent('Webhook');
		await fireEvent.click(card);
		expect(uiStore.openModalWithData).toHaveBeenCalledWith({
			name: LOG_STREAM_MODAL_KEY,
			data: { destination, isNew: false },
		});
		expect(screen.getByRole('button', { name: 'Add new destination' })).toBeInTheDocument();
	});

	it('turns a destination off with the switch of its card', async () => {
		logStreamingStore.destinations = [destination];
		renderComponent(SettingsLogStreamingView);

		await fireEvent.click(await screen.findByTestId('workflow-activate-switch'));

		await waitFor(() =>
			expect(logStreamingStore.saveDestination).toHaveBeenCalledWith({
				...destination,
				enabled: false,
			}),
		);
		expect(uiStore.openModalWithData).not.toHaveBeenCalled();
	});

	it('is read-only while the environment manages the destinations', async () => {
		settingsStore.settings.logStreaming = { managedByEnv: true };
		logStreamingStore.destinations = [destination];

		renderComponent(SettingsLogStreamingView);

		expect(await screen.findByTestId('log-streaming-managed-by-env')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Add new destination' })).not.toBeInTheDocument();
		expect(screen.getByTestId('workflow-activate-switch')).toBeDisabled();
	});
});
