import { capabilityRegistry } from '@n8n/frontend-module-sdk';
import { createComponentRenderer } from '@n8n/frontend-test-utils';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/vue';
import type { INode } from 'n8n-workflow';

import { openTriggerActions, type OpenTriggerActions } from '../open-triggers.capabilities';
import OpenTriggerTestUrlNotice from './OpenTriggerTestUrlNotice.vue';

const showMessage = vi.fn();
const showError = vi.fn();
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage, showError }),
}));

const copy = vi.fn();
vi.mock('@n8n/composables/useClipboard', () => ({
	useClipboard: () => ({ copy }),
}));

const actions = {
	applyFix: vi.fn<OpenTriggerActions['applyFix']>(),
	publish: vi.fn<OpenTriggerActions['publish']>(),
	requestApproval: vi.fn<OpenTriggerActions['requestApproval']>(),
	showNode: vi.fn<OpenTriggerActions['showNode']>(),
};

type TestNode = Pick<INode, 'id' | 'type' | 'typeVersion' | 'parameters'>;

const webhook: TestNode = {
	id: 'n1',
	type: 'n8n-nodes-base.webhook',
	typeVersion: 2,
	parameters: { path: 'orders' },
};

const render = (
	node: TestNode,
	settings: { needApproval: boolean; publicChatDisabled?: boolean } = { needApproval: true },
) => {
	const pinia = createTestingPinia();
	useSettingsStore().$patch({
		moduleSettings: { 'open-triggers': { publicChatDisabled: false, ...settings } },
	});
	return createComponentRenderer(OpenTriggerTestUrlNotice, {
		pinia,
		props: { workflowId: 'wf-1', node },
	})();
};

describe('OpenTriggerTestUrlNotice', () => {
	beforeEach(() => {
		capabilityRegistry.provide(openTriggerActions, actions);
		actions.applyFix.mockResolvedValue({
			secret: { header: 'Authorization', value: 'Bearer token-1' },
		});
	});

	afterEach(() => {
		capabilityRegistry.clear();
		vi.clearAllMocks();
	});

	it('tells that the test URL of an open trigger refuses outside calls, with its fix', () => {
		render(webhook);

		expect(screen.getByTestId('open-trigger-test-url-refused')).toHaveTextContent(
			'Calls from other tools get the status 403',
		);
		expect(screen.getByTestId('open-trigger-test-url-apply-fix')).toHaveTextContent(
			'Add header authentication',
		);
	});

	it.each<[string, TestNode]>([
		[
			'a webhook with authentication',
			{ ...webhook, parameters: { path: 'orders', authentication: 'headerAuth' } },
		],
		[
			'a chat that is not public',
			{
				id: 'n2',
				type: '@n8n/n8n-nodes-langchain.chatTrigger',
				typeVersion: 1.1,
				parameters: { public: false },
			},
		],
		[
			'a node that is not a trigger',
			{ id: 'n3', type: 'n8n-nodes-base.set', typeVersion: 3, parameters: {} },
		],
	])('shows nothing for %s', (_label, node) => {
		render(node);

		expect(screen.queryByTestId('open-trigger-test-url-notice')).not.toBeInTheDocument();
	});

	it('shows nothing while the publish check is off', () => {
		render(webhook, { needApproval: false });

		expect(screen.queryByTestId('open-trigger-test-url-notice')).not.toBeInTheDocument();
	});

	it('uses the instance setting of public chats, as the check does', () => {
		const publicChat: TestNode = {
			id: 'n2',
			type: '@n8n/n8n-nodes-langchain.chatTrigger',
			typeVersion: 1.1,
			parameters: { public: true },
		};

		render(publicChat, { needApproval: true, publicChatDisabled: true });

		expect(screen.queryByTestId('open-trigger-test-url-notice')).not.toBeInTheDocument();
	});

	it('applies the fix, shows the token once and tells the builder to listen again', async () => {
		render(webhook);

		await userEvent.click(screen.getByTestId('open-trigger-test-url-apply-fix'));

		expect(actions.applyFix).toHaveBeenCalledWith('wf-1', 'n1', 'headerAuth');
		expect(await screen.findByTestId('open-trigger-test-url-fixed')).toHaveTextContent(
			'listen again',
		);
		expect(screen.getByTestId('open-trigger-secret')).toHaveTextContent(
			'Authorization: Bearer token-1',
		);

		await userEvent.click(screen.getByTestId('open-trigger-copy-secret'));
		expect(copy).toHaveBeenCalledWith('Bearer token-1');
	});

	it('tells the builder what to do for a node without a fix', () => {
		render({
			id: 'n4',
			type: 'n8n-nodes-base.formTrigger',
			typeVersion: 2.2,
			parameters: {},
		});

		expect(screen.queryByTestId('open-trigger-test-url-apply-fix')).not.toBeInTheDocument();
		expect(screen.getByTestId('open-trigger-no-fix')).toBeInTheDocument();
	});

	it('shows an error when the fix fails', async () => {
		const error = new Error('No access to the project');
		actions.applyFix.mockRejectedValue(error);
		render(webhook);

		await userEvent.click(screen.getByTestId('open-trigger-test-url-apply-fix'));

		await waitFor(() =>
			expect(showError).toHaveBeenCalledWith(error, "Couldn't add the authentication"),
		);
		expect(screen.getByTestId('open-trigger-test-url-refused')).toBeInTheDocument();
	});
});
