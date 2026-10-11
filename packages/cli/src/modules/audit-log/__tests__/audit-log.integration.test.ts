import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import { DateTime } from 'luxon';

import type { EventMessageAuditOptions } from '@/eventbus/event-message-classes/event-message-audit';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';
import { createAdmin, createMember, createOwner } from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

import { AuditLogCollectionService } from '../audit-log-collection.service';
import { AuditLogPruningService } from '../audit-log-pruning.service';
import { AuditLogEventRepository } from '../database/audit-log-event.repository';

// The global test setup mocks the event bus. This test sends real audit events through it.
vi.unmock('@/eventbus/message-event-bus/message-event-bus');

// A non-empty endpoint group makes the test server initialize the modules.
const testServer = setupTestServer({ endpointGroups: ['me'], modules: ['audit-log'] });

let owner: User;
let admin: User;
let member: User;

beforeAll(async () => {
	owner = await createOwner();
	admin = await createAdmin();
	member = await createMember();
});

beforeEach(async () => {
	await Container.get(AuditLogEventRepository).clear();
});

/** Sends an audit event through the event bus, as the relay does, and waits for the write. */
async function sendAuditEvent(options: EventMessageAuditOptions) {
	await Container.get(MessageEventBus).sendAuditEvent(options);
	await Container.get(AuditLogCollectionService).flush();
}

const at = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });

async function sendThreeEvents() {
	await sendAuditEvent({
		id: 'e1',
		eventName: 'n8n.audit.user.login.success',
		ts: at('2026-10-01T08:00:00.000Z'),
		payload: { userId: owner.id, _email: owner.email, authenticationMethod: 'email' },
	});
	await sendAuditEvent({
		id: 'e2',
		eventName: 'n8n.audit.workflow.updated',
		ts: at('2026-10-02T08:00:00.000Z'),
		payload: { userId: member.id, _email: member.email, workflowId: 'wf-1' },
	});
	await sendAuditEvent({
		id: 'e3',
		eventName: 'n8n.audit.user.login.failed',
		ts: at('2026-10-03T08:00:00.000Z'),
		payload: { userEmail: 'unknown@example.com', reason: 'wrong password' },
	});
}

