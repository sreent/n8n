import { createTeamProject } from '@n8n/backend-test-utils';
import type { Project, User } from '@n8n/db';
import { Container } from '@n8n/di';
import type { ICredentialType } from 'n8n-workflow';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
import { AiGatewayService } from '@/services/ai-gateway.service';
import { saveCredential } from '@test-integration/db/credentials';
import { createMember, createOwner } from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

import { AiGatewayProxyService } from '../ai-gateway-proxy.service';
import { AiGatewaySettingsService } from '../ai-gateway-settings.service';
import { AiGatewayVertexService, VertexSignInError } from '../ai-gateway-vertex.service';
import {
	AiGatewayTopUpRepository,
	AiGatewayUsageRepository,
	AiGatewayWalletRepository,
} from '../database/repositories/ai-gateway.repositories';

/**
 * Fork test (not in upstream n8n): the AI gateway module against in-memory provider servers. It
 * checks the settings, the tokens of `AiGatewayService`, the proxy of each API format, the prices
 * and the budgets. See `../README.md`.
 */

const testServer = setupTestServer({ endpointGroups: ['me', 'ai'], modules: ['ai-gateway'] });

interface ReceivedRequest {
	method: string;
	url: string;
	headers: IncomingMessage['headers'];
	body: Record<string, unknown>;
}

let provider: Server;
let providerUrl: string;

/** The models of Vertex AI on the in-memory server, for the project and the region of the test. */
const VERTEX_MODELS =
	'/vertex/v1/projects/vertex-project/locations/europe-west4/publishers/google/models/';

/** The Chat Completions of the open models of Vertex AI on the in-memory server. */
const VERTEX_CHAT_COMPLETIONS =
	'/vertex/v1/projects/vertex-project/locations/europe-west4/endpoints/openapi/chat/completions';
let received: ReceivedRequest[];

let owner: User;
let member: User;
let otherMember: User;
let teamProject: Project;
let otherProject: Project;
const credentialIds: Record<string, string> = {};

const sse = (res: ServerResponse, events: unknown[]) => {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
	res.end('data: [DONE]\n\n');
};

/** The provider APIs, under one server: `/openai`, `/anthropic`, `/google` and `/ollama`. */
function answer(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) {
	const path = new URL(req.url ?? '', 'http://provider').pathname;
	const json = (value: unknown) => {
		res.writeHead(200, {
			'content-type': 'application/json',
			'openai-organization': 'org-of-the-admin',
			'x-request-id': 'req-1',
		});
		res.end(JSON.stringify(value));
	};
	if (path === '/openai/v1/chat/completions') {
		if (body.stream === true) {
			const options = body.stream_options as { include_usage?: boolean } | undefined;
			return sse(res, [
				{ choices: [{ delta: { content: 'Hello' } }], usage: null },
				...(options?.include_usage
					? [{ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 1000 } }]
					: []),
			]);
		}
		return json({
			id: 'chatcmpl-1',
			model: body.model,
			choices: [{ message: { role: 'assistant', content: 'Hello' } }],
			usage: { prompt_tokens: 1000, completion_tokens: 500 },
		});
	}
	if (path === '/openai/v1/models') {
		return json({
			object: 'list',
			data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'dall-e-3' }, { id: 'unpriced-model' }],
		});
	}
	if (path === '/anthropic/v1/messages') {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write(
			`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3000, output_tokens: 1 } } })}\n\n`,
		);
		res.write(
			`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'Hi' } })}\n\n`,
		);
		res.end(
			`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 2000 } })}\n\n`,
		);
		return;
	}
	if (path === '/google/v1beta/models/gemini-2.5-flash:generateContent') {
		return json({
			candidates: [{ content: { parts: [{ text: 'Text of the scan' }] } }],
			usageMetadata: { promptTokenCount: 10000, candidatesTokenCount: 2000, thoughtsTokenCount: 0 },
		});
	}
	if (path === '/google/upload/v1beta/files') {
		res.writeHead(200, {
			'content-type': 'application/json',
			'x-goog-upload-url': `${providerUrl}/google/upload-session?upload_id=u1&key=upstream-key`,
		});
		res.end('{}');
		return;
	}
	if (path === '/google/v1beta/files/abc-123') {
		return json({ name: 'files/abc-123', state: 'ACTIVE', mimeType: 'application/pdf' });
	}
	if (path === '/azure/openai/v1/chat/completions') {
		if (body.stream === true) {
			const options = body.stream_options as { include_usage?: boolean } | undefined;
			return sse(res, [
				{ choices: [], prompt_filter_results: [] },
				{ choices: [{ delta: { content: 'Hello from Azure' } }] },
				...(options?.include_usage
					? [{ choices: [], usage: { prompt_tokens: 400, completion_tokens: 100 } }]
					: []),
			]);
		}
		return json({
			id: 'chatcmpl-azure',
			model: body.model,
			choices: [{ message: { role: 'assistant', content: 'Hello from Azure' } }],
			usage: { prompt_tokens: 1000, completion_tokens: 500 },
		});
	}
	if (path === '/vision/v1/images:annotate') {
		return json({
			responses: [
				{ fullTextAnnotation: { text: 'Scan' } },
				{ error: { code: 3, message: 'Bad image' } },
			],
		});
	}
	if (path === '/vision/v1/files:annotate') {
		return json({
			responses: [
				{ totalPages: 7, responses: [1, 2, 3].map((pageNumber) => ({ context: { pageNumber } })) },
			],
		});
	}
	if (path === '/documentai/v1/projects/acme/locations/eu/processors/abc123:process') {
		return json({ document: { text: 'Invoice', pages: [{}, {}] } });
	}
	if (path === VERTEX_CHAT_COMPLETIONS) {
		if (body.stream === true) {
			const options = body.stream_options as { include_usage?: boolean } | undefined;
			return sse(res, [
				{ choices: [{ delta: { content: 'Open model' } }] },
				...(options?.include_usage
					? [{ choices: [], usage: { prompt_tokens: 3000, completion_tokens: 1000 } }]
					: []),
			]);
		}
		return json({
			id: 'chatcmpl-vertex',
			model: body.model,
			choices: [{ message: { role: 'assistant', content: 'Open model' } }],
			usage: { prompt_tokens: 2000, completion_tokens: 1000 },
		});
	}
	if (path.startsWith(VERTEX_MODELS)) {
		const call = path.slice(VERTEX_MODELS.length);
		if (call === 'gemini-2.5-flash:generateContent') {
			return json({
				candidates: [{ content: { role: 'model', parts: [{ text: 'From Vertex' }] } }],
				usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 1000 },
			});
		}
		if (call === 'gemini-2.5-flash:streamGenerateContent') {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write(
				`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Fr' }] } }] })}\n\n`,
			);
			res.end(
				`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'om Vertex' }] } }], usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 2000 } })}\n\n`,
			);
			return;
		}
		if (call === 'gemini-embedding-001:embedContent') {
			const text = String(
				((body.content as { parts?: Array<{ text?: string }> } | undefined)?.parts ?? [])[0]?.text,
			);
			if (text === 'refused') {
				res.writeHead(429, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({ error: { code: 429, message: 'Quota', status: 'RESOURCE_EXHAUSTED' } }),
				);
				return;
			}
			return json({
				embedding: { values: [text.length] },
				usageMetadata: { promptTokenCount: 10 },
			});
		}
	}
	if (path === '/ollama/api/chat') {
		res.writeHead(200, { 'content-type': 'application/x-ndjson' });
		res.write(`${JSON.stringify({ message: { content: 'Hi' }, done: false })}\n`);
		res.end(`${JSON.stringify({ done: true, prompt_eval_count: 50, eval_count: 70 })}\n`);
		return;
	}
	res.writeHead(404, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ error: { message: `No route ${path}` } }));
}

