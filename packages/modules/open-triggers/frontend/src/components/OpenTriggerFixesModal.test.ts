import { capabilityRegistry } from '@n8n/frontend-module-sdk';
import { createComponentRenderer } from '@n8n/frontend-test-utils';
import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/vue';

import {
	openTriggerActions,
	openTriggersModalCloser,
	type OpenTriggerActions,
} from '../open-triggers.capabilities';
import type { OpenTriggerFixesModalData } from '../open-triggers.fixes';
import OpenTriggerFixesModal from './OpenTriggerFixesModal.vue';

const showMessage = vi.fn();
const showError = vi.fn();
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage, showError }),
}));

const copy = vi.fn();
vi.mock('@n8n/composables/useClipboard', () => ({
	useClipboard: () => ({ copy }),
}));

const closeModal = vi.fn();
const actions = {
	applyFix: vi.fn<OpenTriggerActions['applyFix']>(),
	publish: vi.fn<OpenTriggerActions['publish']>(),
	requestApproval: vi.fn<OpenTriggerActions['requestApproval']>(),
	showNode: vi.fn<OpenTriggerActions['showNode']>(),
};

const webhook = {
	nodeId: 'n1',
	nodeName: 'Orders',
	message: 'The webhook "Orders" accepts calls without authentication.',
	fix: 'headerAuth' as const,
};
const oldForm = {
	nodeId: 'n2',
	nodeName: 'Survey',
	message: 'The form "Survey" is open without sign-in.',
	fix: null,
};

const render = (data: Partial<OpenTriggerFixesModalData> = {}) =>
	createComponentRenderer(OpenTriggerFixesModal, {
		pinia: createTestingPinia(),
		props: {
			modalName: 'openTriggerFixes',
			open: true,
			data: {
				workflowId: 'wf-1',
				items: [webhook],
				otherMessages: [],
				canRequestApproval: true,
				...data,
			},
		},
	})();

describe('OpenTriggerFixesModal', () => {
	beforeEach(() => {
		capabilityRegistry.provide(openTriggersModalCloser, closeModal);
		capabilityRegistry.provide(openTriggerActions, actions);
		actions.applyFix.mockResolvedValue({
			secret: { header: 'Authorization', value: 'Bearer token-1' },
		});
	});

	afterEach(() => {
		capabilityRegistry.clear();
		vi.clearAllMocks();
	});

	it('lists each open trigger with its message and its fix', async () => {
		render({ items: [webhook, oldForm] });

		const items = await screen.findAllByTestId('open-trigger-fix-item');
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent('Orders');
		expect(items[0]).toHaveTextContent(webhook.message);
		expect(items[0]).toHaveTextContent('Add header authentication');
		expect(items[1]).toHaveTextContent('This version of the node has no n8n sign-in');
		expect(screen.getByTestId('open-trigger-publish')).toBeDisabled();
	});

	it('applies a fix, shows the token once and lets the user publish', async () => {
		render();

		await userEvent.click(await screen.findByTestId('open-trigger-apply-fix'));

		expect(actions.applyFix).toHaveBeenCalledWith('wf-1', 'n1', 'headerAuth');
		expect(await screen.findByTestId('open-trigger-secret')).toHaveTextContent(
			'Authorization: Bearer token-1',
		);
		expect(screen.getByTestId('open-trigger-fixed')).toBeInTheDocument();

		await userEvent.click(screen.getByTestId('open-trigger-copy-secret'));
		expect(copy).toHaveBeenCalledWith('Bearer token-1');

		const publish = screen.getByTestId('open-trigger-publish');
		await waitFor(() => expect(publish).toBeEnabled());
		await userEvent.click(publish);
		expect(closeModal).toHaveBeenCalledWith('openTriggerFixes');
		expect(actions.publish).toHaveBeenCalledWith('wf-1');
	});

	it('shows no token for a fix without a credential', async () => {
		actions.applyFix.mockResolvedValue({});
		render({ items: [{ ...webhook, fix: 'signIn' }] });

		await userEvent.click(await screen.findByTestId('open-trigger-apply-fix'));

		expect(await screen.findByTestId('open-trigger-fixed')).toBeInTheDocument();
		expect(screen.queryByTestId('open-trigger-secret')).not.toBeInTheDocument();
	});

	it('shows an error when a fix fails', async () => {
		const error = new Error('No access to the project');
		actions.applyFix.mockRejectedValue(error);
		render();

		await userEvent.click(await screen.findByTestId('open-trigger-apply-fix'));

		await waitFor(() =>
			expect(showError).toHaveBeenCalledWith(error, 'Could not add the authentication'),
		);
		expect(screen.queryByTestId('open-trigger-fixed')).not.toBeInTheDocument();
	});

	it('requests an approval while workflow reviews are on', async () => {
		render();

		await userEvent.click(await screen.findByTestId('open-trigger-request-approval'));

		expect(closeModal).toHaveBeenCalledWith('openTriggerFixes');
		expect(actions.requestApproval).toHaveBeenCalledWith('wf-1');
	});

	it('offers no approval while workflow reviews are off', async () => {
		render({ canRequestApproval: false });

		await screen.findAllByTestId('open-trigger-fix-item');
		expect(screen.queryByTestId('open-trigger-request-approval')).not.toBeInTheDocument();
	});

	it('shows the node on the canvas', async () => {
		render();

		await userEvent.click(await screen.findByTestId('open-trigger-show-node'));

		expect(actions.showNode).toHaveBeenCalledWith('wf-1', 'n1');
		expect(closeModal).toHaveBeenCalledWith('openTriggerFixes');
	});

	it('lists the other violations, and keeps the publish off', async () => {
		render({ otherMessages: ['Node type "Slack" is blocked by an instance policy'] });
		actions.applyFix.mockResolvedValue({});

		await userEvent.click(await screen.findByTestId('open-trigger-apply-fix'));

		expect(screen.getByTestId('open-trigger-other-violations')).toHaveTextContent(
			'Node type "Slack" is blocked by an instance policy',
		);
		expect(screen.getByTestId('open-trigger-publish')).toBeDisabled();
	});
});
