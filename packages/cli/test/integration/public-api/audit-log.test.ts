// Fork test (not in upstream n8n): the audit log in the public API (`/api/v1/audit-log`). See
// packages/cli/src/modules/audit-log/README.md.
import { ModuleRegistry } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';

import { AuditLogEventRepository } from '@/modules/audit-log/database/audit-log-event.repository';

import {
	createAdminWithApiKey,
	createMemberWithApiKey,
	createOwnerWithApiKey,
} from '../shared/db/users';
import * as utils from '../shared/utils';

// The global test setup mocks the event bus. The audit log module listens to the real one.
vi.unmock('@/eventbus/message-event-bus/message-event-bus');

const testServer = utils.setupTestServer({
	endpointGroups: ['publicApi'],
	enabledFeatures: ['feat:logStreaming'],
	modules: ['audit-log'],
});

let owner: User;
let ownerWithoutScope: User;
let admin: User;
let member: User;

beforeAll(async () => {
	owner = await createOwnerWithApiKey({ scopes: ['auditLogs:manage'] });
	ownerWithoutScope = await createOwnerWithApiKey({ scopes: ['workflow:list'] });
	admin = await createAdminWithApiKey({ scopes: ['auditLogs:manage'] });
	// A member cannot get this scope through the API, so the test stores it on the key.
	member = await createMemberWithApiKey({ scopes: ['auditLogs:manage'] });
});

beforeEach(async () => {
	const repository = Container.get(AuditLogEventRepository);
	await repository.clear();
	await repository.insertIgnoringDuplicates([
		{
			id: 'e1',
			eventName: 'n8n.audit.user.login.success',
			timestamp: new Date('2026-10-01T08:00:00.000Z'),
			userId: owner.id,
			userEmail: owner.email,
			projectId: null,
			projectType: null,
			payload: { userId: owner.id, _email: owner.email },
		},
		{
			id: 'e2',
			eventName: 'n8n.audit.workflow.updated',
			timestamp: new Date('2026-10-02T08:00:00.000Z'),
			userId: admin.id,
			userEmail: admin.email,
			projectId: 'teamProject0001',
			projectType: 'team',
			payload: { userId: admin.id, workflowId: 'wf-1', workflowName: 'Invoices' },
		},
		{
			id: 'e3',
			eventName: 'n8n.audit.workflow.created',
			timestamp: new Date('2026-10-03T08:00:00.000Z'),
			userId: admin.id,
			userEmail: admin.email,
			projectId: 'personalProj001',
			projectType: 'personal',
			payload: { userId: admin.id, workflowId: 'wf-2', workflowName: '=SUM(A1)' },
		},
	]);
	vi.restoreAllMocks();
});

const ids = (body: { data: Array<{ id: string }> }) => body.data.map((event) => event.id);