/** The fields of the four credential types that the proxy reads. */
const credentialType = (name: string, fields: Record<string, string>): ICredentialType => ({
	name,
	displayName: name,
	properties: Object.entries(fields).map(([field, value]) => ({
		displayName: field,
		name: field,
		type: 'string',
		default: value,
	})),
});

beforeAll(async () => {
	Container.get(LoadNodesAndCredentials).loaded.credentials = Object.fromEntries(
		[
			credentialType('openAiApi', {
				apiKey: '',
				organizationId: '',
				url: 'https://api.openai.com/v1',
			}),
			credentialType('anthropicApi', { apiKey: '', url: 'https://api.anthropic.com' }),
			credentialType('googlePalmApi', {
				host: 'https://generativelanguage.googleapis.com',
				apiKey: '',
			}),
			credentialType('ollamaApi', { baseUrl: 'http://localhost:11434', apiKey: '' }),
			credentialType('azureOpenAiApi', {
				endpointType: 'classic',
				apiKey: '',
				resourceName: '',
				apiVersion: '2025-03-01-preview',
				endpoint: '',
			}),
			credentialType('googleApi', { region: 'global', email: '', privateKey: '' }),
			credentialType('googleCloudOcrApi', { apiKey: '', host: 'https://vision.googleapis.com' }),
		].map((type) => [type.name, { type, sourcePath: '' }]),
	);
	owner = await createOwner();
	member = await createMember();
	otherMember = await createMember();
	teamProject = await createTeamProject('Team A', owner);
	otherProject = await createTeamProject('Team B', owner);

	provider = createServer((req, res) => {
		let data = '';
		req.on('data', (chunk: Buffer) => (data += chunk.toString()));
		req.on('end', () => {
			const body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
			received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
			answer(req, res, body);
		});
	});
	await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
	providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

	const credentials = {
		openAiApi: { apiKey: 'sk-admin-openai', url: `${providerUrl}/openai/v1` },
		anthropicApi: { apiKey: 'sk-admin-anthropic', url: `${providerUrl}/anthropic` },
		googlePalmApi: { apiKey: 'admin-google-key', host: `${providerUrl}/google` },
		ollamaApi: { baseUrl: `${providerUrl}/ollama`, apiKey: '' },
		azureOpenAiApi: {
			endpointType: 'classic',
			apiKey: 'azure-admin-key',
			resourceName: 'acme',
			endpoint: `${providerUrl}/azure`,
		},
		googleCloudOcrApi: { apiKey: 'admin-vision-key', host: `${providerUrl}/vision` },
		googleApi: {
			region: 'europe-west4',
			email: 'gateway@vertex-project.iam.gserviceaccount.com',
			// The test replaces the sign-in, so the key is not used.
			privateKey: 'not used',
		},
	};
	for (const [type, data] of Object.entries(credentials)) {
		const credential = await saveCredential(
			{ name: `Admin ${type}`, type, data },
			{ user: owner, role: 'credential:owner' },
		);
		credentialIds[type] = credential.id;
	}
});

afterAll(async () => {
	await new Promise<void>((resolve) => provider.close(() => resolve()));
});

const defaultSettings = () => ({
	enabled: true,
	providers: {
		openai: { credentialId: credentialIds.openAiApi },
		anthropic: { credentialId: credentialIds.anthropicApi },
		google: { credentialId: credentialIds.googlePalmApi },
		ollama: { credentialId: credentialIds.ollamaApi },
	},
	monthlyBudget: 100,
	userMonthlyLimit: null,
	projectBudgets: {},
	prices: {},
});

async function saveSettings(settings: Record<string, unknown> = {}) {
	const response = await testServer
		.authAgentFor(owner)
		.put('/ai-gateway/settings')
		.send({ ...defaultSettings(), ...settings });
	expect(response.status).toBe(200);
}

