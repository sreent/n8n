import { capabilityRegistry } from '@n8n/frontend-module-sdk';
import { createComponentRenderer } from '@n8n/frontend-test-utils';
import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/vue';

import type { CopyRecipient } from '../send-copy.api';
import { sendCopyModalCloser } from '../send-copy.capabilities';
import SendCopyModal from './SendCopyModal.vue';

const showMessage = vi.fn();
const showError = vi.fn();
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage, showError }),
}));

// Run searches at once, so the tests do not wait for the debounce time.
vi.mock('@n8n/composables/useDebounce', () => ({
	useDebounce: () => ({ debounce: <T>(fn: T) => fn }),
}));

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext: { baseUrl: '', pushRef: '' } }),
}));

type ApiMock = (...args: unknown[]) => Promise<unknown>;
const getCopyRecipientsMock = vi.fn<ApiMock>();
const sendWorkflowCopyMock = vi.fn<ApiMock>();
vi.mock('../send-copy.api', () => ({
	getCopyRecipients: async (...args: unknown[]) => await getCopyRecipientsMock(...args),
	sendWorkflowCopy: async (...args: unknown[]) => await sendWorkflowCopyMock(...args),
}));

const bob: CopyRecipient = {
	id: 'bob-id',
	firstName: 'Bob',
	lastName: 'Builder',
	email: 'bob@example.com',
};
const carol: CopyRecipient = {
	id: 'carol-id',
	firstName: null,
	lastName: null,
	email: 'carol@example.com',
};

const closeModal = vi.fn();

const render = () =>
	createComponentRenderer(SendCopyModal, {
		pinia: createTestingPinia(),
		props: {
			modalName: 'sendCopy',
			open: true,
			data: { workflowId: 'wf-1', workflowName: 'Daily report' },
		},
	})();

const selectColleague = async (email: string) => {
	// The dialog renders its content in a portal after the first tick.
	const select = await screen.findByTestId('send-copy-recipient-select');
	await userEvent.click(select.querySelector('input')!);
	await userEvent.click(await screen.findByText(email));
};

describe('SendCopyModal', () => {
	beforeEach(() => {
		capabilityRegistry.provide(sendCopyModalCloser, closeModal);
		getCopyRecipientsMock.mockResolvedValue([bob, carol]);
		sendWorkflowCopyMock.mockResolvedValue({ results: [] });
	});

	afterEach(() => {
		capabilityRegistry.clear();
		vi.clearAllMocks();
	});

	it('shows the workflow name and loads colleagues when it opens', async () => {
		render();

		expect(await screen.findByText('Send a copy of "Daily report"')).toBeInTheDocument();
		await waitFor(() =>
			expect(getCopyRecipientsMock).toHaveBeenCalledWith(expect.anything(), {
				search: undefined,
				limit: 20,
			}),
		);
	});

	it('renders its test id on an element in the dialog', async () => {
		render();

		expect(await screen.findByTestId('send-copy-modal')).toBeInTheDocument();
	});

	it('disables Send until a colleague is selected', async () => {
		render();

		const send = await screen.findByTestId('send-copy-submit');
		expect(send).toBeDisabled();

		await selectColleague('bob@example.com');

		expect(screen.getByTestId('send-copy-recipient-list')).toHaveTextContent('bob@example.com');
		expect(send).toBeEnabled();
	});

	it('removes a selected colleague', async () => {
		render();
		await selectColleague('bob@example.com');

		await userEvent.click(screen.getByTestId('send-copy-remove-bob-id'));

		expect(screen.queryByTestId('send-copy-recipient-list')).not.toBeInTheDocument();
	});

	it('sends a copy to the selected colleagues and closes', async () => {
		sendWorkflowCopyMock.mockResolvedValue({
			results: [
				{ recipientId: 'bob-id', status: 'sent', workflowId: 'copy-1', workflowName: 'Copy' },
			],
		});
		render();
		await selectColleague('bob@example.com');

		await userEvent.click(screen.getByTestId('send-copy-submit'));

		await waitFor(() =>
			expect(sendWorkflowCopyMock).toHaveBeenCalledWith(expect.anything(), 'wf-1', ['bob-id']),
		);
		expect(showMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'success', message: '1 person received a copy' }),
		);
		expect(closeModal).toHaveBeenCalledWith('sendCopy');
	});

	it('shows the reasons as plain text and stays open when no copy was sent', async () => {
		sendWorkflowCopyMock.mockResolvedValue({
			results: [{ recipientId: 'carol-id', status: 'failed', reason: 'not-eligible' }],
		});
		render();
		await selectColleague('carol@example.com');

		await userEvent.click(screen.getByTestId('send-copy-submit'));

		await waitFor(() =>
			expect(showMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					message: 'carol@example.com: the user cannot receive copies',
					dangerouslyUseHTMLString: false,
				}),
			),
		);
		expect(closeModal).not.toHaveBeenCalled();
	});

	it('shows an error when the request fails', async () => {
		const error = new Error('Network error');
		sendWorkflowCopyMock.mockRejectedValue(error);
		render();
		await selectColleague('bob@example.com');

		await userEvent.click(screen.getByTestId('send-copy-submit'));

		await waitFor(() => expect(showError).toHaveBeenCalledWith(error, 'Could not send the copy'));
		expect(closeModal).not.toHaveBeenCalled();
	});

	it('closes with Cancel', async () => {
		render();

		await userEvent.click(await screen.findByTestId('send-copy-cancel'));

		expect(closeModal).toHaveBeenCalledWith('sendCopy');
	});
});
