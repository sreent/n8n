// Fork test (not in upstream n8n): the per-user connections of private credentials as a black
// box, through the ordinary credential, project and user routes: the connection fields of a
// credential, the account of a connection, the removal of connections when a credential becomes
// static, when its shared fields change, when it leaves a project, when a user leaves a project
// and when a user goes. It also records the shared fields of credential types and the start and
// the shutdown of the module. The snapshot was recorded against the enterprise module, and the
// fork module gives the same snapshot. See `packages/cli/src/modules/dynamic-credentials/README.md`.
import { ModuleRegistry } from '@n8n/backend-common';
import { EventService, ExecutingUserIdentifierProxy } from '@n8n/backend-services';
import { createTeamProject, linkUserToProject, testDb } from '@n8n/backend-test-utils';
import type { CredentialsEntity, Project, User } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { Cipher, ExecutionContextService } from 'n8n-core';
import { HttpBasicAuth } from 'n8n-nodes-base/credentials/HttpBasicAuth.credentials';
import { HttpBearerAuth } from 'n8n-nodes-base/credentials/HttpBearerAuth.credentials';
import { OAuth2Api } from 'n8n-nodes-base/credentials/OAuth2Api.credentials';
import { SlackOAuth2Api } from 'n8n-nodes-base/credentials/SlackOAuth2Api.credentials';
import { ZulipApi } from 'n8n-nodes-base/credentials/ZulipApi.credentials';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';
import type { ICredentialContext, ICredentialType, IDataObject } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { CredentialConnectionStatusProxy } from '@/credentials/credential-connection-status-proxy';
import { DynamicCredentialsProxy } from '@/credentials/dynamic-credentials-proxy';
import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
import { saveCredential } from '@test-integration/db/credentials';
import { createMember, createOwner } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { DynamicCredentialsModule, extractSharedFields, getChangedSharedFields } from './subject';

vi.hoisted(() => {
	process.env.N8N_ENV_FEAT_DYNAMIC_CREDENTIALS = 'true';
});

const testServer = utils.setupTestServer({
	endpointGroups: ['credentials', 'project', 'users'],
	modules: ['dynamic-credentials'],
	enabledFeatures: [
		'feat:dynamicCredentials',
		'feat:sharing',
		'feat:advancedPermissions',
		'feat:projectRole:admin',
		'feat:projectRole:editor',
		'feat:projectRole:viewer',
	],
	quotas: { 'quota:maxTeamProjects': -1 },
});

const rec = new GoldenRecorder();
let owner: User;
let editor: User;
let viewer: User;
let outsider: User;
let ownerAgent: SuperAgentTest;
let editorAgent: SuperAgentTest;
let viewerAgent: SuperAgentTest;
let outsiderAgent: SuperAgentTest;
let team: Project;
let other: Project;

const SYSTEM = 'system-n8n';

// #region Recording

const events: unknown[][] = [];

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

function brief(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(brief);
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.email === 'string' && typeof record.id === 'string') {
			return `<user ${rec.labelString(record.id)}>`;
		}
		return Object.fromEntries(
			Object.entries(record).map(([key, entry]) => [
				key,
				// The users route picks any member of the target project, so the id is not stable.
				key === 'migrationUserId' ? '<a member>' : brief(entry),
			]),
		);
	}
	return value;
}

