// Fork test (not in upstream n8n): the HTTP endpoints of dynamic credentials as a black box: the
// execution status of a workflow, the start of an authorization, the authorization links, the
// revoke, the removal of the own connection, CORS and the endpoint token. The test uses a fake
// OAuth2 provider for the token exchange of the ordinary OAuth2 callback, and records the answers,
// the rendered templates, the stored entries (decrypted), the requests to the provider and the
// events. The snapshot was recorded against the enterprise module, and the fork module gives the
// same snapshot. See `packages/cli/src/modules/dynamic-credentials/README.md`.
import { Logger, ModuleRegistry } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import {
	createTeamProject,
	createWorkflow,
	linkUserToProject,
	testDb,
} from '@n8n/backend-test-utils';
import type { CredentialsEntity, Project, User } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { ControllerRegistryMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { response as Response } from 'express';
import { Cipher, ExecutionContextHookRegistry } from 'n8n-core';
import { OAuth2Api } from 'n8n-nodes-base/credentials/OAuth2Api.credentials';
import type { DynamicCredentialCheckProxyProvider, ICredentialContext, INode } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { DynamicCredentialsProxy } from '@/credentials/dynamic-credentials-proxy';
import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
import { saveCredential } from '@test-integration/db/credentials';
import { createMember, createOwner } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { FakeIdentityProvider } from './fake-identity-provider';

vi.hoisted(() => {
	process.env.N8N_ENV_FEAT_DYNAMIC_CREDENTIALS = 'true';
	process.env.N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN = 'endpoint-token';
	process.env.N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN = 'https://app.example.com';
	process.env.N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS = 'true';
	process.env.N8N_DYNAMIC_CREDENTIALS_RATE_LIMIT_PER_MINUTE = '5';
	process.env.N8N_DYNAMIC_CREDENTIALS_AUTHORIZE_RATE_LIMIT_PER_MINUTE = '4';
});

const testServer = utils.setupTestServer({
	endpointGroups: ['credentials', 'workflows', 'oauth2'],
	modules: ['dynamic-credentials'],
	enabledFeatures: [
		'feat:dynamicCredentials',
		'feat:sharing',
		'feat:projectRole:admin',
		'feat:projectRole:editor',
	],
	quotas: { 'quota:maxTeamProjects': -1 },
});

const rec = new GoldenRecorder();
const idp = new FakeIdentityProvider();
let owner: User;
let member: User;
let outsider: User;
let ownerAgent: SuperAgentTest;
let memberAgent: SuperAgentTest;
let outsiderAgent: SuperAgentTest;
let project: Project;
let oauthResolver: string;
let privateCredential: CredentialsEntity;
let boundCredential: CredentialsEntity;
let staticCredential: CredentialsEntity;
const workflows: Record<string, string> = {};

const SYSTEM = 'system-n8n';
const TOKEN = 'Bearer endpoint-token';
const RAW_TOKEN = 'endpoint-token';
const ORIGIN = 'https://app.example.com';

// #region Recording

const events: unknown[][] = [];
const renders: unknown[][] = [];

type LogMock = { mock?: { calls: unknown[][] }; mockClear?: () => void };

function takeLogs() {
	const root = Container.get(Logger) as unknown as Record<string, LogMock> & {
		scoped?: () => Record<string, LogMock>;
	};
	const scoped = typeof root.scoped === 'function' ? root.scoped() : undefined;
	const result: unknown[] = [];
	for (const source of [root, scoped]) {
		if (!source) continue;
		for (const level of ['error', 'warn']) {
			const method = source[level];
			if (!method?.mock) continue;
			for (const call of method.mock.calls) {
				result.push([level, label(String(call[0]).split('\n')[0])]);
			}
			method.mockClear?.();
		}
	}
	return result;
}

/** Labels, and placeholders for the random parts of URLs. */
function label(text: string) {
	return idp
		.label(rec.labelString(text))
		.replace(/\b(state|token|code_challenge)=[^&"\s]+/g, '$1=<random>')
		.replace(/(%3F|%26)(state|token)%3D[^&"\s%]+/g, '$1$2%3D<random>');
}

/** A user as its label, for event payloads. */
function brief(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(brief);
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.email === 'string' && typeof record.id === 'string') {
			return `<user ${rec.labelString(record.id)}>`;
		}
		return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, brief(entry)]));
	}
	return value;
}

