import type { EventDestination } from '@n8n/rest-api-client/api/eventbus';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createTestingPinia } from '@pinia/testing';
import { fireEvent, screen, waitFor } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { setActivePinia } from 'pinia';
import { defineComponent } from 'vue';

import { renderComponent } from '@/__tests__/render';
import { mockedStore } from '@/__tests__/utils';
import { LOG_STREAM_MODAL_KEY, MODAL_CONFIRM } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';

import EventDestinationSettingsModal from '../components/EventDestinationSettingsModal.vue';
import { useLogStreamingStore } from '../logStreaming.store';

const confirm = vi.fn();

vi.mock('@n8n/design-system', async (importOriginal) => {
	const original = await importOriginal<object>();
	return { ...original, useMessage: () => ({ confirm }) };
});

vi.mock('@n8n/composables/useToast', () => {
	const showError = vi.fn();
	return { useToast: () => ({ showError, showMessage: vi.fn() }) };
});

/** The parameter inputs of the node view are large. The stub shows the parameters and the values. */
const ParameterInputListStub = defineComponent({
	name: 'ParameterInputList',
	props: {
		parameters: { type: Array, required: true },
		nodeValues: { type: Object, required: true },
		path: { type: String, default: '' },
		isReadOnly: { type: Boolean, default: false },
	},
	emits: ['valueChanged'],
	template: `
		<div data-test-id="parameter-list" :data-read-only="isReadOnly">
			<span v-for="parameter in parameters" :key="parameter.name" data-test-id="parameter-name">{{ parameter.name }}</span>
			<pre data-test-id="parameter-values">{{ JSON.stringify(nodeValues) }}</pre>
			<button data-test-id="change-url" @click="$emit('valueChanged', { name: path + '.url', value: 'https://siem.example.com/n8n' })">url</button>
			<button data-test-id="hide-json-headers" @click="$emit('valueChanged', { name: '.jsonHeaders', value: undefined })">hide</button>
		</div>
	`,
});

const ModalStub = defineComponent({
	name: 'ModalStub',
	template: '<div><slot name="header" /><slot name="content" /><slot name="footer" /></div>',
});

const webhook: EventDestination = {
	id: 'destination-1',
	__type: '$$MessageEventBusDestinationWebhook',
	label: 'SIEM',
	enabled: true,
	url: 'https://example.com/events',
	method: 'POST',
	authentication: 'none',
	jsonHeaders: '{"a":"b"}',
	subscribedEvents: ['n8n.workflow'],
	anonymizeAuditMessages: false,
};

function renderModal(props: Record<string, unknown> = {}) {
	return renderComponent(EventDestinationSettingsModal, {
		props: { modalName: LOG_STREAM_MODAL_KEY, ...props },
		global: { stubs: { Modal: ModalStub, ParameterInputList: ParameterInputListStub } },
	});
}

const parameterValues = () =>
	JSON.parse(screen.getByTestId('parameter-values').textContent ?? '{}').parameters;