async function state() {
	const query = async (sql: string) =>
		await Container.get(WorkflowRepository).manager.query<Array<Record<string, unknown>>>(sql);
	const line = (value: unknown) => JSON.stringify(rec.normalize(value));
	return {
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
		credentials: (
			await query('SELECT id, name, "isResolvable", "resolverId" FROM credentials_entity')
		)
			.map((row) => line(row))
			.sort(),
		sharing: (await query('SELECT "credentialsId", "projectId", role FROM shared_credentials'))
			.map((row) => line(row))
			.sort(),
		resolvers: (await query('SELECT id, name, type FROM dynamic_credential_resolver'))
			.map((row) => line(row))
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

const CREDENTIAL_FIELDS = [
	'id',
	'name',
	'type',
	'isResolvable',
	'resolverId',
	'connectedByMe',
	'connectedAccountIdentifier',
	'connectedUserCount',
	'data',
];

/** The connection fields of a credential in an answer. */
function credentialFields(value: unknown): unknown {
	if (Array.isArray(value)) {
		// The list order of the credentials route is ordinary code, so sort by name.
		const items = value.map(credentialFields) as Array<{ name?: unknown }>;
		return items.every((item) => typeof item?.name === 'string')
			? [...items].sort((a, b) => String(a.name).localeCompare(String(b.name)))
			: items;
	}
	if (value === null || typeof value !== 'object') return value;
	const record = value as Record<string, unknown>;
	if (!('isResolvable' in record)) return record;
	const result: Record<string, unknown> = {};
	for (const key of CREDENTIAL_FIELDS) {
		if (key in record) result[key] = record[key] === undefined ? '<undefined>' : record[key];
	}
	return result;
}

let transcript: unknown[] = [];

async function step(name: string, action: () => Promise<unknown>) {
	const before = await state();
	events.length = 0;
	let outcome: unknown;
	try {
		const value = await action();
		if (value !== null && typeof value === 'object' && 'status' in value && 'body' in value) {
			const response = value as { status: number; body: { data?: unknown } };
			const body =
				response.body?.data !== undefined
					? { data: credentialFields(response.body.data) }
					: response.body;
			outcome = { status: response.status, body: rec.normalize(body) };
		} else {
			outcome = value === undefined ? 'done' : { value: rec.normalize(value) };
		}
	} catch (error) {
		outcome = { threw: rec.describeError(error) };
	}
	const after = await state();
	const entry: Record<string, unknown> = { step: name, outcome };
	if (events.length) entry.events = rec.normalize(brief([...events]));
	const changes = diff(before, after);
	if (Object.keys(changes).length) entry.changes = changes;
	transcript.push(entry);
}

// #endregion

// #region Fixtures

const DATA = {
	grantType: 'authorizationCode',
	authUrl: 'https://idp.example.com/authorize',
	accessTokenUrl: 'https://idp.example.com/token',
	clientId: 'app-client',
	clientSecret: 'app-secret',
	scope: 'openid',
	authentication: 'header',
};

function idToken(claims: Record<string, unknown>) {
	const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
	return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.signature`;
}

async function credential(
	name: string,
	project: Project,
	attributes: Record<string, unknown>,
	type = 'oAuth2Api',
) {
	const saved: CredentialsEntity = await saveCredential(
		{ name, type, data: DATA, ...attributes } as never,
		{ project, role: 'credential:owner' },
	);
	rec.label(saved.id, `credential ${name}`);
	return saved;
}

const manual = (user: User): ICredentialContext => ({
	version: 1,
	identity: Container.get(AuthService).issueJWT(user, false),
	metadata: { source: 'manual-execution' },
});

async function connect(c: CredentialsEntity, user: User, oauthTokenData: IDataObject) {
	await Container.get(DynamicCredentialsProxy).storeIfNeeded(
		{ id: c.id, name: c.name, type: c.type, isResolvable: true, resolverId: SYSTEM },
		{ oauthTokenData },
		manual(user),
		DATA,
	);
}

const NEW_DATA = {
	...DATA,
	clientId: 'new-client',
	scope: 'openid email',
	clientSecret: 'new-secret',
};

const ZULIP_STATIC = {
	url: 'https://static.zulip.example.com',
	email: 'static@example.com',
	apiKey: 'static-key',
};

/** The execution context of a manual run of a user, with the credential context encrypted. */
async function manualRun(user: User) {
	return await Container.get(ExecutionContextService).encryptExecutionContext({
		version: 1,
		establishedAt: 1_700_000_000_000,
		source: 'manual',
		credentials: manual(user),
	});
}

const isPromise = (value: unknown) => value instanceof Promise;

const ctorName = (value: unknown) =>
	value && typeof value === 'object' ? (value as object).constructor.name : String(value);

// #endregion

beforeAll(async () => {
	Container.get(LoadNodesAndCredentials).loaded.credentials.oAuth2Api = {
		type: new OAuth2Api(),
		sourcePath: '',
	};
	Container.get(LoadNodesAndCredentials).loaded.credentials.slackOAuth2Api = {
		type: new SlackOAuth2Api(),
		sourcePath: '',
	};
	for (const type of [new ZulipApi(), new HttpBasicAuth(), new HttpBearerAuth()]) {
		Container.get(LoadNodesAndCredentials).loaded.credentials[type.name] = { type, sourcePath: '' };
	}
	owner = await createOwner();
	editor = await createMember();
	viewer = await createMember();
	outsider = await createMember();
	rec.label(owner.id, 'owner');
	rec.label(editor.id, 'editor');
	rec.label(viewer.id, 'viewer');
	rec.label(outsider.id, 'outsider');
	ownerAgent = testServer.authAgentFor(owner);
	editorAgent = testServer.authAgentFor(editor);
	viewerAgent = testServer.authAgentFor(viewer);
	outsiderAgent = testServer.authAgentFor(outsider);
});

beforeEach(async () => {
	transcript = [];
	await testDb.truncate(['DynamicCredentialUserEntry', 'SharedCredentials', 'CredentialsEntity']);
	await testDb.truncate(['ProjectRelation']);
	await Container.get(WorkflowRepository).manager.query("DELETE FROM project WHERE type = 'team'");
	team = await createTeamProject('Team', owner);
	other = await createTeamProject('Other', owner);
	rec.label(team.id, 'project Team');
	rec.label(other.id, 'project Other');
	await linkUserToProject(editor, team, 'project:editor');
	await linkUserToProject(viewer, team, 'project:viewer');
	await linkUserToProject(outsider, other, 'project:editor');
	// Record the events and still give them to the listeners.
	const service = Container.get(EventService);
	const emit = Object.getPrototypeOf(service).emit as (name: string, payload?: unknown) => boolean;
	vi.spyOn(service, 'emit').mockImplementation(((name: string, payload?: unknown) => {
		events.push([name, payload]);
		return emit.call(service, name, payload);
	}) as never);
});

describe('private credential connections', () => {
	test('the connection fields of a credential', async () => {
		const privateCredential = await credential('Private', team, { isResolvable: true });
		const staticCredential = await credential('Static', team, { isResolvable: false });
		const accounts = await credential('Accounts', team, { isResolvable: true });
		await step(
			'the owner connects',
			async () =>
				await connect(privateCredential, owner, {
					access_token: 'owner-access',
					id_token: idToken({ sub: 'owner-sub', email: 'owner@idp.example.com' }),
				}),
		);
		await step(
			'the editor connects',
			async () => await connect(privateCredential, editor, { access_token: 'editor-access' }),
		);
		await step(
			'the viewer connects',
			async () =>
				await connect(privateCredential, viewer, {
					access_token: 'viewer-access',
					id_token: idToken({ sub: 'viewer-sub', preferred_username: 'viewer-name' }),
				}),
		);
		await step(
			'the outsider connects',
			async () => await connect(privateCredential, outsider, { access_token: 'outsider-access' }),
		);
		const tokens: Array<[string, Record<string, unknown>]> = [
			[
				'an email claim',
				{
					id_token: idToken({
						sub: 's',
						email: 'mail@example.com',
						preferred_username: 'pref',
						upn: 'upn@example.com',
					}),
				},
			],
			['a preferred user name', { id_token: idToken({ sub: 's', preferred_username: 'pref' }) }],
			['a upn', { id_token: idToken({ sub: 's', upn: 'upn@example.com' }) }],
			['only a subject', { id_token: idToken({ sub: 's' }) }],
			['a name', { id_token: idToken({ sub: 's', name: 'Full Name' }) }],
			['an id token that is not a JWT', { id_token: 'opaque' }],
			['an email in the token data', { email: 'data@example.com' }],
			['a user object in the token data', { user: { email: 'user@example.com' } }],
		];
		for (const [label, data] of tokens) {
			await connect(accounts, owner, { access_token: 'a', ...data });
			await step(
				`the account of a connection with ${label}`,
				async () => await ownerAgent.get(`/credentials/${accounts.id}`),
			);
		}
		await step('GET /credentials as the owner', async () => await ownerAgent.get('/credentials'));
		await step('GET /credentials as the editor', async () => await editorAgent.get('/credentials'));
		await step(
			'GET /credentials as the outsider',
			async () => await outsiderAgent.get('/credentials'),
		);
		await step(
			'GET the private credential as the owner',
			async () => await ownerAgent.get(`/credentials/${privateCredential.id}`),
		);
		await step(
			'GET the private credential with data as the owner',
			async () => await ownerAgent.get(`/credentials/${privateCredential.id}?includeData=true`),
		);
		await step(
			'GET the private credential with data as the editor',
			async () => await editorAgent.get(`/credentials/${privateCredential.id}?includeData=true`),
		);
		await step(
			'GET the private credential as the viewer',
			async () => await viewerAgent.get(`/credentials/${privateCredential.id}`),
		);
		await step(
			'GET the static credential with data',
			async () => await ownerAgent.get(`/credentials/${staticCredential.id}?includeData=true`),
		);
		await step('the connection proxy for the editor', async () => {
			const map = await Container.get(CredentialConnectionStatusProxy).findMyConnections(
				editor.id,
				[privateCredential.id, staticCredential.id, 'unknown'],
			);
			return Object.fromEntries([...map].map(([key, value]) => [rec.labelString(key), value]));
		});
		await step('the count of connected users', async () => ({
			private: await Container.get(CredentialConnectionStatusProxy).countConnectedUsers(
				privateCredential.id,
			),
			static: await Container.get(CredentialConnectionStatusProxy).countConnectedUsers(
				staticCredential.id,
			),
		}));
		await step(
			'remove the connections of users who lost access',
			async () =>
				await Container.get(CredentialConnectionStatusProxy).cleanupOrphanedEntriesForUsers([
					owner.id,
					editor.id,
					viewer.id,
					outsider.id,
				]),
		);
		await step(
			'remove the connections of one credential for users',
			async () =>
				await Container.get(CredentialConnectionStatusProxy).cleanupOrphanedEntriesForUsers(
					[owner.id, viewer.id],
					undefined,
					accounts.id,
				),
		);
		const zulip = await credential(
			'Zulip',
			team,
			{ isResolvable: true, data: ZULIP_STATIC },
			'zulipApi',
		);
		const zulipMeta = {
			id: zulip.id,
			name: zulip.name,
			type: zulip.type,
			isResolvable: true,
			resolverId: SYSTEM,
		};
		await step(
			'store a credential with resolvable fields',
			async () =>
				await Container.get(DynamicCredentialsProxy).storeIfNeeded(
					zulipMeta,
					{
						url: 'https://user.zulip.example.com',
						email: 'user@example.com',
						apiKey: 'user-key',
						extra: 'kept?',
						oauthTokenData: { access_token: 'zulip-access' },
					},
					manual(owner),
					{ ...ZULIP_STATIC },
				),
		);
		await step(
			'resolve a credential with resolvable fields',
			async () =>
				await Container.get(DynamicCredentialsProxy).resolveIfNeeded(
					zulipMeta,
					{ ...ZULIP_STATIC },
					await manualRun(owner),
				),
		);
		await step(
			'GET the credential with resolvable fields with data',
			async () => await ownerAgent.get(`/credentials/${zulip.id}?includeData=true`),
		);
		await step(
			'the account of a connection without token data',
			async () => await ownerAgent.get(`/credentials/${zulip.id}`),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the removal of connections', async () => {
		const privateCredential = await credential('Private', team, { isResolvable: true });
		const connectAll = async () => {
			for (const user of [owner, editor, viewer]) {
				await connect(privateCredential, user, { access_token: `${user.id}-access` });
			}
		};
		await connectAll();
		const patch = async (body: Record<string, unknown>) =>
			await ownerAgent
				.patch(`/credentials/${privateCredential.id}`)
				.send({ name: 'Private', type: 'oAuth2Api', data: { ...DATA }, ...body });
		await step('PATCH a name', async () => await patch({ name: 'Private renamed' }));
		await step('PATCH the same client id', async () => await patch({ isResolvable: true }));
		await step(
			'PATCH the blanked client secret',
			async () => await patch({ data: { ...DATA, clientSecret: CREDENTIAL_BLANKING_VALUE } }),
		);
		await step(
			'PATCH another client id',
			async () => await patch({ data: { ...DATA, clientId: 'new-client' }, isResolvable: true }),
		);
		await connectAll();
		await step(
			'PATCH another scope',
			async () => await patch({ data: { ...DATA, clientId: 'new-client', scope: 'openid email' } }),
		);
		await connectAll();
		await step('PATCH another client secret', async () => await patch({ data: NEW_DATA }));
		await connectAll();
		await step(
			'PATCH a field that is not declared',
			async () => await patch({ data: { ...NEW_DATA, custom: 'x' } }),
		);
		await step(
			'PATCH without data',
			async () =>
				await ownerAgent
					.patch(`/credentials/${privateCredential.id}`)
					.send({ name: 'Private', type: 'oAuth2Api' }),
		);
		await step('PATCH to static', async () => await patch({ data: NEW_DATA, isResolvable: false }));
		await step(
			'PATCH back to private',
			async () => await patch({ data: NEW_DATA, isResolvable: true }),
		);
		await connectAll();
		await step(
			'PATCH as the viewer',
			async () =>
				await viewerAgent.patch(`/credentials/${privateCredential.id}`).send({
					name: 'Private',
					type: 'oAuth2Api',
					data: { ...NEW_DATA, clientId: 'viewer-client' },
				}),
		);
		await step(
			'PATCH as the editor',
			async () =>
				await editorAgent.patch(`/credentials/${privateCredential.id}`).send({
					name: 'Private',
					type: 'oAuth2Api',
					data: { ...NEW_DATA, clientId: 'editor-client' },
				}),
		);
		await connectAll();
		await connect(privateCredential, outsider, { access_token: 'outsider-access' });
		await step(
			'share the credential with the other project',
			async () =>
				await ownerAgent
					.put(`/credentials/${privateCredential.id}/share`)
					.send({ shareWithIds: [other.id] }),
		);
		await connect(privateCredential, outsider, { access_token: 'outsider-access-2' });
		await step(
			'stop sharing with the other project',
			async () =>
				await ownerAgent
					.put(`/credentials/${privateCredential.id}/share`)
					.send({ shareWithIds: [] }),
		);
		await step(
			'the viewer leaves the project',
			async () =>
				await ownerAgent.patch(`/projects/${team.id}`).send({
					relations: [
						{ userId: owner.id, role: 'project:admin' },
						{ userId: editor.id, role: 'project:editor' },
					],
				}),
		);
		await step(
			'the editor becomes a viewer',
			async () =>
				await ownerAgent.patch(`/projects/${team.id}`).send({
					relations: [
						{ userId: owner.id, role: 'project:admin' },
						{ userId: editor.id, role: 'project:viewer' },
					],
				}),
		);
		const leaver = await createMember();
		rec.label(leaver.id, 'leaver');
		await linkUserToProject(leaver, team, 'project:editor');
		await connect(privateCredential, leaver, { access_token: 'leaver-access' });
		await step('a connected user goes', async () => await ownerAgent.delete(`/users/${leaver.id}`));
		await step(
			'remove the connections of the credential',
			async () =>
				await Container.get(CredentialConnectionStatusProxy).deleteAllUserEntries(
					privateCredential.id,
				),
		);
		await connect(privateCredential, owner, { access_token: 'owner-access' });
		await step(
			'DELETE the credential',
			async () => await ownerAgent.delete(`/credentials/${privateCredential.id}`),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the membership changes', async () => {
		const privateCredential = await credential('Private', team, { isResolvable: true });
		const connectAll = async (suffix: string) => {
			for (const user of [owner, editor, viewer, outsider]) {
				await connect(privateCredential, user, { access_token: `${user.id}-${suffix}` });
			}
		};
		await connectAll('access');
		// Entries for a credential of a project that the editor and the viewer cannot open.
		const orphan = await credential('Orphan', other, { isResolvable: true });
		await connect(orphan, editor, { access_token: 'editor-orphan' });
		await connect(orphan, viewer, { access_token: 'viewer-orphan' });
		await step(
			'the editor becomes a viewer through the member route',
			async () =>
				await ownerAgent
					.patch(`/projects/${team.id}/users/${editor.id}`)
					.send({ role: 'project:viewer' }),
		);
		await step(
			'the viewer leaves through the member route',
			async () => await ownerAgent.delete(`/projects/${team.id}/users/${viewer.id}`),
		);
		await step(
			'the outsider joins through the member route',
			async () =>
				await ownerAgent
					.post(`/projects/${team.id}/users`)
					.send({ relations: [{ userId: outsider.id, role: 'project:editor' }] }),
		);
		await step(
			'the global role of the editor changes',
			async () =>
				await ownerAgent.patch(`/users/${editor.id}/role`).send({ newRoleName: 'global:admin' }),
		);
		await step(
			'the global role of the editor changes back',
			async () =>
				await ownerAgent.patch(`/users/${editor.id}/role`).send({ newRoleName: 'global:member' }),
		);
		await connectAll('access-2');
		await step(
			'transfer the credential to the other project',
			async () =>
				await ownerAgent
					.put(`/credentials/${privateCredential.id}/transfer`)
					.send({ destinationProjectId: other.id }),
		);
		await connectAll('access-3');
		const otherMember = await createMember();
		rec.label(otherMember.id, 'other member');
		await linkUserToProject(otherMember, other, 'project:editor');
		await connect(privateCredential, otherMember, { access_token: 'other-member-access' });
		// An entry for a credential of a project that the other member cannot open.
		const fourth = await createTeamProject('Fourth', owner);
		rec.label(fourth.id, 'project Fourth');
		const elsewhere = await credential('Elsewhere', fourth, { isResolvable: true });
		await connect(elsewhere, otherMember, { access_token: 'other-member-elsewhere' });
		await step(
			'DELETE the other project with a transfer to the team project',
			async () => await ownerAgent.delete(`/projects/${other.id}?transferId=${team.id}`),
		);
		const third = await createTeamProject('Third', owner);
		rec.label(third.id, 'project Third');
		const thirdCredential = await credential('Third', third, { isResolvable: true });
		await connect(thirdCredential, owner, { access_token: 'third-access' });
		await step(
			'DELETE a project without a transfer',
			async () => await ownerAgent.delete(`/projects/${third.id}`),
		);
		const leaver = await createMember();
		rec.label(leaver.id, 'leaver');
		await linkUserToProject(leaver, team, 'project:editor');
		await connect(privateCredential, leaver, { access_token: 'leaver-access' });
		await step(
			'DELETE a user with a transfer of the data',
			async () => await ownerAgent.delete(`/users/${leaver.id}?transferId=${team.id}`),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the shared fields of credential types', async () => {
		const loader = Container.get(LoadNodesAndCredentials);
		const type = (name: string) => loader.getCredential(name).type as ICredentialType;
		const shared = async (name: string) => {
			const result: unknown = extractSharedFields(type(name));
			return { kind: ctorName(result), fields: result instanceof Set ? [...result] : result };
		};
		await step('the kind of the results', async () => ({
			extractSharedFields: isPromise(extractSharedFields(type('oAuth2Api'))),
			getChangedSharedFields: isPromise(
				getChangedSharedFields(type('oAuth2Api'), DATA as never, DATA as never),
			),
		}));
		for (const name of [
			'oAuth2Api',
			'slackOAuth2Api',
			'zulipApi',
			'httpBasicAuth',
			'httpBearerAuth',
		]) {
			await step(`the shared fields of ${name}`, async () => await shared(name));
		}
		const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [
			['no change', 'oAuth2Api', DATA, { ...DATA }],
			['a new client id', 'oAuth2Api', DATA, { ...DATA, clientId: 'x' }],
			['a new client secret', 'oAuth2Api', DATA, { ...DATA, clientSecret: 'x' }],
			['a new scope and URL', 'oAuth2Api', DATA, { ...DATA, scope: 'x', authUrl: 'https://x' }],
			['a removed field', 'oAuth2Api', DATA, { grantType: 'authorizationCode' }],
			['an added field', 'oAuth2Api', { grantType: 'authorizationCode' }, DATA],
			['an undeclared field', 'oAuth2Api', DATA, { ...DATA, custom: 'x' }],
			['token data', 'oAuth2Api', DATA, { ...DATA, oauthTokenData: { access_token: 'x' } }],
			['a parent field of an extending type', 'slackOAuth2Api', DATA, { ...DATA, clientId: 'x' }],
			[
				'an own field of an extending type',
				'slackOAuth2Api',
				DATA,
				{ ...DATA, signatureSecret: 'x' },
			],
			['a number as text', 'oAuth2Api', { ...DATA, scope: 1 }, { ...DATA, scope: '1' }],
			[
				'a nested object',
				'oAuth2Api',
				{ ...DATA, authQueryParameters: { a: 1 } },
				{ ...DATA, authQueryParameters: { a: 1 } },
			],
			[
				'a nested object in another key order',
				'oAuth2Api',
				{ ...DATA, authQueryParameters: { a: 1, b: 2 } },
				{ ...DATA, authQueryParameters: { b: 2, a: 1 } },
			],
			[
				'a changed nested object',
				'oAuth2Api',
				{ ...DATA, authQueryParameters: { a: 1 } },
				{ ...DATA, authQueryParameters: { a: 2 } },
			],
			[
				'an array in another order',
				'oAuth2Api',
				{ ...DATA, authQueryParameters: [1, 2] },
				{ ...DATA, authQueryParameters: [2, 1] },
			],
			['an undefined value', 'oAuth2Api', DATA, { ...DATA, clientId: undefined }],
			['a null value', 'oAuth2Api', DATA, { ...DATA, clientId: null }],
			['an empty text', 'oAuth2Api', DATA, { ...DATA, clientId: '' }],
			['fields in another order', 'oAuth2Api', DATA, { scope: 'x', clientId: 'y' }],
			[
				'a resolvable field',
				'zulipApi',
				ZULIP_STATIC,
				{ ...ZULIP_STATIC, email: 'x', apiKey: 'y' },
			],
			[
				'a shared field of a type with resolvable fields',
				'zulipApi',
				ZULIP_STATIC,
				{ ...ZULIP_STATIC, url: 'https://x' },
			],
			[
				'a type without shared fields',
				'httpBasicAuth',
				{ user: 'a', password: 'b' },
				{ user: 'c', password: 'd' },
			],
		];
		for (const [label, typeName, oldData, newData] of cases) {
			await step(`the changed shared fields: ${label}`, async () =>
				getChangedSharedFields(type(typeName), oldData as never, newData as never),
			);
		}
		expect(transcript).toMatchSnapshot();
	});

	test('the module', async () => {
		const module = Container.get(DynamicCredentialsModule) as unknown as {
			entities(): Promise<Array<{ name: string }>>;
			context(): Promise<Record<string, unknown>>;
			shutdown(): Promise<void>;
			init(): Promise<void>;
		};
		await step('the entities', async () => (await module.entities()).map((entity) => entity.name));
		await step('the context', async () =>
			Object.fromEntries(
				Object.entries(await module.context()).map(([key, value]) => [key, ctorName(value)]),
			),
		);
		await step('the registered context', async () => {
			const context = Container.get(ModuleRegistry).context.get('dynamic-credentials') as
				| Record<string, unknown>
				| undefined;
			return context ? Object.keys(context) : null;
		});
		const providers = () => ({
			storage: ctorName(
				(Container.get(DynamicCredentialsProxy) as unknown as Record<string, unknown>)
					.storageProvider,
			),
			resolving: ctorName(
				(Container.get(DynamicCredentialsProxy) as unknown as Record<string, unknown>)
					.resolvingProvider,
			),
			connections: ctorName(
				(Container.get(CredentialConnectionStatusProxy) as unknown as Record<string, unknown>)
					.provider,
			),
			identifier: ctorName(
				(Container.get(ExecutingUserIdentifierProxy) as unknown as Record<string, unknown>)
					.provider,
			),
		});
		await step('the providers', async () => providers());
		await step('the listeners of n8n events', async () => {
			const service = Container.get(EventService);
			return Object.fromEntries(
				service
					.eventNames()
					.map((name) => [String(name), service.listenerCount(name)] as const)
					.sort(([a], [b]) => a.localeCompare(b)),
			);
		});
		await Container.get(WorkflowRepository).manager.query(
			"DELETE FROM dynamic_credential_resolver WHERE id = 'system-n8n'",
		);
		await step('init again without the system resolver', async () => await module.init());
		await step('init again with the system resolver', async () => await module.init());
		await step('shutdown', async () => await module.shutdown());
		await step('the providers after the shutdown', async () => providers());
		await step('the system resolver id after the shutdown', async () =>
			Container.get(DynamicCredentialsProxy).getSystemResolverId(),
		);
		expect(transcript).toMatchSnapshot();
	});
});
