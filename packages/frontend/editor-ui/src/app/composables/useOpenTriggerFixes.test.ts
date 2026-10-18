// Fork test (not in upstream n8n): the one-click fixes of the publish check of open triggers.
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import type { PolicyViolation } from '@n8n/api-types';
import { OPEN_TRIGGER_FIXES_MODAL_KEY } from '@n8n/frontend-module-open-triggers';
import { useSettingsStore } from '@n8n/stores/settings.store';

import { createTestNode, createTestWorkflow } from '@/__tests__/mocks';
import { mockedStore } from '@/__tests__/utils';
import { EnterpriseEditionFeature, VIEWS, WORKFLOW_PUBLISH_MODAL_KEY } from '@/app/constants';
import { nodeViewEventBus } from '@/app/event-bus';
import { useUIStore } from '@/app/stores/ui.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import type { ICredentialsResponse } from '@/features/credentials/credentials.types';
import { canvasEventBus } from '@/features/workflows/canvas/canvas.eventBus';

import { useOpenTriggerFixes } from './useOpenTriggerFixes';

const violation = (subject: string, kind = 'open-trigger'): PolicyViolation => ({
	kind,
	checkId: kind === 'open-trigger' ? 'open-triggers' : 'node-type-availability',
	message: `Message of ${subject}`,
	subject,
	subjectType: kind === 'open-trigger' ? 'node' : 'nodeType',
});

const documentStore = () => useWorkflowDocumentStore(createWorkflowDocumentId('w1'));
const nodeOf = (id: string) => documentStore().getNodeById(id);

function openWorkflow() {
	const workflow = createTestWorkflow({
		id: 'w1',
		name: 'Shop',
		homeProject: {
			id: 'p1',
			name: 'Sales',
			type: 'team',
			icon: null,
			createdAt: '',
			updatedAt: '',
		},
		nodes: [
			createTestNode({
				id: 'hook',
				name: 'Orders',
				type: 'n8n-nodes-base.webhook',
				typeVersion: 2,
				parameters: { path: 'orders' },
			}),
			createTestNode({
				id: 'form',
				name: 'Survey',
				type: 'n8n-nodes-base.formTrigger',
				typeVersion: 2.6,
				parameters: {},
			}),
			createTestNode({
				id: 'mcp',
				name: 'Tools',
				type: '@n8n/n8n-nodes-langchain.mcpTrigger',
				typeVersion: 2,
				parameters: {},
			}),
		],
	});
	useWorkflowsStore().setWorkflowId(workflow.id);
	documentStore().hydrate(workflow);
}

function enableReviews(enabled: boolean) {
	const settingsStore = useSettingsStore();
	settingsStore.$patch({ settings: { workflowReviews: { enabled } } });
	settingsStore.settings.enterprise = {
		...settingsStore.settings.enterprise,
		[EnterpriseEditionFeature.WorkflowReviews]: enabled,
	};
}

