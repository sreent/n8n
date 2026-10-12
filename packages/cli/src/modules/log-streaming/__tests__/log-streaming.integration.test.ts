import { InstanceSettingsLoaderConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';
import { saveCredential } from '@test-integration/db/credentials';
import { createAdmin, createMember, createOwner } from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

import { EventDestinationRepository } from '../database/event-destination.repository';
import { LogStreamingService } from '../log-streaming.service';

// The global test setup mocks the event bus. This test sends real events through it.
vi.unmock('@/eventbus/message-event-bus/message-event-bus');

// A non-empty endpoint group makes the test server initialize the modules.
const testServer = setupTestServer({ endpointGroups: ['me'], modules: ['log-streaming'] });

interface ReceivedRequest {
	method: string;
	url: string;
	headers: IncomingMessage['headers'];
	body: Record<string, unknown>;
}

/** A webhook receiver on the loopback interface. */
let receiver: Server;
let received: ReceivedRequest[];
let statusCode: number;
let receiverUrl: string;

let owner: User;
let admin: User;
let member: User;

beforeAll(async () => {
	owner = await createOwner();
	admin = await createAdmin();
	member = await createMember();

	receiver = createServer((req, res) => {
		let data = '';
		req.on('data', (chunk: Buffer) => (data += chunk.toString()));
		req.on('end', () => {
			received.push({
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: data ? JSON.parse(data) : {},
			});
			res.writeHead(statusCode).end('ok');
		});
	});
	await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
	receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

beforeEach(async () => {
	received = [];
	statusCode = 200;
	Container.get(InstanceSettingsLoaderConfig).logStreamingManagedByEnv = false;
	await Container.get(EventDestinationRepository).clear();
	await Container.get(LogStreamingService).loadDestinations();
	vi.restoreAllMocks();
});

const webhook = (input: Record<string, unknown> = {}) => ({
	__type: '$$MessageEventBusDestinationWebhook',
	url: receiverUrl,
	...input,
});

async function addDestination(body: Record<string, unknown>, user = owner) {
	const response = await testServer.authAgentFor(user).post('/eventbus/destination').send(body);
	expect(response.status).toBe(200);
	return response.body.data as { id: string; enabled: boolean };
}

describe('access', () => {
	it('gives the routes only to users with the scope logStreaming:manage', async () => {
		const agent = testServer.authAgentFor(member);
		await agent.get('/eventbus/destination').expect(403);
		await agent.post('/eventbus/destination').send(webhook()).expect(403);
		await agent.delete('/eventbus/destination?id=x').expect(403);
		await agent.get('/eventbus/testmessage?id=x').expect(403);
		await agent.get('/eventbus/eventnames').expect(403);

		await testServer.authAgentFor(admin).get('/eventbus/destination').expect(200);
	});
});

describe('GET /eventbus/eventnames', () => {
	it('lists the names of the events', async () => {
		const response = await testServer.authAgentFor(owner).get('/eventbus/eventnames').expect(200);

		expect(response.body.data).toEqual(
			expect.arrayContaining(['n8n.audit.user.login.success', 'n8n.workflow.success']),
		);
	});
});

describe('POST /eventbus/destination', () => {
	it('adds a destination that is off, with the defaults of its kind', async () => {
		const saved = await addDestination(webhook({ label: 'SIEM' }));

		expect(saved).toMatchObject({
			__type: '$$MessageEventBusDestinationWebhook',
			label: 'SIEM',
			enabled: false,
			method: 'POST',
			subscribedEvents: ['n8n.audit', 'n8n.workflow'],
		});

		const list = await testServer.authAgentFor(owner).get('/eventbus/destination').expect(200);
		expect(list.body.data).toEqual([saved]);
		const one = await testServer
			.authAgentFor(owner)
			.get(`/eventbus/destination?id=${saved.id}`)
			.expect(200);
		expect(one.body.data).toEqual([saved]);
	});

	it('changes the given options of a destination', async () => {
		const { id } = await addDestination(webhook({ label: 'SIEM' }));

		const changed = await addDestination({
			__type: '$$MessageEventBusDestinationWebhook',
			id,
			url: receiverUrl,
			enabled: true,
		});

		expect(changed).toMatchObject({ id, label: 'SIEM', enabled: true });
	});

	it('rejects a body that is not valid', async () => {
		const agent = testServer.authAgentFor(owner);
		await agent.post('/eventbus/destination').send({ __type: 'unknown' }).expect(400);
		await agent
			.post('/eventbus/destination')
			.send(webhook({ url: 'not a url' }))
			.expect(400);
		await agent
			.post('/eventbus/destination')
			.send(webhook({ sendHeaders: true, specifyHeaders: 'json', jsonHeaders: '{' }))
			.expect(400);
	});

	it('rejects changes while the environment manages the destinations', async () => {
		Container.get(InstanceSettingsLoaderConfig).logStreamingManagedByEnv = true;

		await testServer.authAgentFor(owner).post('/eventbus/destination').send(webhook()).expect(400);
	});
});

describe('DELETE /eventbus/destination', () => {
	it('deletes a destination', async () => {
		const { id } = await addDestination(webhook());
		const agent = testServer.authAgentFor(owner);

		await agent.delete(`/eventbus/destination?id=${id}`).expect(200);

		const list = await agent.get('/eventbus/destination').expect(200);
		expect(list.body.data).toEqual([]);
		await agent.delete(`/eventbus/destination?id=${id}`).expect(404);
	});
});

describe('GET /eventbus/testmessage', () => {
	it('sends a test event to a destination that is off, and tells if it took it', async () => {
		const { id } = await addDestination(webhook());
		const agent = testServer.authAgentFor(owner);

		const success = await agent.get(`/eventbus/testmessage?id=${id}`).expect(200);
		expect(success.body.data).toBe(true);
		expect(received).toEqual([
			expect.objectContaining({
				method: 'POST',
				body: expect.objectContaining({ eventName: 'n8n.destination.test' }),
			}),
		]);

		statusCode = 500;
		const failure = await agent.get(`/eventbus/testmessage?id=${id}`).expect(200);
		expect(failure.body.data).toBe(false);

		await agent.get('/eventbus/testmessage?id=3f1b8a52-6e7c-4f0e-9a51-2d9c7f8e1a20').expect(404);
	});

	it('adds the header of a header auth credential', async () => {
		const credential = await saveCredential(
			{ name: 'SIEM token', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 's3cret' } },
			{ user: owner, role: 'credential:owner' },
		);
		const { id } = await addDestination(
			webhook({
				authentication: 'genericCredentialType',
				genericAuthType: 'httpHeaderAuth',
				credentials: { httpHeaderAuth: { id: credential.id, name: credential.name } },
			}),
		);

		await testServer.authAgentFor(owner).get(`/eventbus/testmessage?id=${id}`).expect(200);

		expect(received[0]?.headers['x-api-key']).toBe('s3cret');
	});
});

describe('delivery of the events of the event bus', () => {
	const eventBus = () => Container.get(MessageEventBus);

	it('delivers the subscribed events, and confirms each message', async () => {
		const confirm = vi.spyOn(eventBus(), 'confirmMessageDelivered');
		await addDestination(
			webhook({ enabled: true, subscribedEvents: ['n8n.audit'], anonymizeAuditMessages: true }),
		);

		await eventBus().sendAuditEvent({
			id: 'audit-1',
			eventName: 'n8n.audit.user.login.success',
			payload: { userId: owner.id, _email: owner.email },
		});
		await eventBus().sendWorkflowEvent({ id: 'workflow-1', eventName: 'n8n.workflow.started' });

		await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
		expect(received).toEqual([
			expect.objectContaining({
				body: expect.objectContaining({
					id: 'audit-1',
					eventName: 'n8n.audit.user.login.success',
					payload: { userId: owner.id, _email: '*' },
				}),
			}),
		]);
		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'audit-1' }),
			expect.objectContaining({ name: 'log-streaming' }),
		);
	});

	it('leaves a message unconfirmed when the destination does not take it', async () => {
		statusCode = 503;
		const confirm = vi.spyOn(eventBus(), 'confirmMessageDelivered');
		await addDestination(webhook({ enabled: true, subscribedEvents: ['*'] }));

		await eventBus().sendAuditEvent({ id: 'audit-2', eventName: 'n8n.audit.user.deleted' });

		await vi.waitFor(() => expect(received).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(confirm).not.toHaveBeenCalled();
	});

	it('sends nothing to a destination that is off', async () => {
		const confirm = vi.spyOn(eventBus(), 'confirmMessageDelivered');
		await addDestination(webhook({ enabled: false, subscribedEvents: ['*'] }));

		await eventBus().sendAuditEvent({ id: 'audit-3', eventName: 'n8n.audit.user.deleted' });

		await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(received).toEqual([]);
	});

	it('sends the events to a syslog server over UDP', async () => {
		const server: UdpSocket = createSocket('udp4');
		const datagram = new Promise<string>((resolve) =>
			server.once('message', (data) => resolve(data.toString())),
		);
		await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
		try {
			await addDestination({
				__type: '$$MessageEventBusDestinationSyslog',
				host: '127.0.0.1',
				port: server.address().port,
				protocol: 'udp',
				enabled: true,
				subscribedEvents: ['n8n.workflow'],
			});

			await eventBus().sendWorkflowEvent({ id: 'workflow-2', eventName: 'n8n.workflow.success' });

			expect(await datagram).toMatch(/^<134>1 .* n8n \d+ - - \{.*"id":"workflow-2"/);
		} finally {
			server.close();
		}
	});
});