function clean(value: unknown): unknown {
	if (typeof value === 'string') return label(value);
	if (Array.isArray(value)) return value.map(clean);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				key === 'n8n_expires_at' ? '<time>' : clean(entry),
			]),
		);
	}
	return value;
}

async function decrypt(value: unknown) {
	if (typeof value !== 'string') return value;
	try {
		const plain = await Container.get(Cipher).decryptV2(value);
		try {
			return JSON.parse(plain) as unknown;
		} catch {
			return `<text ${plain}>`;
		}
	} catch {
		return `<unreadable ${value.slice(0, 12)}>`;
	}
}

async function state() {
	const query = async (sql: string) =>
		await Container.get(WorkflowRepository).manager.query<Array<Record<string, unknown>>>(sql);
	const line = (value: unknown) => JSON.stringify(clean(rec.normalize(value)));
	return {
		entries: (
			await Promise.all(
				(
					await query('SELECT * FROM dynamic_credential_entry')
				).map(async (row) =>
					line({
						credential: row.credential_id,
						subject: row.subject_id,
						resolver: row.resolver_id,
						data: await decrypt(row.data),
					}),
				),
			)
		).sort(),
		userEntries: (
			await Promise.all(
				(
					await query('SELECT * FROM dynamic_credential_user_entry')
				).map(async (row) =>
					line({
						credential: row.credentialId,
						user: row.userId,
						resolver: row.resolverId,
						data: await decrypt(row.data),
					}),
				),
			)
		).sort(),
	};
}

type State = Awaited<ReturnType<typeof state>>;

function diff(before: State, after: State) {
	const changes: Record<string, unknown> = {};
	for (const key of Object.keys(after) as Array<keyof State>) {
		const removed = before[key].filter((line) => !after[key].includes(line));
		const added = after[key].filter((line) => !before[key].includes(line));
		if (removed.length || added.length) {
			changes[key] = {
				...(removed.length ? { removed } : {}),
				...(added.length ? { added } : {}),
			};
		}
	}
	return changes;
}

const RECORDED_HEADERS = [
	'location',
	'access-control-allow-origin',
	'access-control-allow-credentials',
	'access-control-allow-methods',
	'access-control-allow-headers',
	'access-control-max-age',
	'vary',
	'retry-after',
	'x-ratelimit-limit',
	'ratelimit-limit',
];

type HttpResponse = {
	status: number;
	body: unknown;
	text?: string;
	headers: Record<string, unknown>;
};

function answer(response: HttpResponse) {
	const headers = Object.fromEntries(
		RECORDED_HEADERS.filter((name) => response.headers[name] !== undefined).map((name) => [
			name,
			response.headers[name],
		]),
	);
	const hasJson =
		response.body !== null &&
		typeof response.body === 'object' &&
		Object.keys(response.body).length > 0;
	return {
		status: response.status,
		...(Object.keys(headers).length ? { headers } : {}),
		...(hasJson
			? { body: rec.normalize(response.body) }
			: response.text
				? { text: response.text.replace(/\s+/g, ' ').slice(0, 300) }
				: {}),
	};
}

let transcript: unknown[] = [];

async function step(name: string, action: () => Promise<unknown>) {
	const before = await state();
	idp.take();
	events.length = 0;
	renders.length = 0;
	takeLogs();
	let outcome: unknown;
	try {
		const value = await action();
		if (value !== null && typeof value === 'object' && 'status' in value && 'headers' in value) {
			outcome = answer(value as HttpResponse);
		} else {
			outcome = value === undefined ? 'done' : { value: rec.normalize(value) };
		}
	} catch (error) {
		outcome = { threw: rec.describeError(error) };
	}
	const after = await state();
	const entry: Record<string, unknown> = { step: name, outcome };
	if (renders.length) entry.renders = rec.normalize([...renders]);
	const logs = takeLogs();
	if (logs.length) entry.logs = logs;
	const requests = idp.take();
	if (requests.length) entry.provider = rec.normalize(requests);
	if (events.length) entry.events = rec.normalize(brief([...events]));
	const changes = diff(before, after);
	if (Object.keys(changes).length) entry.changes = changes;
	transcript.push(clean(entry));
}

// #endregion

// #region Fixtures

function credentialData() {
	return {
		grantType: 'authorizationCode',
		authUrl: `${idp.baseUrl}/authorize`,
		accessTokenUrl: `${idp.baseUrl}/token`,
		clientId: 'app-client',
		clientSecret: 'app-secret',
		scope: 'openid',
		authentication: 'header',
	};
}