describe('EventDestinationSettingsModal', () => {
	let logStreamingStore: ReturnType<typeof mockedStore<typeof useLogStreamingStore>>;
	let settingsStore: ReturnType<typeof mockedStore<typeof useSettingsStore>>;
	let credentialsStore: ReturnType<typeof mockedStore<typeof useCredentialsStore>>;
	let uiStore: ReturnType<typeof mockedStore<typeof useUIStore>>;

	beforeEach(() => {
		setActivePinia(createTestingPinia());
		logStreamingStore = mockedStore(useLogStreamingStore);
		settingsStore = mockedStore(useSettingsStore);
		credentialsStore = mockedStore(useCredentialsStore);
		uiStore = mockedStore(useUIStore);
		settingsStore.settings.logStreaming = { managedByEnv: false };
		logStreamingStore.eventNames = [
			'n8n.audit.user.deleted',
			'n8n.workflow.started',
			'n8n.workflow.success',
		];
		logStreamingStore.saveDestination.mockImplementation(async (destination) => ({
			...destination,
			id: destination.id ?? 'new-id',
		}));
		credentialsStore.fetchAllCredentials.mockResolvedValue([]);
		confirm.mockReset();
	});

	describe('a new destination', () => {
		it('asks for the type first, then shows the settings of the type', async () => {
			renderModal({ isNew: true });

			expect(screen.getByTestId('select-destination-button')).toBeDisabled();
			await userEvent.click(screen.getByTestId('select-destination-type'));
			await userEvent.click(await screen.findByText('Syslog'));
			expect(screen.getByTestId('select-destination-button')).toBeEnabled();
			await userEvent.click(screen.getByTestId('select-destination-button'));

			expect(screen.getByTestId('subtitle-showing-type')).toHaveTextContent('Syslog');
			expect(screen.getAllByTestId('parameter-name').map((name) => name.textContent)).toEqual([
				'host',
				'port',
				'protocol',
				'tlsCa',
				'facility',
				'app_name',
			]);
			expect(parameterValues()).toMatchObject({
				__type: '$$MessageEventBusDestinationSyslog',
				label: 'Syslog',
				enabled: false,
				port: 514,
			});
		});

		it('stores the destination, then offers the test event', async () => {
			renderModal({ isNew: true });
			await userEvent.click(screen.getByTestId('select-destination-type'));
			await userEvent.click(await screen.findByText('Webhook'));
			await userEvent.click(screen.getByTestId('select-destination-button'));
			expect(screen.queryByTestId('destination-test-button')).not.toBeInTheDocument();

			await fireEvent.click(screen.getByTestId('change-url'));
			await userEvent.click(
				screen.getByTestId('destination-save-button').querySelector('button') as HTMLElement,
			);

			expect(logStreamingStore.saveDestination).toHaveBeenCalledWith(
				expect.objectContaining({
					__type: '$$MessageEventBusDestinationWebhook',
					url: 'https://siem.example.com/n8n',
					enabled: false,
					id: undefined,
				}),
			);
			await waitFor(() =>
				expect(screen.queryByTestId('destination-save-button')).not.toBeInTheDocument(),
			);
			expect(screen.getByTestId('destination-test-button')).toBeInTheDocument();
		});
	});

	describe('a stored destination', () => {
		it('shows no save button until a change', async () => {
			renderModal({ destination: webhook });

			expect(screen.queryByTestId('destination-save-button')).not.toBeInTheDocument();
			await fireEvent.click(screen.getByTestId('hide-json-headers'));

			expect(screen.getByTestId('destination-save-button')).toBeInTheDocument();
			expect(parameterValues()).not.toHaveProperty('jsonHeaders');
		});

		it('tells the result of the test event in the title of the test button', async () => {
			logStreamingStore.sendTestEvent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
			renderModal({ destination: webhook });
			const button = screen.getByTestId('destination-test-button');

			await userEvent.click(button);
			await waitFor(() => expect(button).toHaveAttribute('title', 'Event sent and returned OK'));
			expect(logStreamingStore.sendTestEvent).toHaveBeenCalledWith('destination-1');

			await userEvent.click(button);
			await waitFor(() =>
				expect(button).toHaveAttribute('title', "The destination didn't accept the test event"),
			);
		});

		it('deletes the destination after the confirmation, and closes', async () => {
			confirm.mockResolvedValueOnce('cancel').mockResolvedValueOnce(MODAL_CONFIRM);
			renderModal({ destination: webhook });

			await userEvent.click(screen.getByTestId('destination-delete-button'));
			expect(logStreamingStore.deleteDestination).not.toHaveBeenCalled();
			await userEvent.click(screen.getByTestId('destination-delete-button'));

			await waitFor(() =>
				expect(logStreamingStore.deleteDestination).toHaveBeenCalledWith('destination-1'),
			);
			expect(uiStore.closeModal).toHaveBeenCalledWith(LOG_STREAM_MODAL_KEY);
		});

		it('subscribes to a group in the events tab', async () => {
			renderModal({ destination: webhook });

			await userEvent.click(screen.getByText('Events'));
			const [auditGroup] = screen.getAllByTestId('destination-event-group-checkbox');
			await userEvent.click(auditGroup);
			await userEvent.click(
				screen.getByTestId('destination-save-button').querySelector('button') as HTMLElement,
			);

			expect(logStreamingStore.saveDestination).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'destination-1',
					subscribedEvents: ['n8n.workflow', 'n8n.audit'],
				}),
			);
		});

		it('shows the single events of a group on request, and subscribes to one event', async () => {
			renderModal({ destination: webhook });
			await userEvent.click(screen.getByText('Events'));
			expect(screen.queryAllByTestId('destination-event-checkbox')).toHaveLength(0);

			const [auditToggle] = screen.getAllByTestId('destination-event-group-toggle');
			expect(auditToggle).toHaveTextContent('Show 1 event');
			await userEvent.click(auditToggle);
			await userEvent.click(screen.getByText('n8n.audit.user.deleted'));
			await userEvent.click(
				screen.getByTestId('destination-save-button').querySelector('button') as HTMLElement,
			);

			expect(logStreamingStore.saveDestination).toHaveBeenCalledWith(
				expect.objectContaining({
					subscribedEvents: ['n8n.workflow', 'n8n.audit.user.deleted'],
				}),
			);
		});

		it('selects the credential of a generic auth type', async () => {
			credentialsStore.getCredentialsByType = vi.fn(() => [
				{ id: 'credential-1', name: 'SIEM token', type: 'httpHeaderAuth' },
			]) as never;
			renderModal({
				destination: {
					...webhook,
					authentication: 'genericCredentialType',
					genericAuthType: 'httpHeaderAuth',
				},
			});

			await userEvent.click(screen.getByTestId('destination-credential-select'));
			await userEvent.click(await screen.findByText('SIEM token'));

			expect(parameterValues()).toMatchObject({
				credentials: { httpHeaderAuth: { id: 'credential-1', name: 'SIEM token' } },
			});
		});

		it('is read-only while the environment manages the destinations', () => {
			settingsStore.settings.logStreaming = { managedByEnv: true };

			renderModal({ destination: webhook });

			expect(screen.getByTestId('parameter-list')).toHaveAttribute('data-read-only', 'true');
			expect(screen.queryByTestId('destination-delete-button')).not.toBeInTheDocument();
			expect(screen.getByTestId('destination-test-button')).toBeInTheDocument();
		});
	});
});