describe('GET /audit-log/events', () => {
	it('lists the stored audit events, newest first', async () => {
		await sendThreeEvents();
		await Container.get(MessageEventBus).sendWorkflowEvent({ eventName: 'n8n.workflow.started' });
		await Container.get(AuditLogCollectionService).flush();

		const response = await testServer.authAgentFor(owner).get('/audit-log/events').expect(200);

		expect(response.body.data.count).toBe(3);
		expect(response.body.data.events).toEqual([
			{
				id: 'e3',
				eventName: 'n8n.audit.user.login.failed',
				timestamp: '2026-10-03T08:00:00.000Z',
				userId: null,
				userEmail: 'unknown@example.com',
				payload: { userEmail: 'unknown@example.com', reason: 'wrong password' },
			},
			expect.objectContaining({ id: 'e2', userId: member.id, userEmail: member.email }),
			expect.objectContaining({ id: 'e1', userId: owner.id, userEmail: owner.email }),
		]);
	});

	it('stores an event that the bus sends again once', async () => {
		await sendThreeEvents();
		await sendAuditEvent({ id: 'e1', eventName: 'n8n.audit.user.login.success' });

		const response = await testServer.authAgentFor(owner).get('/audit-log/events').expect(200);
		expect(response.body.data.count).toBe(3);
	});

	it('filters by name, prefix, user and time, and pages', async () => {
		await sendThreeEvents();
		const agent = testServer.authAgentFor(admin);
		const ids = async (query: Record<string, string>) =>
			(await agent.get('/audit-log/events').query(query).expect(200)).body.data.events.map(
				(event: { id: string }) => event.id,
			);

		expect(await ids({ eventName: 'n8n.audit.workflow.updated' })).toEqual(['e2']);
		expect(await ids({ eventName: 'n8n.audit.user.' })).toEqual(['e3', 'e1']);
		expect(await ids({ eventName: 'n8n.audit.user' })).toEqual([]);
		expect(await ids({ userId: owner.id })).toEqual(['e1']);
		expect(await ids({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-03T08:00:00.000Z' })).toEqual(
			['e3', 'e2'],
		);
		// The same time as e2, with an offset. Both bounds include it.
		const e2Time = '2026-10-02T09:00:00.000+01:00';
		expect(await ids({ from: e2Time, to: e2Time })).toEqual(['e2']);
		expect(await ids({ skip: '1', take: '1' })).toEqual(['e2']);
	});

	it('rejects invalid query parameters', async () => {
		const agent = testServer.authAgentFor(owner);
		await agent.get('/audit-log/events').query({ take: '0' }).expect(400);
		await agent.get('/audit-log/events').query({ skip: '-1' }).expect(400);
		await agent.get('/audit-log/events').query({ from: 'yesterday' }).expect(400);
	});

	it('is forbidden for a member', async () => {
		await testServer.authAgentFor(member).get('/audit-log/events').expect(403);
		await testServer.authAgentFor(member).get('/audit-log/export').expect(403);
		await testServer.authAgentFor(member).get('/audit-log/event-names').expect(403);
	});
});

describe('GET /audit-log/event-names', () => {
	it('gives the names of the audit events', async () => {
		const response = await testServer.authAgentFor(owner).get('/audit-log/event-names').expect(200);
		expect(response.body.data).toContain('n8n.audit.workflow.created');
	});
});

describe('GET /audit-log/export', () => {
	it('exports CSV by default', async () => {
		await sendThreeEvents();

		const response = await testServer
			.authAgentFor(owner)
			.get('/audit-log/export')
			.query({ eventName: 'n8n.audit.user.' })
			.expect(200);

		expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
		expect(response.headers['content-disposition']).toMatch(
			/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
		);
		const lines = response.text.split('\r\n');
		expect(lines[0]).toBe('timestamp,eventName,userId,userEmail,payload');
		expect(lines[1]).toMatch(
			/^2026-10-03T08:00:00.000Z,n8n.audit.user.login.failed,,unknown@example.com,/,
		);
		expect(lines[2]).toMatch(/^2026-10-01T08:00:00.000Z,n8n.audit.user.login.success,/);
		expect(lines).toHaveLength(4);
	});

	it('exports JSON', async () => {
		await sendThreeEvents();

		const response = await testServer
			.authAgentFor(owner)
			.get('/audit-log/export')
			.query({ format: 'json' })
			.buffer(true)
			.parse((res, callback) => {
				let body = '';
				res.on('data', (chunk: Buffer) => (body += chunk.toString()));
				res.on('end', () => callback(null, body));
			})
			.expect(200);

		const events = JSON.parse(response.body as string) as Array<{ id: string }>;
		expect(events.map((event) => event.id)).toEqual(['e3', 'e2', 'e1']);
	});

	it('exports more events than one batch, also events with the same time', async () => {
		// Groups of 10 events have the same time, so batches also end in the middle of a group.
		const stored = Array.from({ length: 1005 }, (_, index) => ({
			id: `event-${String(index).padStart(4, '0')}`,
			eventName: 'n8n.audit.workflow.updated',
			timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, Math.floor(index / 10))),
			userId: null,
			userEmail: null,
			payload: {},
		}));
		const repository = Container.get(AuditLogEventRepository);
		for (let start = 0; start < stored.length; start += 100) {
			await repository.insertIgnoringDuplicates(stored.slice(start, start + 100));
		}

		const response = await testServer
			.authAgentFor(owner)
			.get('/audit-log/export')
			.query({ format: 'json' })
			.buffer(true)
			.parse((res, callback) => {
				let body = '';
				res.on('data', (chunk: Buffer) => (body += chunk.toString()));
				res.on('end', () => callback(null, body));
			})
			.expect(200);

		const events = JSON.parse(response.body as string) as Array<{ id: string }>;
		expect(events.map((event) => event.id)).toEqual(stored.map((event) => event.id).reverse());
	});
});

describe('pruning', () => {
	it('deletes the events older than the retention', async () => {
		await sendThreeEvents();

		// 90 days before this time is 2026-10-02T09:00:00.000Z.
		const deleted = await Container.get(AuditLogPruningService).prune(
			new Date('2026-12-31T09:00:00.000Z'),
		);

		expect(deleted).toBe(2);
		const left = await Container.get(AuditLogEventRepository).find();
		expect(left.map((event) => event.id)).toEqual(['e3']);
	});
});