function httpNode(name: string, credential: CredentialsEntity): INode {
	return {
		id: `node-${name}`,
		name,
		type: 'n8n-nodes-base.httpRequest',
		typeVersion: 4.2,
		position: [0, 0],
		parameters: { authentication: 'predefinedCredentialType', nodeCredentialType: 'oAuth2Api' },
		credentials: { oAuth2Api: { id: credential.id, name: credential.name } },
	};
}

async function credential(name: string, attributes: Record<string, unknown>) {
	const saved: CredentialsEntity = await saveCredential(
		{ name, type: 'oAuth2Api', data: credentialData(), ...attributes } as never,
		{ project, role: 'credential:owner' },
	);
	rec.label(saved.id, `credential ${name}`);
	return saved;
}

async function workflow(name: string, nodes: INode[], settings: Record<string, unknown> = {}) {
	const created = await createWorkflow({ name, nodes, connections: {}, settings }, project);
	rec.label(created.id, `workflow ${name}`);
	workflows[name] = created.id;
	return created.id;
}

/** The query of a provider URL that the authorize route gave. */
function stateOf(providerUrl: unknown) {
	const url = new URL(String((providerUrl as { data?: unknown }).data ?? providerUrl));
	return url.searchParams.get('state') ?? '';
}

const manual = (user: User): ICredentialContext => ({
	version: 1,
	identity: Container.get(AuthService).issueJWT(user, false),
	metadata: { source: 'manual-execution' },
});

async function connect(credentialEntity: CredentialsEntity, user: User, token = 'connected') {
	await Container.get(DynamicCredentialsProxy).storeIfNeeded(
		{
			id: credentialEntity.id,
			name: credentialEntity.name,
			type: credentialEntity.type,
			isResolvable: true,
			resolverId: SYSTEM,
		},
		{ oauthTokenData: { access_token: token } },
		manual(user),
		credentialData(),
	);
}

function checkProxy() {
	const context = Container.get(ModuleRegistry).context.get('dynamic-credentials') as
		| { credentialCheckProxy?: DynamicCredentialCheckProxyProvider }
		| undefined;
	if (!context?.credentialCheckProxy) throw new Error('No credential check proxy');
	return context.credentialCheckProxy;
}

// #endregion

beforeAll(async () => {
	await idp.start();
	await Container.get(ExecutionContextHookRegistry).init();
	Container.get(LoadNodesAndCredentials).loaded.credentials.oAuth2Api = {
		type: new OAuth2Api(),
		sourcePath: '',
	};
	owner = await createOwner();
	member = await createMember();
	outsider = await createMember();
	rec.label(owner.id, 'owner');
	rec.label(member.id, 'member');
	rec.label(outsider.id, 'outsider');
	ownerAgent = testServer.authAgentFor(owner);
	memberAgent = testServer.authAgentFor(member);
	outsiderAgent = testServer.authAgentFor(outsider);
	project = await createTeamProject('Team', owner);
	rec.label(project.id, 'project Team');
	await linkUserToProject(member, project, 'project:editor');

	idp.reset();
	const created = await ownerAgent.post('/credential-resolvers').send({
		name: 'Introspection',
		type: 'credential-resolver.oauth2-1.0',
		config: {
			metadataUri: `${idp.baseUrl}/.well-known/openid-configuration`,
			validation: 'oauth2-introspection',
			clientId: 'introspection-client',
			clientSecret: 'introspection-secret',
		},
	});
	oauthResolver = (created.body as { data: { id: string } }).data.id;
	rec.label(oauthResolver, 'resolver Introspection');

	privateCredential = await credential('Private', { isResolvable: true });
	boundCredential = await credential('Bound', { isResolvable: true, resolverId: oauthResolver });
	staticCredential = await credential('Static', { isResolvable: false });
	await workflow('System', [httpNode('Private node', privateCredential)]);
	await workflow('Bound', [httpNode('Bound node', boundCredential)], {
		credentialResolverId: oauthResolver,
	});
	await workflow('Static', [httpNode('Static node', staticCredential)]);
	await workflow('Mixed', [
		httpNode('Private node', privateCredential),
		httpNode('Static node', staticCredential),
		{ ...httpNode('Disabled node', boundCredential), disabled: true },
	]);
});

