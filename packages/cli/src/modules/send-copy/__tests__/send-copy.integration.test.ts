import type { SendCopyResult } from '@n8n/api-types';
import { createWorkflow, testDb } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import {
	GLOBAL_MEMBER_ROLE,
	ProjectRepository,
	SharedWorkflowRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';

import { createTag } from '@test-integration/db/tags';
import {
	createChatUser,
	createMember,
	createOwner,
	createUser,
	createUserShell,
} from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

// A non-empty endpoint group makes the test server initialize the modules.
const testServer = setupTestServer({ endpointGroups: ['me'], modules: ['send-copy'] });

let owner: User;
let alice: User;
let bob: User;

beforeAll(async () => {
	owner = await createOwner();
	alice = await createMember();
	bob = await createMember();
});

beforeEach(async () => {
	await testDb.truncate(['SharedWorkflow', 'WorkflowEntity']);
});

const createSourceWorkflow = async (user: User) =>
	await createWorkflow(
		{
			name: 'Daily report',
			nodes: [
				{
					id: 'node-webhook',
					name: 'Webhook',
					type: 'n8n-nodes-base.webhook',
					typeVersion: 2,
					position: [0, 0],
					webhookId: 'original-webhook-id',
					parameters: { path: 'daily-report', httpMethod: 'GET' },
				},
				{
					id: 'node-http',
					name: 'HTTP Request',
					type: 'n8n-nodes-base.httpRequest',
					typeVersion: 4,
					position: [200, 0],
					parameters: { url: 'https://example.com' },
					credentials: { httpBasicAuth: { id: 'cred-1', name: 'Secret' } },
				},
			],
			connections: {
				Webhook: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
			},
			settings: { timezone: 'Europe/Berlin', errorWorkflow: 'error-workflow-id' },
			pinData: { Webhook: [{ json: { secret: true } }] },
			staticData: { lastId: 5 },
		},
		user,
	);

describe('POST /send-copy/workflows/:workflowId', () => {
	it('creates an independent copy in the personal project of each recipient', async () => {
		const source = await createSourceWorkflow(alice);
		const tag = await createTag({ name: 'reports' }, source);

		const response = await testServer
			.authAgentFor(alice)
			.post(`/send-copy/workflows/${source.id}`)
			.send({ recipientIds: [bob.id, owner.id] })
			.expect(200);

		const results = response.body.data.results as SendCopyResult[];
		expect(results.map((result) => [result.recipientId, result.status])).toEqual([
			[bob.id, 'sent'],
			[owner.id, 'sent'],
		]);

		for (const result of results) {
			if (result.status !== 'sent') throw new Error('Expected a sent result');
			const recipientId = result.recipientId;

			const owning = await Container.get(SharedWorkflowRepository).findOneOrFail({
				where: { workflowId: result.workflowId },
				relations: { project: true },
			});
			const personal =
				await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(recipientId);
			expect(owning.projectId).toBe(personal.id);
			expect(owning.role).toBe('workflow:owner');

			const copy = await Container.get(WorkflowRepository).findOneOrFail({
				where: { id: result.workflowId },
				relations: { tags: true },
			});
			expect(copy.id).not.toBe(source.id);
			expect(copy.name).toBe(`Daily report (from ${alice.firstName} ${alice.lastName})`);
			expect(copy.activeVersionId).toBeNull();
			expect(copy.sourceWorkflowId).toBeNull();
			expect(copy.pinData ?? {}).toEqual({});
			expect(copy.staticData ?? null).toBeNull();
			expect(copy.settings).toEqual({ timezone: 'Europe/Berlin' });
			expect(copy.tags?.map((t) => t.id)).toEqual([tag.id]);

			const webhook = copy.nodes.find((node) => node.name === 'Webhook');
			expect(webhook?.webhookId).toBeDefined();
			expect(webhook?.webhookId).not.toBe('original-webhook-id');
			expect(webhook?.parameters.path).toBe(webhook?.webhookId);

			const http = copy.nodes.find((node) => node.name === 'HTTP Request');
			expect(http?.credentials).toBeUndefined();
		}

		// The original workflow does not change.
		const original = await Container.get(WorkflowRepository).findOneByOrFail({ id: source.id });
		expect(original.nodes.find((n) => n.name === 'HTTP Request')?.credentials).toBeDefined();
	});

	it('returns 403 when the sender cannot read the workflow, as the routes of n8n do', async () => {
		const source = await createSourceWorkflow(alice);

		await testServer
			.authAgentFor(bob)
			.post(`/send-copy/workflows/${source.id}`)
			.send({ recipientIds: [owner.id] })
			.expect(403);

		expect(await Container.get(WorkflowRepository).count()).toBe(1);
	});

	it('returns 404 for an unknown workflow', async () => {
		await testServer
			.authAgentFor(bob)
			.post('/send-copy/workflows/unknown-workflow-id')
			.send({ recipientIds: [owner.id] })
			.expect(404);
	});

	it('reports recipients who cannot receive a copy', async () => {
		const source = await createSourceWorkflow(alice);
		const chatUser = await createChatUser();
		const pendingUser = await createUserShell(GLOBAL_MEMBER_ROLE);
		const disabledUser = await createUser({ disabled: true });
		const unknownId = '00000000-0000-4000-8000-000000000000';

		const response = await testServer
			.authAgentFor(alice)
			.post(`/send-copy/workflows/${source.id}`)
			.send({
				recipientIds: [alice.id, chatUser.id, pendingUser.id, disabledUser.id, unknownId],
			})
			.expect(200);

		expect(response.body.data.results).toEqual([
			{ recipientId: alice.id, status: 'failed', reason: 'self' },
			{ recipientId: chatUser.id, status: 'failed', reason: 'not-eligible' },
			{ recipientId: pendingUser.id, status: 'failed', reason: 'not-eligible' },
			{ recipientId: disabledUser.id, status: 'failed', reason: 'not-eligible' },
			{ recipientId: unknownId, status: 'failed', reason: 'not-found' },
		]);
		expect(await Container.get(WorkflowRepository).count()).toBe(1);
	});

	it('rejects more than 20 recipients', async () => {
		const source = await createSourceWorkflow(alice);
		const recipientIds = Array.from(
			{ length: 21 },
			(_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
		);

		await testServer
			.authAgentFor(alice)
			.post(`/send-copy/workflows/${source.id}`)
			.send({ recipientIds })
			.expect(400);
	});

	it('rejects an empty recipient list', async () => {
		const source = await createSourceWorkflow(alice);

		await testServer
			.authAgentFor(alice)
			.post(`/send-copy/workflows/${source.id}`)
			.send({ recipientIds: [] })
			.expect(400);
	});
});

describe('GET /send-copy/recipients', () => {
	it('lists active colleagues and leaves out the sender and ineligible users', async () => {
		const chatUser = await createChatUser();
		const pendingUser = await createUserShell(GLOBAL_MEMBER_ROLE);
		const disabledUser = await createUser({ disabled: true });

		const response = await testServer.authAgentFor(alice).get('/send-copy/recipients').expect(200);

		const ids = (response.body.data as Array<{ id: string }>).map((user) => user.id);
		expect(ids).toEqual(expect.arrayContaining([owner.id, bob.id]));
		expect(ids).not.toContain(alice.id);
		expect(ids).not.toContain(chatUser.id);
		expect(ids).not.toContain(pendingUser.id);
		expect(ids).not.toContain(disabledUser.id);
		expect(Object.keys(response.body.data[0]).sort()).toEqual([
			'email',
			'firstName',
			'id',
			'lastName',
		]);
	});

	it('filters by search text and limits the result', async () => {
		const response = await testServer
			.authAgentFor(alice)
			.get('/send-copy/recipients')
			.query({ search: bob.email.toUpperCase(), limit: 1 })
			.expect(200);

		expect(response.body.data).toEqual([
			{ id: bob.id, firstName: bob.firstName, lastName: bob.lastName, email: bob.email },
		]);
	});

	it('rejects a limit above the maximum', async () => {
		await testServer
			.authAgentFor(alice)
			.get('/send-copy/recipients')
			.query({ limit: 51 })
			.expect(400);
	});
});