describe('GET /audit-log/events', () => {
	test('returns 401 without an API key', async () => {
		await testServer.publicApiAgentWithoutApiKey().get('/audit-log/events').expect(401);
	});

	test('returns 403 for an API key without the scope auditLogs:manage', async () => {
		await testServer.publicApiAgentFor(ownerWithoutScope).get('/audit-log/events').expect(403);
	});

	test('returns 403 for a member, also with the scope on the key', async () => {
		await testServer.publicApiAgentFor(member).get('/audit-log/events').expect(403);
	});

	test('lists the events, newest first, for the owner and an admin', async () => {
		for (const user of [owner, admin]) {
			const response = await testServer
				.publicApiAgentFor(user)
				.get('/audit-log/events')
				.expect(200);

			expect(ids(response.body)).toEqual(['e3', 'e2', 'e1']);
			expect(response.body.nextCursor).toBeNull();
			expect(response.body.data[1]).toEqual({
				id: 'e2',
				eventName: 'n8n.audit.workflow.updated',
				timestamp: '2026-10-02T08:00:00.000Z',
				userId: admin.id,
				userEmail: admin.email,
				projectId: 'teamProject0001',
				projectType: 'team',
				payload: { userId: admin.id, workflowId: 'wf-1', workflowName: 'Invoices' },
			});
		}
	});

	test('works with the session cookie of the owner', async () => {
		const response = await testServer
			.publicApiAgentWithCookie(owner)
			.get('/audit-log/events')
			.expect(200);

		expect(ids(response.body)).toEqual(['e3', 'e2', 'e1']);
	});

	test('filters by event name, prefix, user and time', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const byName = await agent
			.get('/audit-log/events')
			.query({ eventName: 'n8n.audit.workflow.updated' })
			.expect(200);
		expect(ids(byName.body)).toEqual(['e2']);

		const byPrefix = await agent
			.get('/audit-log/events')
			.query({ eventName: 'n8n.audit.workflow.' })
			.expect(200);
		expect(ids(byPrefix.body)).toEqual(['e3', 'e2']);

		const byUser = await agent.get('/audit-log/events').query({ userId: owner.id }).expect(200);
		expect(ids(byUser.body)).toEqual(['e1']);

		const byTime = await agent
			.get('/audit-log/events')
			.query({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-02T23:59:59.999Z' })
			.expect(200);
		expect(ids(byTime.body)).toEqual(['e2']);
	});

	test('filters by project and project type', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const personal = await agent
			.get('/audit-log/events')
			.query({ projectType: 'personal' })
			.expect(200);
		expect(ids(personal.body)).toEqual(['e3']);

		const byProject = await agent
			.get('/audit-log/events')
			.query({ projectId: 'teamProject0001' })
			.expect(200);
		expect(ids(byProject.body)).toEqual(['e2']);

		await agent.get('/audit-log/events').query({ projectType: 'shared' }).expect(400);
	});

	test('pages with limit and cursor', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const first = await agent.get('/audit-log/events').query({ limit: 2 }).expect(200);
		expect(ids(first.body)).toEqual(['e3', 'e2']);
		expect(first.body.nextCursor).toEqual(expect.any(String));

		const second = await agent
			.get('/audit-log/events')
			.query({ cursor: first.body.nextCursor })
			.expect(200);
		expect(ids(second.body)).toEqual(['e1']);
		expect(second.body.nextCursor).toBeNull();
	});

	test('returns 400 for a page of 0 events or a changed cursor', async () => {
		const agent = testServer.publicApiAgentFor(owner);
		const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

		await agent.get('/audit-log/events').query({ limit: 0 }).expect(400);
		for (const changed of [
			{ offset: 0, limit: 1000 },
			{ offset: -1, limit: 10 },
			{ offset: '1', limit: 10 },
			{ offset: 0, limit: 0 },
		]) {
			await agent
				.get('/audit-log/events')
				.query({ cursor: cursor(changed) })
				.expect(400);
		}
		await agent.get('/audit-log/events').query({ cursor: 'not-a-cursor' }).expect(400);
	});

	test('returns 400 for a time that is not ISO 8601', async () => {
		await testServer
			.publicApiAgentFor(owner)
			.get('/audit-log/events')
			.query({ from: 'yesterday' })
			.expect(400);
	});

	test('returns 503 when the audit log module is off', async () => {
		vi.spyOn(Container.get(ModuleRegistry), 'isActive').mockReturnValue(false);

		await testServer.publicApiAgentFor(owner).get('/audit-log/events').expect(503);
	});
});

describe('GET /audit-log/export', () => {
	test('returns 403 for an API key without the scope auditLogs:manage', async () => {
		await testServer.publicApiAgentFor(ownerWithoutScope).get('/audit-log/export').expect(403);
	});

	test('returns a CSV file by default', async () => {
		const response = await testServer
			.publicApiAgentFor(owner)
			.get('/audit-log/export')
			.query({ eventName: 'n8n.audit.workflow.' })
			.expect(200);

		expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
		expect(response.headers['content-disposition']).toMatch(
			/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
		);
		const lines = response.text.trim().split('\r\n');
		expect(lines[0]).toBe('timestamp,eventName,userId,userEmail,payload,projectId,projectType');
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain('n8n.audit.workflow.created');
		// The payload is one cell. A cell that a spreadsheet can read as a formula starts with a quote.
		expect(lines[1]).toContain('""workflowName"":""=SUM(A1)""');
		expect(lines[1]).toMatch(/,personalProj001,personal$/);
		expect(lines[2]).toContain('n8n.audit.workflow.updated');
	});

	test('returns a JSON file', async () => {
		const response = await testServer
			.publicApiAgentFor(admin)
			.get('/audit-log/export')
			.query({ format: 'json', userId: owner.id })
			.buffer(true)
			.parse((res, callback) => {
				let text = '';
				res.on('data', (chunk: Buffer) => (text += chunk.toString()));
				res.on('end', () => callback(null, text));
			})
			.expect(200);

		expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
		expect(response.headers['content-disposition']).toMatch(/\.json"$/);
		const events = JSON.parse(response.body as string) as Array<{ id: string }>;
		expect(events.map((event) => event.id)).toEqual(['e1']);
	});

	test('returns 400 for an unknown format', async () => {
		await testServer
			.publicApiAgentFor(owner)
			.get('/audit-log/export')
			.query({ format: 'xml' })
			.expect(400);
	});
});
