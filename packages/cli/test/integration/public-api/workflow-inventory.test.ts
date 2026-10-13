// Fork test (not in upstream n8n): the inventory of workflows in the public API
// (`/api/v1/inventory/workflows`). See packages/cli/src/governance/README.md.
import {
	createActiveWorkflow,
	createTeamProject,
	createWorkflow,
	getPersonalProject,
	shareWorkflowWithProjects,
} from '@n8n/backend-test-utils';
import { WorkflowRepository, type Project, type User } from '@n8n/db';
import { Container } from '@n8n/di';
import type { INode } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import { createExecution } from '../shared/db/executions';
import { createMemberWithApiKey, createOwnerWithApiKey } from '../shared/db/users';
import * as utils from '../shared/utils';

const testServer = utils.setupTestServer({ endpointGroups: ['publicApi'] });

type InventoryItem = { id: string; name: string } & Record<string, unknown>;

const node = (name: string, type: string, extra: Partial<INode> = {}): INode => ({
	id: uuid(),
	name,
	type,
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
	...extra,
});

let owner: User;
let ownerWithoutExecutions: User;
let member: User;
let finance: Project;
let invoices: Awaited<ReturnType<typeof createActiveWorkflow>>;
let memberFlow: Awaited<ReturnType<typeof createWorkflow>>;
let oldFlow: Awaited<ReturnType<typeof createWorkflow>>;

// The tests only read, so they share one set of data.
beforeAll(async () => {
	owner = await createOwnerWithApiKey({ scopes: ['workflow:list', 'execution:list'] });
	ownerWithoutExecutions = await createOwnerWithApiKey({ scopes: ['workflow:list'] });
	member = await createMemberWithApiKey({ scopes: ['workflow:list', 'execution:list'] });

	finance = await createTeamProject('Finance', owner);
	invoices = await createActiveWorkflow(
		{
			name: 'Invoices',
			nodes: [
				node('Every day', 'n8n-nodes-base.scheduleTrigger'),
				node('Webhook', 'n8n-nodes-base.webhook', { disabled: true }),
				node('Fetch', 'n8n-nodes-base.httpRequest', {
					credentials: { httpBasicAuth: { id: 'cred-1', name: 'Billing API' } },
				}),
				node('Fetch again', 'n8n-nodes-base.httpRequest', {
					credentials: { httpBasicAuth: { id: 'cred-1', name: 'Billing API' } },
				}),
			],
			connections: {},
		},
		finance,
	);
	// A saved change after the publication.
	await Container.get(WorkflowRepository).update(invoices.id, { versionId: uuid() });
	memberFlow = await createWorkflow(
		{ name: 'My flow', nodes: [node('Start', 'n8n-nodes-base.manualTrigger')] },
		member,
	);
	await shareWorkflowWithProjects(memberFlow, [{ project: finance, role: 'workflow:editor' }]);
	oldFlow = await createWorkflow({ name: 'Old flow', isArchived: true }, member);

	for (const [index, status] of (['success', 'error', 'success'] as const).entries()) {
		await createExecution(
			{
				status,
				mode: 'trigger',
				startedAt: new Date(Date.UTC(2026, 9, 1, 8, index)),
				stoppedAt: new Date(Date.UTC(2026, 9, 1, 8, index, 30)),
			},
			invoices,
		);
	}
});

const byName = (body: { data: InventoryItem[] }) =>
	Object.fromEntries(body.data.map((workflow) => [workflow.name, workflow]));

// The route sorts by workflow id, and the ids are random, so the tests compare sorted names.
const namesOf = (body: { data: InventoryItem[] }) =>
	body.data.map((workflow) => workflow.name).sort();

