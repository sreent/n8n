// Fork test (not in upstream n8n): the open triggers of published workflows in the public API
// (`/api/v1/inventory/open-triggers`). See packages/cli/src/modules/open-triggers/README.md.
import {
	createActiveWorkflow,
	createTeamProject,
	createWorkflow,
	getPersonalProject,
} from '@n8n/backend-test-utils';
import type { Project, User } from '@n8n/db';
import type { INode, INodeParameters } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import { createMemberWithApiKey, createOwnerWithApiKey } from '../shared/db/users';
import * as utils from '../shared/utils';

const testServer = utils.setupTestServer({
	endpointGroups: ['publicApi'],
	modules: ['open-triggers'],
});

const node = (name: string, type: string, parameters: INodeParameters = {}): INode => ({
	id: uuid(),
	name,
	type,
	typeVersion: 2,
	position: [0, 0],
	parameters,
});

let owner: User;
let ownerWithoutScope: User;
let member: User;
let sales: Project;
let shop: Awaited<ReturnType<typeof createActiveWorkflow>>;
let feedback: Awaited<ReturnType<typeof createActiveWorkflow>>;
let orders: INode;
let refunds: INode;
let survey: INode;

// The tests only read, so they share one set of data.
beforeAll(async () => {
	owner = await createOwnerWithApiKey({ scopes: ['workflow:list'] });
	ownerWithoutScope = await createOwnerWithApiKey({ scopes: ['execution:list'] });
	member = await createMemberWithApiKey({ scopes: ['workflow:list'] });
	sales = await createTeamProject('Sales', owner);

	orders = node('Orders', 'n8n-nodes-base.webhook', { path: 'orders' });
	refunds = node('Refunds', 'n8n-nodes-base.webhook', { path: 'refunds', authentication: 'none' });
	shop = await createActiveWorkflow(
		{
			name: 'Shop',
			nodes: [
				orders,
				refunds,
				node('Leads', 'n8n-nodes-base.webhook', { path: 'leads', authentication: 'headerAuth' }),
			],
		},
		sales,
	);

	survey = node('Survey', 'n8n-nodes-base.formTrigger', { authentication: 'none' });
	feedback = await createActiveWorkflow({ name: 'Feedback', nodes: [survey] }, member);

	// Not published: not in the list.
	await createWorkflow(
		{ name: 'Draft', nodes: [node('Draft', 'n8n-nodes-base.webhook', { path: 'draft' })] },
		sales,
	);
});

describe('GET /inventory/open-triggers', () => {
	test('returns 401 without an API key', async () => {
		await testServer.publicApiAgentWithoutApiKey().get('/inventory/open-triggers').expect(401);
	});

	test('returns 403 for an API key without the scope workflow:list', async () => {
		await testServer
			.publicApiAgentFor(ownerWithoutScope)
			.get('/inventory/open-triggers')
			.expect(403);
	});

	test('gives the open triggers of the published workflows, sorted by workflow and node', async () => {
		const response = await testServer
			.publicApiAgentFor(owner)
			.get('/inventory/open-triggers')
			.expect(200);

		const personal = await getPersonalProject(member);
		expect(response.body).toEqual({
			data: [
				{
					workflowId: feedback.id,
					workflowName: 'Feedback',
					homeProject: { id: personal.id, name: personal.name, type: 'personal' },
					owner: {
						id: member.id,
						email: member.email,
						firstName: member.firstName,
						lastName: member.lastName,
					},
					nodeId: survey.id,
					nodeName: 'Survey',
					nodeType: 'n8n-nodes-base.formTrigger',
					typeVersion: 2,
					kind: 'form',
					path: null,
					approved: false,
				},
				expect.objectContaining({ workflowId: shop.id, nodeId: orders.id, path: 'orders' }),
				expect.objectContaining({ workflowId: shop.id, nodeId: refunds.id, path: 'refunds' }),
			],
			nextCursor: null,
		});
		expect(response.body.data[1]).toMatchObject({
			homeProject: { id: sales.id, name: 'Sales', type: 'team' },
			owner: null,
			kind: 'webhook',
		});
	});

	test('gives a member only the workflows that the member can read', async () => {
		const response = await testServer
			.publicApiAgentFor(member)
			.get('/inventory/open-triggers')
			.expect(200);

		expect(response.body.data.map((item: { nodeName: string }) => item.nodeName)).toEqual([
			'Survey',
		]);
	});

	test('filters by project', async () => {
		const response = await testServer
			.publicApiAgentFor(owner)
			.get('/inventory/open-triggers')
			.query({ projectId: sales.id })
			.expect(200);

		expect(response.body.data.map((item: { nodeName: string }) => item.nodeName)).toEqual([
			'Orders',
			'Refunds',
		]);
	});

	test('pages with limit and cursor', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const first = await agent.get('/inventory/open-triggers').query({ limit: 2 }).expect(200);
		expect(first.body.data.map((item: { nodeName: string }) => item.nodeName)).toEqual([
			'Survey',
			'Orders',
		]);
		expect(first.body.nextCursor).toEqual(expect.any(String));

		const second = await agent
			.get('/inventory/open-triggers')
			.query({ limit: 2, cursor: first.body.nextCursor })
			.expect(200);
		expect(second.body.data.map((item: { nodeName: string }) => item.nodeName)).toEqual([
			'Refunds',
		]);
		expect(second.body.nextCursor).toBeNull();
	});

	test('refuses a limit above 250', async () => {
		await testServer
			.publicApiAgentFor(owner)
			.get('/inventory/open-triggers')
			.query({ limit: 251 })
			.expect(400);
	});
});
