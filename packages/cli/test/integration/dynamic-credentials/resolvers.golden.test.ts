// Fork test (not in upstream n8n): the credential resolvers of dynamic credentials as a black box.
// The test drives the REST routes `/rest/credential-resolvers` with a fake OAuth2 provider, and
// records the answers, the requests to the provider, the stored resolvers (with the decrypted
// configuration), the credential entries, the workflows that use a resolver, the calls to the
// active workflow manager and the events. The snapshot was recorded against the enterprise
// module, and the fork module gives the same snapshot. See
// `packages/cli/src/modules/dynamic-credentials/README.md`.
import { EventService } from '@n8n/backend-services';
import { createActiveWorkflow, createWorkflow, testDb } from '@n8n/backend-test-utils';
import type { CredentialsEntity, User } from '@n8n/db';
import { CredentialsRepository, WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { Cipher } from 'n8n-core';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { saveCredential } from '@test-integration/db/credentials';
import { createAdmin, createMember, createOwner } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { FakeIdentityProvider } from './fake-identity-provider';

vi.hoisted(() => {
	process.env.N8N_ENV_FEAT_DYNAMIC_CREDENTIALS = 'true';
});

const testServer = utils.setupTestServer({
	endpointGroups: ['credentials'],
	modules: ['dynamic-credentials'],
	enabledFeatures: ['feat:dynamicCredentials'],
});

const rec = new GoldenRecorder();
const idp = new FakeIdentityProvider();
let owner: User;
let ownerAgent: SuperAgentTest;
let adminAgent: SuperAgentTest;
let memberAgent: SuperAgentTest;

const SYSTEM = 'system-n8n';
const SLACK = 'credential-resolver.slack-1.0';
const OAUTH2 = 'credential-resolver.oauth2-1.0';

// #region Recording

const events: unknown[][] = [];
const managerCalls: unknown[][] = [];

/** A stored secret as its plain value, without the random ciphertext. */
async function decrypt(value: unknown) {
	if (typeof value !== 'string') return value;
	if (value === '') return '<empty>';
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

/** The resolvers, the entries, the credentials and the workflows, as sorted JSON lines. */
async function state() {
	const query = async (sql: string) =>
		await Container.get(WorkflowRepository).manager.query<Array<Record<string, unknown>>>(sql);
	const resolvers = await query('SELECT * FROM dynamic_credential_resolver');
	const entries = await query('SELECT * FROM dynamic_credential_entry');
	const userEntries = await query('SELECT * FROM dynamic_credential_user_entry');
	const credentials = await Container.get(CredentialsRepository).find();
	const workflows = await Container.get(WorkflowRepository).find();
	const line = (value: unknown) => JSON.stringify(rec.normalize(value));
	return {
		resolvers: (
			await Promise.all(
				resolvers.map(async (row) =>
					line({
						id: row.id,
						name: row.name,
						type: row.type,
						config: await decrypt(row.config),
					}),
				),
			)
		).sort(),
		entries: (
			await Promise.all(
				entries.map(async (row) =>
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
				userEntries.map(async (row) =>
					line({
						credential: row.credentialId,
						user: row.userId,
						resolver: row.resolverId,
						data: await decrypt(row.data),
					}),
				),
			)
		).sort(),
		credentials: credentials
			.map((c) =>
				line({
					name: c.name,
					isResolvable: c.isResolvable,
					resolvableAllowFallback: c.resolvableAllowFallback,
					resolverId: c.resolverId,
				}),
			)
			.sort(),
		workflows: workflows
			.map((w) =>
				line({
					name: w.name,
					active: w.active,
					activeVersionId: w.activeVersionId ? '<set>' : null,
					settings: w.settings ?? null,
				}),
			)
			.sort(),
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

type Response = { status: number; body: unknown };

let transcript: unknown[] = [];

/** Runs one step and records what it did. */
async function step(name: string, action: () => Promise<unknown>) {
	const before = await state();
	idp.take();
	events.length = 0;
	managerCalls.length = 0;
	let outcome: unknown;
	try {
		const value = await action();
		// A new resolver can have an id without a digit, which the id pattern misses.
		await rec.maskNewIds(['dynamic_credential_resolver']);
		if (value !== null && typeof value === 'object' && 'status' in value && 'body' in value) {
			const response = value as Response;
			outcome = { status: response.status, body: rec.normalize(response.body) };
		} else {
			outcome = value === undefined ? 'done' : { value: rec.normalize(value) };
		}
	} catch (error) {
		outcome = { threw: rec.describeError(error) };
	}
	const after = await state();
	const entry: Record<string, unknown> = { step: name, outcome };
	const requests = idp.take();
	if (requests.length)
		entry.provider = rec.normalize(JSON.parse(idp.label(JSON.stringify(requests))));
	if (events.length) entry.events = rec.normalize([...events]);
	if (managerCalls.length) entry.activeWorkflowManager = rec.normalize([...managerCalls]);
	const changes = diff(before, after);
	if (Object.keys(changes).length) entry.changes = changes;
	transcript.push(JSON.parse(idp.label(JSON.stringify(entry))) as unknown);
}

// #endregion

// #region Setup

beforeAll(async () => {
	await idp.start();
	owner = await createOwner();
	ownerAgent = testServer.authAgentFor(owner);
	adminAgent = testServer.authAgentFor(await createAdmin());
	memberAgent = testServer.authAgentFor(await createMember());
	rec.label(owner.id, 'owner');
});

afterAll(async () => {
	await idp.stop();
});

beforeEach(async () => {
	transcript = [];
	idp.reset();
	const manager = Container.get(WorkflowRepository).manager;
	const run = async (label: string, action: () => Promise<unknown>) => {
		try {
			await action();
		} catch (error) {
			throw new Error(`cleanup ${label}: ${(error as Error).message}`);
		}
	};
	await run(
		'resolvers',
		async () =>
			await manager.query("DELETE FROM dynamic_credential_resolver WHERE id != 'system-n8n'"),
	);
	for (const entity of [
		'DynamicCredentialUserEntry',
		'DynamicCredentialEntry',
		'SharedCredentials',
		'CredentialsEntity',
		'SharedWorkflow',
		'WorkflowEntity',
		'WorkflowHistory',
	] as const) {
		await run(entity, async () => await testDb.truncate([entity]));
	}

	const eventService = Container.get(EventService);
	vi.spyOn(eventService, 'emit').mockImplementation((name: string, payload?: unknown) => {
		events.push([name, payload]);
		return true;
	});
	const activeWorkflowManager = Container.get(ActiveWorkflowManager);
	for (const key of Object.getOwnPropertyNames(ActiveWorkflowManager.prototype)) {
		if (key === 'constructor') continue;
		const descriptor = Object.getOwnPropertyDescriptor(ActiveWorkflowManager.prototype, key);
		if (typeof descriptor?.value !== 'function') continue;
		vi.spyOn(
			activeWorkflowManager as unknown as Record<string, () => unknown>,
			key,
		).mockImplementation(async (...args: unknown[]) => {
			managerCalls.push([key, ...args]);
			return undefined;
		});
	}
});

const slackConfig = (overrides: Record<string, unknown> = {}) => ({
	signingSecret: 'slack-signing-secret',
	subjectClaim: 'team_user',
	...overrides,
});

const oauthConfig = (overrides: Record<string, unknown> = {}) => ({
	metadataUri: `${idp.baseUrl}/.well-known/openid-configuration`,
	validation: 'oauth2-introspection',
	clientId: 'introspection-client',
	clientSecret: 'introspection-secret',
	...overrides,
});

const create = async (body: unknown, agent = ownerAgent) =>
	await agent.post('/credential-resolvers').send(body as object);

/** Creates a resolver through the API and labels its id. */
async function createResolver(name: string, type: string, config: Record<string, unknown>) {
	const response = await create({ name, type, config });
	const id = (response.body as { data?: { id?: string } }).data?.id;
	if (!id)
		throw new Error(`Could not create the resolver ${name}: ${JSON.stringify(response.body)}`);
	rec.label(id, `resolver ${name}`);
	return id;
}

/** A credential that a resolver resolves, with entries for two subjects and one user. */
async function credentialWithEntries(name: string, resolverId: string) {
	const credential: CredentialsEntity = await saveCredential(
		{
			name,
			type: 'oAuth2Api',
			data: { clientId: 'static-client', clientSecret: 'static-secret' },
			isResolvable: true,
			resolverId,
		} as never,
		{ user: owner, role: 'credential:owner' },
	);
	rec.label(credential.id, `credential ${name}`);
	const cipher = Container.get(Cipher);
	const manager = Container.get(WorkflowRepository).manager;
	for (const subject of ['subject-a', 'subject-b']) {
		await manager.query(
			'INSERT INTO dynamic_credential_entry (credential_id, subject_id, resolver_id, data, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
			[
				credential.id,
				subject,
				resolverId,
				await cipher.encryptV2(JSON.stringify({ token: subject })),
			],
		);
	}
	await manager.query(
		'INSERT INTO dynamic_credential_user_entry ("credentialId", "userId", "resolverId", data, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
		[
			credential.id,
			owner.id,
			resolverId,
			await cipher.encryptV2(JSON.stringify({ token: 'owner' })),
		],
	);
	return credential;
}

// #endregion

describe('credential resolvers', () => {
	test('the types and the system resolver', async () => {
		await step(
			'GET /types as the owner',
			async () => await ownerAgent.get('/credential-resolvers/types'),
		);
		await step(
			'GET /types as an admin',
			async () => await adminAgent.get('/credential-resolvers/types'),
		);
		await step(
			'GET /types as a member',
			async () => await memberAgent.get('/credential-resolvers/types'),
		);
		await step('GET / as the owner', async () => await ownerAgent.get('/credential-resolvers'));
		await step(
			'GET / with includeSystem=true',
			async () => await ownerAgent.get('/credential-resolvers?includeSystem=true'),
		);
		await step(
			'GET / with includeSystem=false',
			async () => await ownerAgent.get('/credential-resolvers?includeSystem=false'),
		);
		await step(
			'GET / with includeSystem=1',
			async () => await ownerAgent.get('/credential-resolvers?includeSystem=1'),
		);
		await step(
			'GET / with includeSystem=maybe',
			async () => await ownerAgent.get('/credential-resolvers?includeSystem=maybe'),
		);
		await step('GET / as a member', async () => await memberAgent.get('/credential-resolvers'));
		await step(
			'GET / with includeSystem=true as a member',
			async () => await memberAgent.get('/credential-resolvers?includeSystem=true'),
		);
		await step(
			'GET /system-n8n',
			async () => await ownerAgent.get(`/credential-resolvers/${SYSTEM}`),
		);
		await step(
			'GET /system-n8n as a member',
			async () => await memberAgent.get(`/credential-resolvers/${SYSTEM}`),
		);
		await step(
			'GET /system-n8n/workflows',
			async () => await ownerAgent.get(`/credential-resolvers/${SYSTEM}/workflows`),
		);
		await step(
			'PATCH /system-n8n with a name',
			async () =>
				await ownerAgent.patch(`/credential-resolvers/${SYSTEM}`).send({ name: 'Renamed' }),
		);
		await step(
			'PATCH /system-n8n with a config',
			async () =>
				await ownerAgent.patch(`/credential-resolvers/${SYSTEM}`).send({ config: { a: 1 } }),
		);
		await step(
			'DELETE /system-n8n',
			async () => await ownerAgent.delete(`/credential-resolvers/${SYSTEM}`),
		);
		await step(
			'POST a resolver of the n8n type',
			async () =>
				await create({ name: 'Another n8n', type: 'credential-resolver.n8n-1.0', config: {} }),
		);
		await step('GET /unknown', async () => await ownerAgent.get('/credential-resolvers/unknown'));
		await step(
			'GET /unknown/workflows',
			async () => await ownerAgent.get('/credential-resolvers/unknown/workflows'),
		);
		await step(
			'PATCH /unknown',
			async () => await ownerAgent.patch('/credential-resolvers/unknown').send({ name: 'x' }),
		);
		await step(
			'DELETE /unknown',
			async () => await ownerAgent.delete('/credential-resolvers/unknown'),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('create', async () => {
		await step(
			'POST a Slack resolver',
			async () => await create({ name: 'Slack', type: SLACK, config: slackConfig() }),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST a Slack resolver with the default subject claim',
			async () =>
				await create({ name: 'Slack 2', type: SLACK, config: { signingSecret: 'other-secret' } }),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST a Slack resolver with the same name',
			async () => await create({ name: 'Slack', type: SLACK, config: slackConfig() }),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST a Slack resolver without a signing secret',
			async () =>
				await create({ name: 'No secret', type: SLACK, config: { subjectClaim: 'user_id' } }),
		);
		await step(
			'POST a Slack resolver with an empty signing secret',
			async () =>
				await create({
					name: 'Empty secret',
					type: SLACK,
					config: slackConfig({ signingSecret: '' }),
				}),
		);
		await step(
			'POST a Slack resolver with an unknown subject claim',
			async () =>
				await create({
					name: 'Bad claim',
					type: SLACK,
					config: slackConfig({ subjectClaim: 'email' }),
				}),
		);
		await step(
			'POST a Slack resolver with an extra field',
			async () =>
				await create({ name: 'Extra', type: SLACK, config: slackConfig({ extra: true }) }),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST an OAuth2 resolver with introspection',
			async () => await create({ name: 'Introspection', type: OAUTH2, config: oauthConfig() }),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST an OAuth2 resolver with userinfo',
			async () =>
				await create({
					name: 'Userinfo',
					type: OAUTH2,
					config: {
						metadataUri: `${idp.baseUrl}/.well-known/openid-configuration`,
						validation: 'oauth2-userinfo',
						expectedAudience: 'https://n8n.example.com',
					},
				}),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST an OAuth2 resolver with only the metadata URL',
			async () =>
				await create({
					name: 'Defaults',
					type: OAUTH2,
					config: { metadataUri: `${idp.baseUrl}/.well-known/openid-configuration` },
				}),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		idp.metadata = { status: 404, body: { error: 'not_found' } };
		await step(
			'POST an OAuth2 resolver whose metadata answers 404',
			async () => await create({ name: 'Missing metadata', type: OAUTH2, config: oauthConfig() }),
		);
		idp.metadata = { status: 500, body: { error: 'server_error' } };
		await step(
			'POST an OAuth2 resolver whose metadata answers 500',
			async () => await create({ name: 'Broken metadata', type: OAUTH2, config: oauthConfig() }),
		);
		idp.metadata = { issuer: idp.baseUrl, userinfo_endpoint: `${idp.baseUrl}/userinfo` };
		await step(
			'POST an introspection resolver without an introspection endpoint',
			async () => await create({ name: 'No introspection', type: OAUTH2, config: oauthConfig() }),
		);
		idp.metadata = { issuer: idp.baseUrl, introspection_endpoint: `${idp.baseUrl}/introspect` };
		await step(
			'POST a userinfo resolver without a userinfo endpoint',
			async () =>
				await create({
					name: 'No userinfo',
					type: OAUTH2,
					config: oauthConfig({ validation: 'oauth2-userinfo' }),
				}),
		);
		idp.metadata = { status: 200, body: 'not json' };
		await step(
			'POST an OAuth2 resolver whose metadata is not an object',
			async () => await create({ name: 'Text metadata', type: OAUTH2, config: oauthConfig() }),
		);
		idp.reset();
		await step(
			'POST an OAuth2 resolver without client credentials',
			async () =>
				await create({
					name: 'No client',
					type: OAUTH2,
					config: {
						metadataUri: `${idp.baseUrl}/.well-known/openid-configuration`,
						validation: 'oauth2-introspection',
					},
				}),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST an OAuth2 resolver with an unknown validation',
			async () =>
				await create({
					name: 'Bad validation',
					type: OAUTH2,
					config: oauthConfig({ validation: 'jwt' }),
				}),
		);
		await step(
			'POST an OAuth2 resolver with a metadata URL that is not a URL',
			async () =>
				await create({
					name: 'Bad URL',
					type: OAUTH2,
					config: oauthConfig({ metadataUri: 'not a url' }),
				}),
		);
		await step(
			'POST an OAuth2 resolver without a metadata URL',
			async () =>
				await create({ name: 'No URL', type: OAUTH2, config: { validation: 'oauth2-userinfo' } }),
		);
		await step(
			'POST an OAuth2 resolver with an unreachable metadata URL',
			async () =>
				await create({
					name: 'Unreachable',
					type: OAUTH2,
					config: oauthConfig({
						metadataUri: 'http://127.0.0.1:9/.well-known/openid-configuration',
					}),
				}),
		);
		await step(
			'POST an unknown type',
			async () =>
				await create({ name: 'Unknown', type: 'credential-resolver.nope-1.0', config: {} }),
		);
		await step('POST without a body', async () => await create({}));
		await step(
			'POST with an empty name',
			async () => await create({ name: '  ', type: SLACK, config: slackConfig() }),
		);
		await step(
			'POST with a name of 256 characters',
			async () => await create({ name: 'n'.repeat(256), type: SLACK, config: slackConfig() }),
		);
		await step(
			'POST with a name of 255 characters',
			async () => await create({ name: 'n'.repeat(255), type: SLACK, config: slackConfig() }),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST with a config that is not an object',
			async () => await create({ name: 'Text config', type: SLACK, config: 'secret' }),
		);
		await step(
			'POST without a config',
			async () => await create({ name: 'No config', type: SLACK }),
		);
		await step(
			'POST as an admin',
			async () =>
				await create({ name: 'By admin', type: SLACK, config: slackConfig() }, adminAgent),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST as a member',
			async () =>
				await create({ name: 'By member', type: SLACK, config: slackConfig() }, memberAgent),
		);
		await step(
			'GET / after the creates',
			async () => await ownerAgent.get('/credential-resolvers'),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('read and update', async () => {
		const slack = await createResolver('Slack', SLACK, slackConfig());
		const oauth = await createResolver('Introspection', OAUTH2, oauthConfig());
		await credentialWithEntries('Slack credential', slack);
		await credentialWithEntries('OAuth credential', oauth);

		await step(
			'GET the Slack resolver',
			async () => await ownerAgent.get(`/credential-resolvers/${slack}`),
		);
		await step(
			'GET the OAuth2 resolver',
			async () => await ownerAgent.get(`/credential-resolvers/${oauth}`),
		);
		await step(
			'GET the OAuth2 resolver as a member',
			async () => await memberAgent.get(`/credential-resolvers/${oauth}`),
		);
		await step(
			'PATCH the name',
			async () =>
				await ownerAgent.patch(`/credential-resolvers/${slack}`).send({ name: 'Slack renamed' }),
		);
		const read = await ownerAgent.get(`/credential-resolvers/${slack}`);
		const redacted = (read.body as { data: { decryptedConfig: Record<string, unknown> } }).data
			.decryptedConfig;
		await step(
			'PATCH the config with the secret as the GET gave it',
			async () =>
				await ownerAgent
					.patch(`/credential-resolvers/${slack}`)
					.send({ config: { ...redacted, subjectClaim: 'user_id' } }),
		);
		await step(
			'PATCH the config with a new secret',
			async () =>
				await ownerAgent
					.patch(`/credential-resolvers/${slack}`)
					.send({ config: slackConfig({ signingSecret: 'rotated-secret' }) }),
		);
		await step(
			'PATCH the config with clearCredentials false',
			async () =>
				await ownerAgent.patch(`/credential-resolvers/${slack}`).send({
					config: slackConfig({ signingSecret: 'rotated-again' }),
					clearCredentials: false,
				}),
		);
		await step(
			'PATCH the config with clearCredentials true',
			async () =>
				await ownerAgent.patch(`/credential-resolvers/${slack}`).send({
					config: slackConfig({ signingSecret: 'rotated-third' }),
					clearCredentials: true,
				}),
		);
		await step(
			'PATCH only clearCredentials true',
			async () =>
				await ownerAgent.patch(`/credential-resolvers/${oauth}`).send({ clearCredentials: true }),
		);
		await credentialWithEntries('OAuth credential 2', oauth);
		await step(
			'PATCH the name with clearCredentials true',
			async () =>
				await ownerAgent
					.patch(`/credential-resolvers/${oauth}`)
					.send({ name: 'Introspection renamed', clearCredentials: true }),
		);
		await credentialWithEntries('OAuth credential 3', oauth);
		await step(
			'PATCH an invalid config',
			async () =>
				await ownerAgent
					.patch(`/credential-resolvers/${oauth}`)
					.send({ config: oauthConfig({ validation: 'jwt' }), clearCredentials: true }),
		);
		await step('PATCH the OAuth2 config with the redacted secret', async () => {
			const current = await ownerAgent.get(`/credential-resolvers/${oauth}`);
			const config = (current.body as { data: { decryptedConfig: Record<string, unknown> } }).data
				.decryptedConfig;
			return await ownerAgent
				.patch(`/credential-resolvers/${oauth}`)
				.send({ config: { ...config, clientId: 'new-client' } });
		});
		await step(
			'PATCH the type to OAuth2 without a config',
			async () => await ownerAgent.patch(`/credential-resolvers/${slack}`).send({ type: OAUTH2 }),
		);
		await step(
			'PATCH the type to OAuth2 with a config',
			async () =>
				await ownerAgent
					.patch(`/credential-resolvers/${slack}`)
					.send({ type: OAUTH2, config: oauthConfig({ validation: 'oauth2-userinfo' }) }),
		);
		await step(
			'PATCH an unknown type',
			async () =>
				await ownerAgent
					.patch(`/credential-resolvers/${slack}`)
					.send({ type: 'credential-resolver.nope-1.0' }),
		);
		await step(
			'PATCH an empty body',
			async () => await ownerAgent.patch(`/credential-resolvers/${oauth}`).send({}),
		);
		await step(
			'PATCH an empty name',
			async () => await ownerAgent.patch(`/credential-resolvers/${oauth}`).send({ name: '' }),
		);
		await step(
			'PATCH clearCredentials as text',
			async () =>
				await ownerAgent.patch(`/credential-resolvers/${oauth}`).send({ clearCredentials: 'yes' }),
		);
		await step(
			'PATCH as a member',
			async () =>
				await memberAgent.patch(`/credential-resolvers/${oauth}`).send({ name: 'By member' }),
		);
		await step(
			'GET / at the end',
			async () => await ownerAgent.get('/credential-resolvers?includeSystem=true'),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the workflows of a resolver and delete', async () => {
		const slack = await createResolver('Slack', SLACK, slackConfig());
		const other = await createResolver('Other', SLACK, slackConfig({ signingSecret: 'other' }));
		const first = await createWorkflow(
			{ name: 'First', settings: { credentialResolverId: slack, timezone: 'Europe/Berlin' } },
			owner,
		);
		rec.label(first.id, 'workflow First');
		const active = await createActiveWorkflow(
			{ name: 'Active', settings: { credentialResolverId: slack } },
			owner,
		);
		rec.label(active.id, 'workflow Active');
		const unrelated = await createWorkflow(
			{ name: 'Unrelated', settings: { credentialResolverId: other } },
			owner,
		);
		rec.label(unrelated.id, 'workflow Unrelated');
		const none = await createWorkflow({ name: 'No settings' }, owner);
		rec.label(none.id, 'workflow No settings');
		await credentialWithEntries('Slack credential', slack);

		await step(
			'GET the workflows of the resolver',
			async () => await ownerAgent.get(`/credential-resolvers/${slack}/workflows`),
		);
		await step(
			'GET the workflows as a member',
			async () => await memberAgent.get(`/credential-resolvers/${slack}/workflows`),
		);
		await step(
			'GET the workflows of the other resolver',
			async () => await ownerAgent.get(`/credential-resolvers/${other}/workflows`),
		);
		await step(
			'DELETE as a member',
			async () => await memberAgent.delete(`/credential-resolvers/${slack}`),
		);
		await step(
			'DELETE the resolver',
			async () => await ownerAgent.delete(`/credential-resolvers/${slack}`),
		);
		await step(
			'GET the deleted resolver',
			async () => await ownerAgent.get(`/credential-resolvers/${slack}`),
		);
		await step(
			'GET the workflows of the deleted resolver',
			async () => await ownerAgent.get(`/credential-resolvers/${slack}/workflows`),
		);
		await step(
			'DELETE the resolver again',
			async () => await ownerAgent.delete(`/credential-resolvers/${slack}`),
		);
		await step(
			'DELETE the other resolver as an admin',
			async () => await adminAgent.delete(`/credential-resolvers/${other}`),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('expressions in the config', async () => {
		await step(
			'POST a Slack resolver with an expression as the secret',
			async () =>
				await create({
					name: 'Expression',
					type: SLACK,
					config: slackConfig({ signingSecret: '={{ "abc" + "def" }}' }),
				}),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST an OAuth2 resolver with an expression as the metadata URL',
			async () =>
				await create({
					name: 'Expression URL',
					type: OAUTH2,
					config: oauthConfig({
						metadataUri: `={{ "${idp.baseUrl}" + "/.well-known/openid-configuration" }}`,
					}),
				}),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST an OAuth2 resolver with an expression that fails',
			async () =>
				await create({
					name: 'Bad expression',
					type: OAUTH2,
					config: oauthConfig({ metadataUri: '={{ $nope.value }}' }),
				}),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'POST a Slack resolver with an environment expression',
			async () =>
				await create({
					name: 'Env',
					type: SLACK,
					config: slackConfig({ signingSecret: '={{ $env.HOME ? "home" : "none" }}' }),
				}),
		);
		await rec.labelNewRows(['dynamic_credential_resolver']);
		await step(
			'GET / with the expressions',
			async () => await ownerAgent.get('/credential-resolvers'),
		);
		expect(transcript).toMatchSnapshot();
	});
});