describe('GET /inventory/workflows', () => {
	test('returns 401 without an API key', async () => {
		await testServer.publicApiAgentWithoutApiKey().get('/inventory/workflows').expect(401);
	});

	test('returns 403 for an API key without the scope execution:list', async () => {
		await testServer
			.publicApiAgentFor(ownerWithoutExecutions)
			.get('/inventory/workflows')
			.expect(403);
	});

	test('gives each workflow with its owner, status, nodes, credentials, triggers and executions', async () => {
		const response = await testServer
			.publicApiAgentFor(owner)
			.get('/inventory/workflows')
			.query({ executions: 2 })
			.expect(200);

		expect(namesOf(response.body)).toEqual(['Invoices', 'My flow', 'Old flow']);
		expect(response.body.nextCursor).toBeNull();

		const workflows = byName(response.body);
		expect(workflows.Invoices).toEqual({
			id: invoices.id,
			name: 'Invoices',
			status: 'published',
			hasUnpublishedChanges: true,
			createdAt: expect.any(String),
			updatedAt: expect.any(String),
			tags: [],
			homeProject: { id: finance.id, name: 'Finance', type: 'team' },
			owner: null,
			sharedWith: [],
			nodeCount: 4,
			nodeTypes: [
				'n8n-nodes-base.httpRequest',
				'n8n-nodes-base.scheduleTrigger',
				'n8n-nodes-base.webhook',
			],
			credentials: [{ id: 'cred-1', name: 'Billing API', type: 'httpBasicAuth' }],
			triggers: [
				{ name: 'Every day', type: 'n8n-nodes-base.scheduleTrigger', disabled: false },
				{ name: 'Webhook', type: 'n8n-nodes-base.webhook', disabled: true },
			],
			recentExecutions: [
				expect.objectContaining({
					status: 'success',
					mode: 'trigger',
					startedAt: '2026-10-01T08:02:00.000Z',
					stoppedAt: '2026-10-01T08:02:30.000Z',
				}),
				expect.objectContaining({ status: 'error', startedAt: '2026-10-01T08:01:00.000Z' }),
			],
		});

		const personal = await getPersonalProject(member);
		expect(workflows['My flow']).toMatchObject({
			status: 'unpublished',
			hasUnpublishedChanges: false,
			homeProject: { id: personal.id, type: 'personal' },
			owner: { id: member.id, email: member.email },
			sharedWith: [{ id: finance.id, name: 'Finance', type: 'team', role: 'workflow:editor' }],
			triggers: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', disabled: false }],
			recentExecutions: [],
		});
		expect(workflows['Old flow']).toMatchObject({ id: oldFlow.id, status: 'archived' });
	});

	test('gives no executions with executions=0, and 5 by default', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const none = await agent.get('/inventory/workflows').query({ executions: 0 }).expect(200);
		expect(byName(none.body).Invoices.recentExecutions).toEqual([]);

		const byDefault = await agent.get('/inventory/workflows').expect(200);
		expect(byName(byDefault.body).Invoices.recentExecutions).toHaveLength(3);
	});

	test('gives a member only the workflows that the member can read', async () => {
		const response = await testServer
			.publicApiAgentFor(member)
			.get('/inventory/workflows')
			.expect(200);

		expect(namesOf(response.body)).toEqual(['My flow', 'Old flow']);
	});

	test('filters by project', async () => {
		const response = await testServer
			.publicApiAgentFor(owner)
			.get('/inventory/workflows')
			.query({ projectId: finance.id })
			.expect(200);

		// The workflows of the project, and the workflows shared with it.
		expect(namesOf(response.body)).toEqual(['Invoices', 'My flow']);
	});

	test('pages with limit and cursor', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const first = await agent.get('/inventory/workflows').query({ limit: 2 }).expect(200);
		expect(first.body.data).toHaveLength(2);
		expect(first.body.nextCursor).toEqual(expect.any(String));

		const second = await agent
			.get('/inventory/workflows')
			.query({ cursor: first.body.nextCursor })
			.expect(200);
		expect(second.body.data).toHaveLength(1);
		expect(second.body.nextCursor).toBeNull();
		expect([...namesOf(first.body), ...namesOf(second.body)].sort()).toEqual([
			'Invoices',
			'My flow',
			'Old flow',
		]);
	});

	test('returns 400 for a page or an execution count out of range', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		await agent.get('/inventory/workflows').query({ limit: 0 }).expect(400);
		await agent.get('/inventory/workflows').query({ limit: 101 }).expect(400);
		await agent.get('/inventory/workflows').query({ executions: 21 }).expect(400);
		const cursor = Buffer.from(JSON.stringify({ offset: 0, limit: 500 })).toString('base64');
		await agent.get('/inventory/workflows').query({ cursor }).expect(400);
	});
});