beforeEach(async () => {
	// The test server resets the licence before each test.
	testServer.license.enable('feat:aiGateway');
	received = [];
	await Container.get(AiGatewayUsageRepository).clear();
	await Container.get(AiGatewayTopUpRepository).clear();
	await Container.get(AiGatewayWalletRepository).clear();
	await saveSettings();
	Container.get(AiGatewayProxyService).clearCredentialCache();
});

/** The token and the path of the proxy, as `AiGatewayService` gives them to a node. */
async function synthetic(
	credentialType: string,
	user: User = member,
	project: Project = teamProject,
) {
	const credential = await Container.get(AiGatewayService).getSyntheticCredential({
		credentialType,
		userId: user.id,
		workflowId: 'wf-1',
		projectId: project.id,
		executionId: '42',
	});
	const url = String(credential.url ?? credential.host ?? credential.baseUrl);
	return { token: String(credential.apiKey), path: new URL(url).pathname };
}

const usageRows = async () =>
	await Container.get(AiGatewayUsageRepository).find({ order: { createdAt: 'ASC' } });

describe('settings', () => {
	it('gives the settings only to users with the scope aiAssistant:manage', async () => {
		await testServer.authAgentFor(member).get('/ai-gateway/settings').expect(403);
		await testServer
			.authAgentFor(member)
			.put('/ai-gateway/settings')
			.send(defaultSettings())
			.expect(403);
		const response = await testServer.authAgentFor(owner).get('/ai-gateway/settings').expect(200);
		expect(response.body.data.settings.enabled).toBe(true);
		const openai = (
			response.body.data.providers as Array<{
				slug: string;
				credential: unknown;
				credentialOptions: unknown;
			}>
		).find((entry) => entry.slug === 'openai');
		expect(openai?.credential).toEqual({
			id: credentialIds.openAiApi,
			name: 'Admin openAiApi',
			type: 'openAiApi',
		});
		expect(openai?.credentialOptions).toEqual([
			{ id: credentialIds.azureOpenAiApi, name: 'Admin azureOpenAiApi', type: 'azureOpenAiApi' },
			{ id: credentialIds.googleApi, name: 'Admin googleApi', type: 'googleApi' },
			{ id: credentialIds.openAiApi, name: 'Admin openAiApi', type: 'openAiApi' },
		]);
		expect(response.body.data.projects).toEqual(
			expect.arrayContaining([
				{ id: teamProject.id, name: 'Team A' },
				{ id: otherProject.id, name: 'Team B' },
			]),
		);
	});

	it('refuses a credential of another type and an unknown provider', async () => {
		const agent = testServer.authAgentFor(owner);
		await agent
			.put('/ai-gateway/settings')
			.send({
				...defaultSettings(),
				providers: { openai: { credentialId: credentialIds.anthropicApi } },
			})
			.expect(400);
		await agent
			.put('/ai-gateway/settings')
			.send({
				...defaultSettings(),
				providers: { unknown: { credentialId: credentialIds.openAiApi } },
			})
			.expect(400);
	});

	it('gives the config of the configured providers through the ordinary route', async () => {
		const response = await testServer.authAgentFor(member).get('/ai/gateway/config').expect(200);
		expect(response.body.data.credentialTypes).toEqual([
			'openAiApi',
			'anthropicApi',
			'googlePalmApi',
			'ollamaApi',
		]);
		expect(response.body.data.providerConfig.openAiApi).toEqual({
			gatewayPath: '/v1/gateway/openai/v1',
			urlField: 'url',
			apiKeyField: 'apiKey',
		});
		expect(response.body.data.nodes).toContain('@n8n/n8n-nodes-langchain.lmChatOpenAi');
	});

	it('turns the gateway off', async () => {
		const { token, path } = await synthetic('openAiApi');
		await saveSettings({ enabled: false });
		expect(Container.get(AiGatewayService).isEnabled()).toBe(false);
		await testServer.authAgentFor(member).get('/ai/gateway/config').expect(400);
		const response = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o' })
			.expect(503);
		expect(response.body.error.message).toBe('The AI gateway is off.');
	});

	it('stops the proxy without the licence value', async () => {
		const { token, path } = await synthetic('openAiApi');
		testServer.license.disable('feat:aiGateway');
		await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o' })
			.expect(503);
		expect(received).toHaveLength(0);
	});
});