afterAll(async () => {
	await idp.stop();
});

beforeEach(async () => {
	transcript = [];
	idp.reset();
	idp.routes.set('POST /token', {
		status: 200,
		body: {
			access_token: 'idp-access',
			token_type: 'Bearer',
			expires_in: 3600,
			refresh_token: 'idp-refresh',
		},
	});
	idp.introspection.set('active-1', { status: 200, body: { active: true, sub: 'user-1' } });
	idp.introspection.set('active-2', { status: 200, body: { active: true, sub: 'user-2' } });
	await testDb.truncate(['DynamicCredentialUserEntry', 'DynamicCredentialEntry']);
	vi.spyOn(Container.get(EventService), 'emit').mockImplementation(
		(name: string, payload?: unknown) => {
			events.push([name, payload]);
			return true;
		},
	);
	vi.spyOn(Response, 'render').mockImplementation(function (
		this: typeof Response,
		view: string,
		options?: unknown,
	) {
		renders.push([view, options ?? null]);
		this.end();
		return this;
	} as never);
});

const status = (agent: SuperAgentTest, name: string, query = '') =>
	agent.get(`/workflows/${workflows[name]}/execution-status${query}`);

describe('dynamic credential endpoints', () => {
	test('the execution status', async () => {
		await step(
			'owner, cookie',
			async () => await status(ownerAgent, 'System', '?authSource=cookie'),
		);
		await step('owner, no auth source', async () => await status(ownerAgent, 'System'));
		await step(
			'owner, bearer auth source',
			async () => await status(ownerAgent, 'System', '?authSource=bearer'),
		);
		await step(
			'owner, unknown auth source',
			async () => await status(ownerAgent, 'System', '?authSource=other'),
		);
		await step(
			'member, cookie',
			async () => await status(memberAgent, 'System', '?authSource=cookie'),
		);
		await step(
			'outsider, cookie',
			async () => await status(outsiderAgent, 'System', '?authSource=cookie'),
		);
		await step(
			'no session, no token',
			async () => await status(testServer.authlessAgent, 'System'),
		);
		await step(
			'no session, the endpoint token',
			async () => await status(testServer.authlessAgent, 'System').set('X-Authorization', TOKEN),
		);
		await step(
			'no session, the endpoint token without the scheme',
			async () =>
				await status(testServer.authlessAgent, 'Bound')
					.set('X-Authorization', RAW_TOKEN)
					.set('Authorization', 'Bearer active-1'),
		);
		await step(
			'no session, the endpoint token in lower case scheme',
			async () =>
				await status(testServer.authlessAgent, 'Bound')
					.set('X-Authorization', 'bearer endpoint-token')
					.set('Authorization', 'Bearer active-1'),
		);
		await step(
			'no session, a wrong endpoint token',
			async () =>
				await status(testServer.authlessAgent, 'Bound')
					.set('X-Authorization', 'wrong')
					.set('Authorization', 'Bearer active-1'),
		);
		await step(
			'no session, the endpoint token and an active bearer token',
			async () =>
				await status(testServer.authlessAgent, 'Bound')
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer active-1'),
		);
		await step(
			'no session, the endpoint token and an inactive bearer token',
			async () =>
				await status(testServer.authlessAgent, 'Bound')
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer inactive'),
		);
		await step(
			'no session, a bearer token without the endpoint token',
			async () =>
				await status(testServer.authlessAgent, 'Bound').set('Authorization', 'Bearer active-1'),
		);
		await step(
			'no session, the endpoint token as a bearer token',
			async () => await status(testServer.authlessAgent, 'Bound').set('Authorization', TOKEN),
		);
		await step(
			'no session, the endpoint token, the bearer source on the system workflow',
			async () =>
				await status(testServer.authlessAgent, 'System', '?authSource=bearer')
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer active-1'),
		);
		await step(
			'owner, the bound workflow with the cookie',
			async () => await status(ownerAgent, 'Bound', '?authSource=cookie'),
		);
		await step(
			'owner, the bound workflow with a bearer token',
			async () =>
				await status(ownerAgent, 'Bound', '?authSource=bearer').set(
					'Authorization',
					'Bearer active-1',
				),
		);
		await step(
			'owner, the static workflow',
			async () => await status(ownerAgent, 'Static', '?authSource=cookie'),
		);
		await step(
			'owner, the mixed workflow',
			async () => await status(ownerAgent, 'Mixed', '?authSource=cookie'),
		);
		await step(
			'owner, an unknown workflow',
			async () => await ownerAgent.get('/workflows/unknown/execution-status?authSource=cookie'),
		);
		await connect(privateCredential, owner);
		await step(
			'owner, after the owner connects',
			async () => await status(ownerAgent, 'System', '?authSource=cookie'),
		);
		await step(
			'member, after the owner connects',
			async () => await status(memberAgent, 'System', '?authSource=cookie'),
		);
		await step(
			'owner, the mixed workflow after the owner connects',
			async () => await status(ownerAgent, 'Mixed', '?authSource=cookie'),
		);
		await step(
			'preflight from the allowed origin',
			async () =>
				await testServer.authlessAgent
					.options(`/workflows/${workflows.System}/execution-status`)
					.set('Origin', ORIGIN)
					.set('Access-Control-Request-Method', 'GET')
					.set('Access-Control-Request-Headers', 'authorization,x-authorization'),
		);
		await step(
			'preflight from another origin',
			async () =>
				await testServer.authlessAgent
					.options(`/workflows/${workflows.System}/execution-status`)
					.set('Origin', 'https://evil.example.com')
					.set('Access-Control-Request-Method', 'GET'),
		);
		await step(
			'a request from the allowed origin',
			async () =>
				await status(testServer.authlessAgent, 'Bound')
					.set('Origin', ORIGIN)
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer active-1'),
		);
		await step(
			'a request from another origin',
			async () =>
				await status(testServer.authlessAgent, 'Bound')
					.set('Origin', 'https://evil.example.com')
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer active-1'),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('authorize and revoke', async () => {
		const authorize = (
			agent: SuperAgentTest,
			credentialEntity: CredentialsEntity | string,
			query: string,
		) =>
			agent.post(
				`/credentials/${typeof credentialEntity === 'string' ? credentialEntity : credentialEntity.id}/authorize${query}`,
			);
		const revoke = (agent: SuperAgentTest, credentialEntity: CredentialsEntity, query: string) =>
			agent.delete(`/credentials/${credentialEntity.id}/revoke${query}`);
		let ownerState = '';
		await step('authorize the private credential as the owner', async () => {
			const response = await authorize(
				ownerAgent,
				privateCredential,
				`?resolverId=${SYSTEM}&authSource=cookie`,
			);
			ownerState = stateOf(response.body);
			return response;
		});
		await step(
			'the callback of the owner',
			async () =>
				await ownerAgent
					.get('/oauth2-credential/callback')
					.query({ code: 'code-owner', state: ownerState }),
		);
		await step(
			'the callback of the owner again',
			async () =>
				await ownerAgent
					.get('/oauth2-credential/callback')
					.query({ code: 'code-owner', state: ownerState }),
		);
		let memberState = '';
		await step('authorize the private credential as the member', async () => {
			const response = await authorize(
				memberAgent,
				privateCredential,
				`?resolverId=${SYSTEM}&authSource=cookie`,
			);
			memberState = stateOf(response.body);
			return response;
		});
		await step(
			'the callback of the member, called by the owner',
			async () =>
				await ownerAgent
					.get('/oauth2-credential/callback')
					.query({ code: 'code-member', state: memberState }),
		);
		await step(
			'authorize without a resolver id',
			async () => await authorize(ownerAgent, privateCredential, '?authSource=cookie'),
		);
		await step(
			'authorize with an unknown resolver id',
			async () =>
				await authorize(ownerAgent, privateCredential, '?resolverId=unknown&authSource=cookie'),
		);
		await step(
			'authorize the static credential',
			async () =>
				await authorize(ownerAgent, staticCredential, `?resolverId=${SYSTEM}&authSource=cookie`),
		);
		await step(
			'authorize an unknown credential',
			async () => await authorize(ownerAgent, 'unknown', `?resolverId=${SYSTEM}&authSource=cookie`),
		);
		await step(
			'authorize as the outsider',
			async () =>
				await authorize(
					outsiderAgent,
					privateCredential,
					`?resolverId=${SYSTEM}&authSource=cookie`,
				),
		);
		await step(
			'authorize without a session or token',
			async () =>
				await authorize(testServer.authlessAgent, privateCredential, `?resolverId=${SYSTEM}`),
		);
		let externalState = '';
		await step(
			'authorize the bound credential with the endpoint token and a bearer token',
			async () => {
				const response = await authorize(
					testServer.authlessAgent,
					boundCredential,
					`?resolverId=${oauthResolver}`,
				)
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer active-1');
				externalState = stateOf(response.body);
				return response;
			},
		);
		await step(
			'the callback of the external user without a session',
			async () =>
				await testServer.authlessAgent
					.get('/oauth2-credential/callback')
					.query({ code: 'code-ext', state: externalState }),
		);
		await step(
			'authorize the bound credential with an inactive bearer token',
			async () =>
				await authorize(testServer.authlessAgent, boundCredential, `?resolverId=${oauthResolver}`)
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer inactive'),
		);
		await step(
			'authorize the bound credential with the system resolver',
			async () =>
				await authorize(ownerAgent, boundCredential, `?resolverId=${SYSTEM}&authSource=cookie`),
		);
		await step(
			'authorize the private credential with the OAuth2 resolver as the owner',
			async () =>
				await authorize(
					ownerAgent,
					privateCredential,
					`?resolverId=${oauthResolver}&authSource=cookie`,
				),
		);
		await step(
			'preflight of authorize',
			async () =>
				await testServer.authlessAgent
					.options(`/credentials/${boundCredential.id}/authorize`)
					.set('Origin', ORIGIN)
					.set('Access-Control-Request-Method', 'POST'),
		);
		await step(
			'revoke the private credential as the member',
			async () =>
				await revoke(memberAgent, privateCredential, `?resolverId=${SYSTEM}&authSource=cookie`),
		);
		await step(
			'revoke the private credential as the owner',
			async () =>
				await revoke(ownerAgent, privateCredential, `?resolverId=${SYSTEM}&authSource=cookie`),
		);
		await step(
			'revoke the private credential as the owner again',
			async () =>
				await revoke(ownerAgent, privateCredential, `?resolverId=${SYSTEM}&authSource=cookie`),
		);
		await step(
			'revoke without a resolver id',
			async () => await revoke(ownerAgent, privateCredential, '?authSource=cookie'),
		);
		await step(
			'revoke the bound credential with the endpoint token and a bearer token',
			async () =>
				await revoke(testServer.authlessAgent, boundCredential, `?resolverId=${oauthResolver}`)
					.set('X-Authorization', TOKEN)
					.set('Authorization', 'Bearer active-1'),
		);
		await step(
			'revoke the static credential',
			async () =>
				await revoke(ownerAgent, staticCredential, `?resolverId=${SYSTEM}&authSource=cookie`),
		);
		await step(
			'revoke without a session or token',
			async () =>
				await revoke(testServer.authlessAgent, privateCredential, `?resolverId=${SYSTEM}`),
		);
		await step(
			'preflight of revoke',
			async () =>
				await testServer.authlessAgent
					.options(`/credentials/${boundCredential.id}/revoke`)
					.set('Origin', ORIGIN)
					.set('Access-Control-Request-Method', 'DELETE'),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('my connection', async () => {
		const disconnect = (agent: SuperAgentTest, id: string) =>
			agent.delete(`/credentials/${id}/my-connection`);
		await connect(privateCredential, owner, 'owner-token');
		await connect(privateCredential, member, 'member-token');
		await step(
			'the owner removes the connection',
			async () => await disconnect(ownerAgent, privateCredential.id),
		);
		await step(
			'the owner removes the connection again',
			async () => await disconnect(ownerAgent, privateCredential.id),
		);
		await step(
			'the outsider removes a connection',
			async () => await disconnect(outsiderAgent, privateCredential.id),
		);
		await step(
			'the member removes the connection',
			async () => await disconnect(memberAgent, privateCredential.id),
		);
		await step(
			'the static credential',
			async () => await disconnect(ownerAgent, staticCredential.id),
		);
		await step(
			'the bound credential',
			async () => await disconnect(ownerAgent, boundCredential.id),
		);
		await step('an unknown credential', async () => await disconnect(ownerAgent, 'unknown'));
		await step(
			'without a session',
			async () => await disconnect(testServer.authlessAgent, privateCredential.id),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the credential check and the authorization links', async () => {
		const context = async (credentials?: ICredentialContext) => ({
			credentials: credentials
				? await Container.get(Cipher).encryptV2(JSON.stringify(credentials))
				: undefined,
		});
		let link = '';
		await step('check the system workflow for the member', async () => {
			const result = await checkProxy().checkCredentialStatus(
				workflows.System,
				await context(manual(member)),
			);
			link = String(result.credentials[0]?.authorizationUrl ?? '');
			return result;
		});
		await step(
			'check the mixed workflow for the member',
			async () =>
				await checkProxy().checkCredentialStatus(workflows.Mixed, await context(manual(member))),
		);
		await step(
			'check with root nodes',
			async () =>
				await checkProxy().checkCredentialStatus(workflows.Mixed, await context(manual(member)), {
					rootNodes: [httpNode('Static node', staticCredential)],
				}),
		);
		await step(
			'check without a credential context',
			async () => await checkProxy().checkCredentialStatus(workflows.System, await context()),
		);
		await step(
			'check the bound workflow with a bearer token',
			async () =>
				await checkProxy().checkCredentialStatus(
					workflows.Bound,
					await context({
						version: 1,
						identity: 'active-2',
						metadata: { source: 'http-header', headerName: 'authorization' },
					}),
				),
		);
		await step(
			'check an unknown workflow',
			async () =>
				await checkProxy().checkCredentialStatus('unknown', await context(manual(member))),
		);
		const path = link
			? new URL(link).pathname + new URL(link).search
			: '/credentials/none/authorize';
		await step(
			'open the link without a session',
			async () => await testServer.restlessAgent.get(path).redirects(0),
		);
		await step(
			'open the link as the owner',
			async () =>
				await testServer
					.authAgentFor(owner)
					.get(path.replace(/^\/rest/, ''))
					.redirects(0),
		);
		await step(
			'open the link as the member',
			async () => await memberAgent.get(path.replace(/^\/rest/, '')).redirects(0),
		);
		await step(
			'open the link as the member again',
			async () => await memberAgent.get(path.replace(/^\/rest/, '')).redirects(0),
		);
		await step(
			'open a link with an unknown token',
			async () =>
				await memberAgent
					.get(`/credentials/${privateCredential.id}/authorize?token=unknown`)
					.redirects(0),
		);
		await step(
			'open a link without a token',
			async () =>
				await memberAgent.get(`/credentials/${privateCredential.id}/authorize`).redirects(0),
		);
		await connect(privateCredential, member, 'member-token');
		await step(
			'check the system workflow after the member connects',
			async () =>
				await checkProxy().checkCredentialStatus(workflows.System, await context(manual(member))),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the routes and the rate limits', async () => {
		await step('the routes of the module', async () => {
			const registry = Container.get(ControllerRegistryMetadata) as unknown as {
				registry: Map<Function, { basePath: string; routes: Map<string, Record<string, unknown>> }>;
			};
			const result: unknown[] = [];
			for (const [cls, meta] of registry.registry) {
				if (!['/credential-resolvers', '/credentials', '/workflows'].includes(meta.basePath))
					continue;
				for (const [handler, route] of meta.routes) {
					const path = String(route.path);
					if (
						meta.basePath !== '/credential-resolvers' &&
						!/authorize|revoke|my-connection|execution-status/.test(path)
					)
						continue;
					result.push({
						basePath: meta.basePath,
						method: route.method,
						path,
						skipAuth: route.skipAuth,
						allowUnauthenticated: route.allowUnauthenticated,
						usesTemplates: route.usesTemplates,
						ipRateLimit: route.ipRateLimit ?? null,
						keyedRateLimit: route.keyedRateLimit ?? null,
						cors: route.cors ?? null,
						accessScope: route.accessScope ?? null,
						middlewares: Array.isArray(route.middlewares) ? route.middlewares.length : 0,
						class: cls.name.length > 0,
						handler: typeof handler,
					});
				}
			}
			return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		});
		for (let index = 1; index <= 7; index++) {
			await step(
				`request ${index} of the execution status`,
				async () =>
					await status(testServer.authlessAgent, 'Bound')
						.set('X-Authorization', TOKEN)
						.set('Authorization', 'Bearer active-1'),
			);
		}
		for (let index = 1; index <= 6; index++) {
			await step(
				`request ${index} of authorize`,
				async () =>
					await testServer.authlessAgent
						.post(`/credentials/${boundCredential.id}/authorize?resolverId=${oauthResolver}`)
						.set('X-Authorization', TOKEN)
						.set('Authorization', 'Bearer active-1'),
			);
		}
		expect(transcript).toMatchSnapshot();
	});
});
