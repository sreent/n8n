import type { OpenTriggerItem } from '@n8n/api-types';
import { createComponentRenderer } from '@n8n/frontend-test-utils';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createTestingPinia } from '@pinia/testing';
import { screen, within } from '@testing-library/vue';

import SettingsOpenTriggersView from './SettingsOpenTriggersView.vue';

const showError = vi.fn();
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage: vi.fn(), showError }),
}));

const restApiContext = { baseUrl: '', pushRef: '' };
vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext }),
}));

const getOpenTriggersMock = vi.fn<(...args: unknown[]) => Promise<OpenTriggerItem[]>>();
vi.mock('../open-triggers.api', () => ({
	getOpenTriggers: async (...args: unknown[]) => await getOpenTriggersMock(...args),
}));

const item = (overrides: Partial<OpenTriggerItem>): OpenTriggerItem => ({
	workflowId: 'wf-1',
	workflowName: 'Shop',
	homeProject: { id: 'p1', name: 'Sales', type: 'team' },
	owner: null,
	nodeId: 'n1',
	nodeName: 'Orders',
	nodeType: 'n8n-nodes-base.webhook',
	typeVersion: 2,
	kind: 'webhook',
	path: 'orders',
	approved: false,
	...overrides,
});

const render = (needApproval?: boolean) => {
	const pinia = createTestingPinia({ stubActions: false });
	if (needApproval !== undefined) {
		useSettingsStore().$patch({ moduleSettings: { 'open-triggers': { needApproval } } });
	}
	return createComponentRenderer(SettingsOpenTriggersView, { pinia })();
};

beforeEach(() => {
	vi.clearAllMocks();
	getOpenTriggersMock.mockResolvedValue([
		item({}),
		item({
			workflowId: 'wf-2',
			workflowName: 'Feedback',
			homeProject: { id: 'p2', name: 'Ann Lee <ann@example.com>', type: 'personal' },
			owner: { id: 'u1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' },
			nodeId: 'n2',
			nodeName: 'Survey',
			kind: 'form',
			path: null,
			approved: true,
		}),
	]);
});

describe('SettingsOpenTriggersView', () => {
	it('lists the open triggers with their project, kind, path and approval', async () => {
		render(true);

		const table = await screen.findByTestId('open-triggers-table');
		await within(table).findByText('Orders');
		expect(getOpenTriggersMock).toHaveBeenCalledWith(restApiContext);
		expect(table).toHaveTextContent('Shop');
		expect(table).toHaveTextContent('Sales');
		expect(table).toHaveTextContent('Webhook');
		expect(table).toHaveTextContent('orders');
		expect(table).toHaveTextContent('Personal space of ann@example.com');
		expect(table).toHaveTextContent('Form');
		expect(screen.getByTestId('open-trigger-approval-n1')).toHaveTextContent('Not approved');
		expect(screen.getByTestId('open-trigger-approval-n2')).toHaveTextContent('Approved');
		expect(screen.getByTestId('open-triggers-summary')).toHaveTextContent(
			'2 open triggers, 1 without an approval',
		);
	});

	it('tells whether the publish check is on', async () => {
		render(true);

		expect(await screen.findByTestId('open-triggers-check-state')).toHaveTextContent(
			'A new open trigger needs authentication or an approval',
		);
	});

	it('tells how to turn the publish check on', async () => {
		render();

		expect(await screen.findByTestId('open-triggers-check-state')).toHaveTextContent(
			'N8N_OPEN_TRIGGERS_NEED_APPROVAL=true',
		);
	});

	it('shows an empty state without open triggers', async () => {
		getOpenTriggersMock.mockResolvedValue([]);
		render(true);

		expect(await screen.findByTestId('open-triggers-empty')).toHaveTextContent('No open triggers');
	});

	it('shows an error when the list does not load', async () => {
		const error = new Error('Forbidden');
		getOpenTriggersMock.mockRejectedValue(error);
		render(true);

		await vi.waitFor(() =>
			expect(showError).toHaveBeenCalledWith(error, 'Could not load the open triggers'),
		);
	});
});