describe('proxy', () => {
	it('forwards an OpenAI call with the key of the admin, and records the cost', async () => {
		const { token, path } = await synthetic('openAiApi');
		expect(path).toBe(`/ai-gateway/v1/gateway/exec/42/wf-1%7C${teamProject.id}/openai/v1`);

		const response = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })
			.expect(200);

		expect(response.body.choices[0].message.content).toBe('Hello');
		expect(response.headers['x-request-id']).toBe('req-1');
		expect(response.headers['openai-organization']).toBeUndefined();
		expect(received).toHaveLength(1);
		expect(received[0].url).toBe('/openai/v1/chat/completions');
		expect(received[0].headers.authorization).toBe('Bearer sk-admin-openai');
		expect(JSON.stringify(received[0].headers)).not.toContain(token);

		const [row] = await usageRows();
		expect(row).toMatchObject({
			userId: member.id,
			projectId: teamProject.id,
			workflowId: 'wf-1',
			executionId: '42',
			provider: 'openai',
			model: 'gpt-4o',
			inputTokens: 1000,
			outputTokens: 500,
		});
		// 1000 × $2.50 + 500 × $10 for one million tokens.
		expect(row.cost).toBeCloseTo(0.0075);
	});

	it('asks for the usage of an OpenAI stream, and passes the events on', async () => {
		const { token, path } = await synthetic('openAiApi');
		const response = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o-mini', stream: true, messages: [] })
			.expect(200);

		expect(response.headers['content-type']).toContain('text/event-stream');
		expect(response.text).toContain('"content":"Hello"');
		expect(received[0].body.stream_options).toEqual({ include_usage: true });
		const [row] = await usageRows();
		expect(row).toMatchObject({ model: 'gpt-4o-mini', inputTokens: 2000, outputTokens: 1000 });
		expect(row.cost).toBeCloseTo((2000 * 0.15 + 1000 * 0.6) / 1e6);
	});

	it('lists only the models with a price', async () => {
		const { token, path } = await synthetic('openAiApi');
		const response = await testServer.restlessAgent
			.get(`${path}/models`)
			.set('authorization', `Bearer ${token}`)
			.expect(200);
		expect((response.body.data as Array<{ id: string }>).map(({ id }) => id)).toEqual([
			'gpt-4o',
			'gpt-4o-mini',
		]);
	});

	it('forwards an Anthropic stream with the key of the admin in x-api-key', async () => {
		const { token, path } = await synthetic('anthropicApi');
		const response = await testServer.restlessAgent
			.post(`${path}/v1/messages`)
			.set('x-api-key', token)
			.set('anthropic-version', '2023-06-01')
			.send({ model: 'claude-sonnet-4-5-20250929', stream: true, messages: [] })
			.expect(200);

		expect(response.text).toContain('message_delta');
		expect(received[0].headers['x-api-key']).toBe('sk-admin-anthropic');
		expect(received[0].headers['anthropic-version']).toBe('2023-06-01');
		const [row] = await usageRows();
		expect(row).toMatchObject({ provider: 'anthropic', inputTokens: 3000, outputTokens: 2000 });
		expect(row.cost).toBeCloseTo((3000 * 3 + 2000 * 15) / 1e6);
	});

	it('takes the token of a Gemini call from the key parameter, and sends the key of the admin', async () => {
		const { token, path } = await synthetic('googlePalmApi');
		await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-2.5-flash:generateContent?key=${token}`)
			.send({ contents: [{ parts: [{ text: 'Read the scan' }] }] })
			.expect(200);

		expect(received[0].url).toBe('/google/v1beta/models/gemini-2.5-flash:generateContent');
		expect(received[0].headers['x-goog-api-key']).toBe('admin-google-key');
		const [row] = await usageRows();
		expect(row).toMatchObject({
			provider: 'google',
			model: 'gemini-2.5-flash',
			inputTokens: 10000,
		});
		expect(row.cost).toBeCloseTo((10000 * 0.3 + 2000 * 2.5) / 1e6);
	});

	it('lets the analysis of Gemini upload a file, without a cost', async () => {
		const { token, path } = await synthetic('googlePalmApi');
		const start = await testServer.restlessAgent
			.post(`${path}/upload/v1beta/files?key=${token}`)
			.set('x-goog-upload-protocol', 'resumable')
			.set('x-goog-upload-command', 'start')
			.expect(200);
		expect(start.headers['x-goog-upload-url']).toBe(
			`${providerUrl}/google/upload-session?upload_id=u1`,
		);
		expect(received[0].headers['x-goog-upload-command']).toBe('start');
		expect(received[0].headers['x-goog-api-key']).toBe('admin-google-key');

		const file = await testServer.restlessAgent
			.get(`${path}/v1beta/files/abc-123?key=${token}`)
			.expect(200);
		expect(file.body.state).toBe('ACTIVE');
		expect(await usageRows()).toHaveLength(0);
	});

	it('meters an Ollama stream without a price', async () => {
		const { token, path } = await synthetic('ollamaApi');
		await testServer.restlessAgent
			.post(`${path}/api/chat`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'llama3.2', messages: [] })
			.expect(200);
		const [row] = await usageRows();
		expect(row).toMatchObject({ provider: 'ollama', inputTokens: 50, outputTokens: 70, cost: 0 });
		expect(received[0].headers.authorization).toBeUndefined();
	});

	it('refuses a call without a valid token, an unsupported endpoint and a model without a price', async () => {
		const { token, path } = await synthetic('openAiApi');
		const bad = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', 'Bearer not-a-token')
			.send({ model: 'gpt-4o' })
			.expect(401);
		expect(bad.body.error.message).toBe('The token of the AI gateway is not valid.');

		await testServer.restlessAgent
			.post(`${path}/images/generations`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'dall-e-3' })
			.expect(403);

		const unpriced = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'unpriced-model' })
			.expect(403);
		expect(unpriced.body.error.message).toBe(
			'The model unpriced-model has no price in the AI gateway. Ask an admin to add one.',
		);
		expect(received).toHaveLength(0);
	});

	it('uses a price of the admin', async () => {
		await saveSettings({ prices: { openai: { 'unpriced-model': { input: 1, output: 1 } } } });
		const { token, path } = await synthetic('openAiApi');
		await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'unpriced-model' })
			.expect(200);
		const [row] = await usageRows();
		expect(row.cost).toBeCloseTo((1000 + 500) / 1e6);
	});
});

describe('budgets', () => {
	const call = async (user: User = member, project: Project = teamProject) => {
		const { token, path } = await synthetic('openAiApi', user, project);
		return await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o' });
	};

	it('stops the calls when the monthly budget is spent, and pays with a top-up after it', async () => {
		// Each call costs $0.0075. The last call that starts within the budget can go over it.
		await saveSettings({ monthlyBudget: 0.005 });
		expect((await call()).status).toBe(200);
		const blocked = await call();
		expect(blocked.status).toBe(402);
		expect(blocked.body.error.message).toContain('The budget of the AI gateway is spent');

		await testServer
			.authAgentFor(owner)
			.post('/ai-gateway/top-ups')
			.send({ amount: 0.01 })
			.expect(200);
		expect((await call()).status).toBe(200);
		// The top-ups pay only as far as their balance goes.
		expect((await call()).status).toBe(200);
		expect((await call()).status).toBe(402);

		const rows = await usageRows();
		expect(rows.map((row) => row.costFromTopUp)).toEqual([0, 0.0075, 0.0025]);
		const topUps = await testServer.authAgentFor(owner).get('/ai-gateway/top-ups').expect(200);
		expect(topUps.body.data).toEqual([
			expect.objectContaining({ amount: 0.01, createdByEmail: owner.email, note: null }),
		]);
		const overview = await testServer.authAgentFor(owner).get('/ai-gateway/overview').expect(200);
		expect(overview.body.data).toMatchObject({
			monthlyBudget: 0.005,
			spentThisMonth: 0.0225,
			spentFromBudget: 0.0125,
			budgetLeft: 0,
			topUpBalance: 0,
			remaining: 0,
		});
	});

	it('stops the calls of a project when its monthly budget is spent', async () => {
		await saveSettings({ projectBudgets: { [teamProject.id]: 0.001 } });
		expect((await call(member, teamProject)).status).toBe(200);
		const blocked = await call(member, teamProject);
		expect(blocked.status).toBe(402);
		expect(blocked.body.error.message).toContain('budget of this project');
		expect((await call(member, otherProject)).status).toBe(200);
	});

	it('stops the calls of a user when the monthly limit is spent', async () => {
		await saveSettings({ userMonthlyLimit: 0.001 });
		expect((await call(member)).status).toBe(200);
		expect((await call(member)).status).toBe(402);
		expect((await call(otherMember)).status).toBe(200);
	});

	it('gives the wallet and the usage of a user through the ordinary routes', async () => {
		await saveSettings({ monthlyBudget: 10, userMonthlyLimit: 2 });
		await call(member);
		await call(otherMember);

		const wallet = await testServer.authAgentFor(member).get('/ai/gateway/wallet').expect(200);
		expect(wallet.body.data).toEqual({ budget: 2, balance: 1.9925, hasEverToppedUp: true });

		const own = await testServer.authAgentFor(member).get('/ai/gateway/usage').expect(200);
		expect(own.body.data.total).toBe(1);
		expect(own.body.data.entries[0]).toMatchObject({
			provider: 'openai',
			model: 'gpt-4o',
			metadata: { workflowId: 'wf-1', executionId: '42', projectId: teamProject.id },
		});

		const all = await testServer.authAgentFor(owner).get('/ai/gateway/usage').expect(200);
		expect(all.body.data.total).toBe(2);

		const admin = await testServer.authAgentFor(owner).get('/ai-gateway/usage').expect(200);
		expect(admin.body.data.count).toBe(2);
		expect(admin.body.data.entries[0].projectName).toBe('Team A');
	});
});

describe('backends', () => {
	const azureSettings = (deployments: string[] = ['gpt-4o']) => ({
		...defaultSettings().providers,
		openai: { credentialId: credentialIds.azureOpenAiApi, deployments },
	});
	const vertexSettings = (options: Record<string, string> = {}) => ({
		...defaultSettings().providers,
		google: { credentialId: credentialIds.googleApi, ...options },
	});

	let vertexOrigin: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		const vertex = Container.get(AiGatewayVertexService);
		vertexOrigin = vi.spyOn(vertex, 'origin').mockReturnValue(`${providerUrl}/vertex`);
		vi.spyOn(vertex, 'accessToken').mockResolvedValue('vertex-access-token');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('offers the credentials of the backends, and keeps only the options of the picked backend', async () => {
		const agent = testServer.authAgentFor(owner);
		const before = await agent.get('/ai-gateway/settings').expect(200);
		const google = (
			before.body.data.providers as Array<{
				slug: string;
				backends: unknown;
				credentialOptions: unknown;
			}>
		).find((entry) => entry.slug === 'google');
		expect(google?.backends).toEqual([
			{ kind: 'vertex-ai', credentialType: 'googleApi', displayName: 'Vertex AI' },
		]);
		expect(google?.credentialOptions).toEqual(
			expect.arrayContaining([
				{ id: credentialIds.googleApi, name: 'Admin googleApi', type: 'googleApi' },
			]),
		);

		await saveSettings({
			providers: {
				openai: {
					credentialId: credentialIds.azureOpenAiApi,
					deployments: ['gpt-4o', 'gpt-4o', 'chat-prod'],
					projectId: 'not-for-azure',
				},
				google: { credentialId: credentialIds.googleApi, projectId: 'acme-ai', location: 'us' },
				anthropic: { credentialId: credentialIds.anthropicApi, deployments: ['not-for-anthropic'] },
			},
		});
		const { providers } = Container.get(AiGatewaySettingsService).current();
		expect(providers).toEqual({
			openai: {
				credentialId: credentialIds.azureOpenAiApi,
				credentialType: 'azureOpenAiApi',
				deployments: ['gpt-4o', 'chat-prod'],
			},
			google: {
				credentialId: credentialIds.googleApi,
				credentialType: 'googleApi',
				projectId: 'acme-ai',
				location: 'us',
			},
			anthropic: { credentialId: credentialIds.anthropicApi, credentialType: 'anthropicApi' },
		});

		await agent
			.put('/ai-gateway/settings')
			.send({ ...defaultSettings(), providers: vertexSettings({ projectId: 'Acme/../x' }) })
			.expect(400);
		await agent
			.put('/ai-gateway/settings')
			.send({ ...defaultSettings(), providers: azureSettings(['bad deployment']) })
			.expect(400);
	});

	it('sends OpenAI calls to Azure OpenAI with the api-key of the admin', async () => {
		await saveSettings({ providers: azureSettings() });
		const { token, path } = await synthetic('openAiApi');

		const response = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })
			.expect(200);

		expect(response.body.choices[0].message.content).toBe('Hello from Azure');
		expect(received[0].url).toBe('/azure/openai/v1/chat/completions');
		expect(received[0].headers['api-key']).toBe('azure-admin-key');
		expect(received[0].headers.authorization).toBeUndefined();
		const [row] = await usageRows();
		expect(row).toMatchObject({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000 });
		expect(row.cost).toBeCloseTo(0.0075);
	});

	it('asks Azure OpenAI for the usage of a stream', async () => {
		await saveSettings({ providers: azureSettings() });
		const { token, path } = await synthetic('openAiApi');
		const response = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o', stream: true, messages: [] })
			.expect(200);

		expect(response.text).toContain('Hello from Azure');
		expect(received[0].body.stream_options).toEqual({ include_usage: true });
		const [row] = await usageRows();
		expect(row).toMatchObject({ inputTokens: 400, outputTokens: 100 });
	});

	it('lists the deployments of Azure OpenAI that have a price', async () => {
		await saveSettings({
			providers: azureSettings(['gpt-4o', 'chat-prod', 'no-price']),
			prices: { openai: { 'chat-prod': { input: 1, output: 2 } } },
		});
		const { token, path } = await synthetic('openAiApi');
		const response = await testServer.restlessAgent
			.get(`${path}/models`)
			.set('authorization', `Bearer ${token}`)
			.expect(200);

		expect((response.body.data as Array<{ id: string }>).map(({ id }) => id)).toEqual([
			'gpt-4o',
			'chat-prod',
		]);
		expect(received).toHaveLength(0);
	});

	it('sends Gemini calls to Vertex AI with a token of the service account', async () => {
		await saveSettings({ providers: vertexSettings() });
		const { token, path } = await synthetic('googlePalmApi');

		const response = await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-2.5-flash:generateContent?key=${token}`)
			.send({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] })
			.expect(200);

		expect(response.body.candidates[0].content.parts[0].text).toBe('From Vertex');
		expect(vertexOrigin).toHaveBeenCalledWith('europe-west4');
		expect(received[0].url).toBe(`${VERTEX_MODELS}gemini-2.5-flash:generateContent`);
		expect(received[0].headers.authorization).toBe('Bearer vertex-access-token');
		expect(received[0].headers['x-goog-api-key']).toBeUndefined();
		const [row] = await usageRows();
		expect(row).toMatchObject({ provider: 'google', model: 'gemini-2.5-flash', inputTokens: 8000 });
		expect(row.cost).toBeCloseTo((8000 * 0.3 + 1000 * 2.5) / 1e6);
	});

	it('passes a Gemini stream through Vertex AI', async () => {
		await saveSettings({ providers: vertexSettings() });
		const { token, path } = await synthetic('googlePalmApi');
		const response = await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`)
			.set('x-goog-api-key', token)
			.send({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] })
			.expect(200);

		expect(response.text).toContain('om Vertex');
		expect(received[0].url).toBe(`${VERTEX_MODELS}gemini-2.5-flash:streamGenerateContent?alt=sse`);
		const [row] = await usageRows();
		expect(row).toMatchObject({ inputTokens: 4000, outputTokens: 2000 });
	});

	it('uses the project and the location of the settings', async () => {
		await saveSettings({ providers: vertexSettings({ projectId: 'acme-ai', location: 'us' }) });
		const { token, path } = await synthetic('googlePalmApi');
		await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-2.5-flash:countTokens?key=${token}`)
			.send({ contents: [] });

		expect(vertexOrigin).toHaveBeenCalledWith('us');
		expect(received[0].url).toBe(
			'/vertex/v1/projects/acme-ai/locations/us/publishers/google/models/gemini-2.5-flash:countTokens',
		);
	});

	it('sends Gemini embeddings to Vertex AI, and splits a batch into single calls', async () => {
		await saveSettings({ providers: vertexSettings() });
		const { token, path } = await synthetic('googlePalmApi');
		const request = (text: string) => ({
			model: 'models/gemini-embedding-001',
			content: { parts: [{ text }] },
			taskType: 'RETRIEVAL_DOCUMENT',
		});

		const single = await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-embedding-001:embedContent?key=${token}`)
			.send(request('hello'))
			.expect(200);
		expect(single.body.embedding.values).toEqual([5]);
		expect(received[0].body).toEqual({
			content: { parts: [{ text: 'hello' }] },
			taskType: 'RETRIEVAL_DOCUMENT',
		});

		received = [];
		const batch = await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${token}`)
			.send({ requests: [request('a'), request('bb'), request('ccc')] })
			.expect(200);
		expect(batch.body).toEqual({ embeddings: [{ values: [1] }, { values: [2] }, { values: [3] }] });
		expect(received.map(({ url }) => url)).toEqual(
			new Array(3).fill(`${VERTEX_MODELS}gemini-embedding-001:embedContent`),
		);
		const rows = await usageRows();
		expect(rows.map((row) => row.inputTokens)).toEqual([10, 30]);
	});

	it('records the calls of a batch that worked, and gives the error of Vertex AI', async () => {
		await saveSettings({ providers: vertexSettings() });
		const { token, path } = await synthetic('googlePalmApi');
		const request = (text: string) => ({ content: { parts: [{ text }] } });
		const response = await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${token}`)
			.send({ requests: [request('a'), request('refused')] })
			.expect(429);

		expect(response.body.error.status).toBe('RESOURCE_EXHAUSTED');
		const [row] = await usageRows();
		expect(row.inputTokens).toBe(10);
	});

	it('answers the model list of Vertex AI from the prices, and refuses the File API', async () => {
		await saveSettings({ providers: vertexSettings() });
		const { token, path } = await synthetic('googlePalmApi');

		const list = await testServer.restlessAgent
			.get(`${path}/v1beta/models`)
			.set('x-goog-api-key', token)
			.expect(200);
		const names = (list.body.models as Array<{ name: string }>).map(({ name }) => name);
		expect(names).toEqual(
			expect.arrayContaining(['models/gemini-2.5-flash', 'models/gemini-embedding-001']),
		);
		const details = await testServer.restlessAgent
			.get(`${path}/v1beta/models/gemini-2.5-pro`)
			.set('x-goog-api-key', token)
			.expect(200);
		expect(details.body.name).toBe('models/gemini-2.5-pro');

		const upload = await testServer.restlessAgent
			.post(`${path}/upload/v1beta/files`)
			.set('x-goog-api-key', token)
			.send({ file: { display_name: 'scan.pdf' } })
			.expect(403);
		expect(upload.body.error.message).toContain('no File API');
		expect(received).toHaveLength(0);

		const config = await testServer.authAgentFor(member).get('/ai/gateway/config').expect(200);
		expect(config.body.data.supportedActions['@n8n/n8n-nodes-langchain.googleGemini']).toEqual({
			text: ['message'],
		});
	});

	const openModelPrices = {
		openai: { 'meta/llama-3.3-70b-instruct-maas': { input: 0.72, output: 0.72 } },
	};

	it('sends all calls of the OpenAI nodes to the open models of Vertex AI', async () => {
		await saveSettings({
			providers: {
				...defaultSettings().providers,
				openai: { credentialId: credentialIds.googleApi },
			},
			prices: openModelPrices,
		});
		const { token, path } = await synthetic('openAiApi');

		const response = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'meta/llama-3.3-70b-instruct-maas', messages: [] })
			.expect(200);
		expect(response.body.choices[0].message.content).toBe('Open model');
		expect(received[0].url).toBe(VERTEX_CHAT_COMPLETIONS);
		expect(received[0].headers.authorization).toBe('Bearer vertex-access-token');
		const [row] = await usageRows();
		expect(row).toMatchObject({ provider: 'openai', model: 'meta/llama-3.3-70b-instruct-maas' });
		expect(row.cost).toBeCloseTo((3000 * 0.72) / 1e6);

		const responses = await testServer.restlessAgent
			.post(`${path}/responses`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'meta/llama-3.3-70b-instruct-maas', input: 'Hi' })
			.expect(403);
		expect(responses.body.error.message).toContain('Use Responses API');

		const list = await testServer.restlessAgent
			.get(`${path}/models`)
			.set('authorization', `Bearer ${token}`)
			.expect(200);
		expect(list.body.data).toEqual([
			{
				id: 'meta/llama-3.3-70b-instruct-maas',
				object: 'model',
				created: 0,
				owned_by: 'vertex-ai',
			},
		]);
	});

	it('sends the models of a publisher to Vertex AI, and the other models to OpenAI', async () => {
		await saveSettings({
			providers: {
				...defaultSettings().providers,
				openai: {
					credentialId: credentialIds.openAiApi,
					openModels: { credentialId: credentialIds.googleApi },
				},
			},
			prices: openModelPrices,
		});
		const { token, path } = await synthetic('openAiApi');

		await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'gpt-4o', messages: [] })
			.expect(200);
		const stream = await testServer.restlessAgent
			.post(`${path}/chat/completions`)
			.set('authorization', `Bearer ${token}`)
			.send({ model: 'meta/llama-3.3-70b-instruct-maas', stream: true, messages: [] })
			.expect(200);

		expect(stream.text).toContain('Open model');
		expect(received.map(({ url }) => url)).toEqual([
			'/openai/v1/chat/completions',
			VERTEX_CHAT_COMPLETIONS,
		]);
		expect(received[0].headers.authorization).toBe('Bearer sk-admin-openai');
		expect(received[1].headers.authorization).toBe('Bearer vertex-access-token');
		expect(received[1].body.stream_options).toEqual({ include_usage: true });
		const rows = await usageRows();
		expect(rows.map(({ model, inputTokens }) => [model, inputTokens])).toEqual([
			['gpt-4o', 1000],
			['meta/llama-3.3-70b-instruct-maas', 3000],
		]);

		received = [];
		const list = await testServer.restlessAgent
			.get(`${path}/models`)
			.set('authorization', `Bearer ${token}`)
			.expect(200);
		expect((list.body.data as Array<{ id: string }>).map(({ id }) => id)).toEqual([
			'gpt-4o',
			'gpt-4o-mini',
			'meta/llama-3.3-70b-instruct-maas',
		]);
	});

	it('keeps the open models only behind an OpenAI or Azure credential', async () => {
		await saveSettings({
			providers: {
				...defaultSettings().providers,
				openai: {
					credentialId: credentialIds.googleApi,
					openModels: { credentialId: credentialIds.googleApi },
				},
				anthropic: {
					credentialId: credentialIds.anthropicApi,
					openModels: { credentialId: credentialIds.googleApi },
				},
			},
		});
		const { providers } = Container.get(AiGatewaySettingsService).current();
		expect(providers.openai).toEqual({
			credentialId: credentialIds.googleApi,
			credentialType: 'googleApi',
		});
		expect(providers.anthropic).toEqual({
			credentialId: credentialIds.anthropicApi,
			credentialType: 'anthropicApi',
		});

		await testServer
			.authAgentFor(owner)
			.put('/ai-gateway/settings')
			.send({
				...defaultSettings(),
				providers: {
					openai: {
						credentialId: credentialIds.openAiApi,
						openModels: { credentialId: credentialIds.azureOpenAiApi },
					},
				},
			})
			.expect(400);
	});

	it('refuses a call when Vertex AI does not accept the sign-in', async () => {
		await saveSettings({ providers: vertexSettings() });
		vi.spyOn(Container.get(AiGatewayVertexService), 'accessToken').mockRejectedValue(
			new VertexSignInError('invalid_grant'),
		);
		const { token, path } = await synthetic('googlePalmApi');
		const response = await testServer.restlessAgent
			.post(`${path}/v1beta/models/gemini-2.5-flash:generateContent?key=${token}`)
			.send({ contents: [] })
			.expect(503);
		expect(response.body.error.message).toBe(
			'The AI gateway could not sign in to Google Cloud with the credential of the admin.',
		);
		expect(received).toHaveLength(0);
	});
});

describe('Google Cloud OCR', () => {
	const ocrRequest = (type = 'DOCUMENT_TEXT_DETECTION') => ({
		image: { content: 'c2Nhbg==' },
		features: [{ type }],
	});
	const ocrNode = 'n8n-nodes-base.googleCloudOcr';

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reads text through the Cloud Vision API with the API key of the admin, and counts the images', async () => {
		await saveSettings({
			providers: {
				...defaultSettings().providers,
				'google-ocr': { credentialId: credentialIds.googleCloudOcrApi },
			},
		});
		const { token, path } = await synthetic('googleCloudOcrApi');

		const response = await testServer.restlessAgent
			.post(`${path}/v1/images:annotate`)
			.set('x-goog-api-key', token)
			.send({ requests: [ocrRequest(), ocrRequest()] })
			.expect(200);

		expect(response.body.responses[0].fullTextAnnotation.text).toBe('Scan');
		expect(received[0].url).toBe('/vision/v1/images:annotate');
		expect(received[0].headers['x-goog-api-key']).toBe('admin-vision-key');
		const [row] = await usageRows();
		expect(row).toMatchObject({ provider: 'google-ocr', model: 'vision-ocr', inputTokens: 1 });
		expect(row.cost).toBeCloseTo(0.0015);

		const config = await testServer.authAgentFor(member).get('/ai/gateway/config').expect(200);
		expect(config.body.data.nodes).toContain(ocrNode);
		expect(config.body.data.supportedActions[ocrNode]).toEqual({
			__operation_only__: ['readText'],
		});
	});

	it('refuses other features of the Cloud Vision API, and Document AI with an API key', async () => {
		await saveSettings({
			providers: {
				...defaultSettings().providers,
				'google-ocr': { credentialId: credentialIds.googleCloudOcrApi },
			},
		});
		const { token, path } = await synthetic('googleCloudOcrApi');

		const features = await testServer.restlessAgent
			.post(`${path}/v1/images:annotate`)
			.set('x-goog-api-key', token)
			.send({ requests: [ocrRequest('LABEL_DETECTION')] })
			.expect(403);
		expect(features.body.error.message).toContain('one text detection');
		const documentAi = await testServer.restlessAgent
			.post(`${path}/v1/projects/acme/locations/eu/processors/abc123:process`)
			.set('x-goog-api-key', token)
			.send({ rawDocument: { content: 'c2Nhbg==', mimeType: 'application/pdf' } })
			.expect(403);
		expect(documentAi.body.error.message).toContain('Document AI takes no API keys');
		expect(received).toHaveLength(0);
	});

	it('reads files and processes documents with a service account, and counts the pages', async () => {
		await saveSettings({
			providers: {
				...defaultSettings().providers,
				'google-ocr': { credentialId: credentialIds.googleApi },
			},
		});
		const google = Container.get(AiGatewayVertexService);
		vi.spyOn(google, 'accessToken').mockResolvedValue('ocr-access-token');
		vi.spyOn(google, 'visionOrigin').mockReturnValue(`${providerUrl}/vision`);
		const documentAiOrigin = vi
			.spyOn(google, 'documentAiOrigin')
			.mockReturnValue(`${providerUrl}/documentai`);
		const { token, path } = await synthetic('googleCloudOcrApi');

		await testServer.restlessAgent
			.post(`${path}/v1/files:annotate`)
			.set('x-goog-api-key', token)
			.send({
				requests: [
					{
						inputConfig: { content: 'c2Nhbg==', mimeType: 'application/pdf' },
						features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
					},
				],
			})
			.expect(200);
		const document = await testServer.restlessAgent
			.post(`${path}/v1/projects/acme/locations/eu/processors/abc123:process`)
			.set('x-goog-api-key', token)
			.send({ rawDocument: { content: 'c2Nhbg==', mimeType: 'application/pdf' } })
			.expect(200);

		expect(document.body.document.text).toBe('Invoice');
		expect(documentAiOrigin).toHaveBeenCalledWith('eu');
		expect(received.map(({ url }) => url)).toEqual([
			'/vision/v1/files:annotate',
			'/documentai/v1/projects/acme/locations/eu/processors/abc123:process',
		]);
		expect(
			received.every(({ headers }) => headers.authorization === 'Bearer ocr-access-token'),
		).toBe(true);
		const rows = await usageRows();
		expect(rows.map(({ model, inputTokens }) => [model, inputTokens])).toEqual([
			['vision-ocr', 3],
			['document-ai', 2],
		]);

		const config = await testServer.authAgentFor(member).get('/ai/gateway/config').expect(200);
		expect(config.body.data.supportedActions[ocrNode]).toEqual({
			__operation_only__: ['readText', 'processDocument'],
		});
	});
});

describe('settings service', () => {
	it('keeps the settings that it saved', async () => {
		await saveSettings({ monthlyBudget: 42 });
		expect(Container.get(AiGatewaySettingsService).current().monthlyBudget).toBe(42);
		expect((await Container.get(AiGatewaySettingsService).reload()).monthlyBudget).toBe(42);
	});
});