describe('useOpenTriggerFixes', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ stubActions: false }));
		useUIStore().currentView = VIEWS.WORKFLOW;
		openWorkflow();
	});

	describe('showFixes', () => {
		it('opens the modal with the open triggers and closes the publish modal', () => {
			enableReviews(true);
			const uiStore = useUIStore();
			uiStore.openModal(WORKFLOW_PUBLISH_MODAL_KEY);

			const shown = useOpenTriggerFixes().showFixes('w1', [
				violation('hook'),
				violation('form'),
				violation('n8n-nodes-base.slack', 'node-type-unavailable'),
			]);

			expect(shown).toBe(true);
			expect(uiStore.isModalActiveById[WORKFLOW_PUBLISH_MODAL_KEY]).toBe(false);
			expect(uiStore.isModalActiveById[OPEN_TRIGGER_FIXES_MODAL_KEY]).toBe(true);
			expect(uiStore.modalsById[OPEN_TRIGGER_FIXES_MODAL_KEY].data).toEqual({
				workflowId: 'w1',
				items: [
					{ nodeId: 'hook', nodeName: 'Orders', message: 'Message of hook', fix: 'headerAuth' },
					{ nodeId: 'form', nodeName: 'Survey', message: 'Message of form', fix: 'signIn' },
				],
				otherMessages: ['Message of n8n-nodes-base.slack'],
				canRequestApproval: true,
			});
		});

		it('offers no approval while workflow reviews are off', () => {
			enableReviews(false);

			useOpenTriggerFixes().showFixes('w1', [violation('hook')]);

			expect(useUIStore().modalsById[OPEN_TRIGGER_FIXES_MODAL_KEY].data).toMatchObject({
				canRequestApproval: false,
			});
		});

		it('leaves other violations to the toast', () => {
			const shown = useOpenTriggerFixes().showFixes('w1', [
				violation('n8n-nodes-base.slack', 'node-type-unavailable'),
			]);

			expect(shown).toBe(false);
			expect(useUIStore().isModalActiveById[OPEN_TRIGGER_FIXES_MODAL_KEY]).toBeFalsy();
		});

		it('leaves a workflow that is not on the canvas to the toast', () => {
			expect(useOpenTriggerFixes().showFixes('other', [violation('hook')])).toBe(false);
		});
	});

	describe('applyFix', () => {
		it('turns on the n8n sign-in of a form', async () => {
			const result = await useOpenTriggerFixes().applyFix('w1', 'form', 'signIn');

			expect(result).toEqual({});
			expect(nodeOf('form')?.parameters.authentication).toBe('n8nUserAuth');
			expect(useUIStore().stateIsDirty).toBe(true);
		});

		it('creates a header credential with a token for a webhook', async () => {
			const credentialsStore = mockedStore(useCredentialsStore);
			credentialsStore.createNewCredential.mockResolvedValue({
				id: 'cred-1',
				name: 'Token of Orders in Shop',
			} as ICredentialsResponse);

			const result = await useOpenTriggerFixes().applyFix('w1', 'hook', 'headerAuth');

			const [payload, projectId] = credentialsStore.createNewCredential.mock.calls[0];
			expect(projectId).toBe('p1');
			expect(payload).toMatchObject({
				name: 'Token of Orders in Shop',
				type: 'httpHeaderAuth',
				data: { name: 'Authorization', value: expect.stringMatching(/^Bearer [\w-]{43}$/) },
			});
			expect(result.secret).toEqual({
				header: 'Authorization',
				value: (payload.data as { value: string }).value,
			});
			expect(nodeOf('hook')?.parameters).toMatchObject({
				path: 'orders',
				authentication: 'headerAuth',
			});
			expect(nodeOf('hook')?.credentials).toEqual({
				httpHeaderAuth: { id: 'cred-1', name: 'Token of Orders in Shop' },
			});
		});

		it('creates a bearer credential for an MCP server', async () => {
			const credentialsStore = mockedStore(useCredentialsStore);
			credentialsStore.createNewCredential.mockResolvedValue({
				id: 'cred-2',
				name: 'Token of Tools in Shop',
			} as ICredentialsResponse);

			const result = await useOpenTriggerFixes().applyFix('w1', 'mcp', 'bearerAuth');

			const [payload] = credentialsStore.createNewCredential.mock.calls[0];
			expect(payload).toMatchObject({
				type: 'httpBearerAuth',
				data: { token: expect.any(String) },
			});
			expect(result.secret?.value).toBe(`Bearer ${(payload.data as { token: string }).token}`);
			expect(nodeOf('mcp')?.parameters.authentication).toBe('bearerAuth');
			expect(nodeOf('mcp')?.credentials).toEqual({
				httpBearerAuth: { id: 'cred-2', name: 'Token of Tools in Shop' },
			});
		});

		it('refuses a node that is not on the canvas', async () => {
			await expect(useOpenTriggerFixes().applyFix('w1', 'gone', 'signIn')).rejects.toThrow(
				'The node is not on the canvas any more.',
			);
		});
	});

	it('starts the publish and the review through the event bus of the canvas', () => {
		const emit = vi.spyOn(nodeViewEventBus, 'emit');
		const select = vi.spyOn(canvasEventBus, 'emit');
		const fixes = useOpenTriggerFixes();

		fixes.publish();
		fixes.requestApproval();
		fixes.showNode('hook');

		expect(emit).toHaveBeenCalledWith('publishWorkflow');
		expect(emit).toHaveBeenCalledWith('submitWorkflowForReview');
		expect(select).toHaveBeenCalledWith('nodes:select', { ids: ['hook'], panIntoView: true });
	});
});
