import { ModuleRegistry } from '@n8n/backend-common';
import { InstanceSettingsLoaderConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMemberWithApiKey, createOwnerWithApiKey } from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

import { EventDestinationRepository } from '../database/event-destination.repository';
import { LogStreamingService } from '../log-streaming.service';

// The global test setup mocks the event bus, which the module listens to.
vi.unmock('@/eventbus/message-event-bus/message-event-bus');

const testServer = setupTestServer({
	endpointGroups: ['publicApi'],
	enabledFeatures: ['feat:logStreaming'],
	modules: ['log-streaming'],
});

const BASE = '/settings/log-streaming';
const UNKNOWN_ID = '3f1b8a52-6e7c-4f0e-9a51-2d9c7f8e1a20';

let owner: User;
let member: User;

/** A webhook receiver on the loopback interface. */
let receiver: Server;
let receiverUrl: string;
let statusCode: number;

beforeAll(async () => {
	owner = await createOwnerWithApiKey();
	member = await createMemberWithApiKey();
	receiver = createServer((req, res) => {
		req.resume();
		req.on('end', () => res.writeHead(statusCode).end('ok'));
	});
	await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
	receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

beforeEach(async () => {
	statusCode = 200;
	Container.get(InstanceSettingsLoaderConfig).logStreamingManagedByEnv = false;
	await Container.get(EventDestinationRepository).clear();
	await Container.get(LogStreamingService).loadDestinations();
	vi.restoreAllMocks();
});

const ownerAgent = () => testServer.publicApiAgentFor(owner);

async function createWebhook(body: Record<string, unknown> = {}) {
	const response = await ownerAgent()
		.post(`${BASE}/destinations`)
		.send({ type: 'webhook', url: receiverUrl, label: 'SIEM', ...body });
	expect(response.status).toBe(200);
	return response.body as { id: string; type: string; enabled: boolean };
}

describe('GET /settings/log-streaming/event-types', () => {
	it('lists the names of the events', async () => {
		const response = await ownerAgent().get(`${BASE}/event-types`).expect(200);

		expect(response.body.data).toEqual(expect.arrayContaining(['n8n.workflow.success']));
	});
});

describe('destinations', () => {
	it('creates a destination that is off, and gives it in the public format', async () => {
		const created = await createWebhook({ subscribedEvents: ['n8n.audit'] });

		expect(created).toEqual({
			id: expect.any(String),
			type: 'webhook',
			label: 'SIEM',
			url: receiverUrl,
			enabled: false,
			subscribedEvents: ['n8n.audit'],
			anonymizeAuditMessages: false,
			method: 'POST',
			sendQuery: false,
			sendHeaders: false,
			specifyHeaders: '',
			specifyQuery: '',
			jsonQuery: '',
			jsonHeaders: '',
			headerParameters: { parameters: [] },
			queryParameters: { parameters: [] },
			options: {},
		});

		const list = await ownerAgent().get(`${BASE}/destinations`).expect(200);
		expect(list.body).toEqual({ data: [created] });
		const one = await ownerAgent().get(`${BASE}/destinations/${created.id}`).expect(200);
		expect(one.body).toEqual(created);
		await ownerAgent().get(`${BASE}/destinations/${UNKNOWN_ID}`).expect(404);
	});

	it('rejects a body that is not valid', async () => {
		await ownerAgent().post(`${BASE}/destinations`).send({ type: 'syslog' }).expect(400);
		await ownerAgent()
			.post(`${BASE}/destinations`)
			.send({ type: 'webhook', url: receiverUrl, method: 'TRACE' })
			.expect(400);
	});

	it('changes the fields of the body, and keeps the other fields', async () => {
		const { id } = await createWebhook({ subscribedEvents: ['n8n.audit'] });

		const response = await ownerAgent()
			.put(`${BASE}/destinations/${id}`)
			.send({ type: 'webhook', url: receiverUrl, label: 'Changed', enabled: true })
			.expect(200);

		expect(response.body).toMatchObject({
			id,
			label: 'Changed',
			enabled: true,
			subscribedEvents: ['n8n.audit'],
		});
		await ownerAgent()
			.put(`${BASE}/destinations/${UNKNOWN_ID}`)
			.send({ type: 'webhook', url: receiverUrl })
			.expect(404);
	});

	it('tests a destination', async () => {
		const { id } = await createWebhook();

		const success = await ownerAgent().post(`${BASE}/destinations/${id}/test`).expect(200);
		expect(success.body).toEqual({ success: true });

		statusCode = 500;
		const failure = await ownerAgent().post(`${BASE}/destinations/${id}/test`).expect(200);
		expect(failure.body).toEqual({ success: false });

		await ownerAgent().post(`${BASE}/destinations/${UNKNOWN_ID}/test`).expect(404);
	});

	it('deletes a destination, and gives it', async () => {
		const created = await createWebhook();

		const response = await ownerAgent().delete(`${BASE}/destinations/${created.id}`).expect(200);

		expect(response.body).toEqual(created);
		await ownerAgent().delete(`${BASE}/destinations/${created.id}`).expect(404);
	});

	it('rejects changes with 409 while the environment manages the destinations', async () => {
		const { id } = await createWebhook();
		Container.get(InstanceSettingsLoaderConfig).logStreamingManagedByEnv = true;

		await ownerAgent()
			.post(`${BASE}/destinations`)
			.send({ type: 'webhook', url: receiverUrl })
			.expect(409);
		await ownerAgent()
			.put(`${BASE}/destinations/${id}`)
			.send({ type: 'webhook', url: receiverUrl })
			.expect(409);
		await ownerAgent().delete(`${BASE}/destinations/${id}`).expect(409);
		await ownerAgent().get(`${BASE}/destinations/${id}`).expect(200);
	});
});

describe('access', () => {
	it('needs the scope of each route on the API key', async () => {
		const { id } = await createWebhook();
		const agent = testServer.publicApiAgentFor(member);

		await agent
			.post(`${BASE}/destinations`)
			.send({ type: 'webhook', url: receiverUrl })
			.expect(403);
		await agent
			.put(`${BASE}/destinations/${id}`)
			.send({ type: 'webhook', url: receiverUrl })
			.expect(403);
		await agent.delete(`${BASE}/destinations/${id}`).expect(403);
		await agent.get(`${BASE}/destinations/${id}`).expect(403);
	});

	it('answers 403 without the licence value, as upstream n8n does', async () => {
		testServer.license.disable('feat:logStreaming');
		try {
			const response = await ownerAgent().get(`${BASE}/destinations`).expect(403);

			expect(response.body.message).toContain('feat:logStreaming');
		} finally {
			testServer.license.enable('feat:logStreaming');
		}
	});

	it('answers 503 while the module is off, as the promotions routes do', async () => {
		vi.spyOn(Container.get(ModuleRegistry), 'isActive').mockReturnValue(false);

		const response = await ownerAgent().get(`${BASE}/destinations`).expect(503);

		expect(response.body.message).toBe('The log streaming module is not enabled');
	});
});
