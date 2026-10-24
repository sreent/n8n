// Fork test (not in upstream n8n): the resolution and the storage of dynamic credentials as a
// black box. The test calls the ordinary proxies that the credentials helper, the OAuth flow and
// the redaction layer call (`DynamicCredentialsProxy` and `ExecutingUserIdentifierProxy`), with
// the identities of a manual run (the session cookie), of a request (the cookie and the browser
// id), of an n8n OAuth token and of a bearer token, and with a fake OAuth2 provider for the OAuth2
// resolvers. It records the results, the errors, the stored entries (decrypted), the requests to
// the provider and the calls to the n8n token verifier and to the gate of sealed identities. The
// snapshot was recorded against the enterprise module, and the fork module gives the same
// snapshot. See
// `packages/cli/src/modules/dynamic-credentials/README.md`.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { Logger } from '@n8n/backend-common';
import { ExecutingUserIdentifierProxy } from '@n8n/backend-services';
import {
	OAuthTokenVerifierProxy,
	type OAuthTokenVerifier,
	type UserWithContext,
} from '@n8n/backend-services/auth';
import { testDb } from '@n8n/backend-test-utils';
import type { CredentialsEntity, User } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { TrustedSourceGate } from '@n8n/inbound-auth';
import { exportJWK, SignJWT } from 'jose';
import { OAuth2Api } from 'n8n-nodes-base/credentials/OAuth2Api.credentials';
import { SlackOAuth2Api } from 'n8n-nodes-base/credentials/SlackOAuth2Api.credentials';
import { Cipher, ExecutionContextHookRegistry, ExecutionContextService } from 'n8n-core';
import type {
	ICredentialContext,
	ICredentialDataDecryptedObject,
	IExecutionContext,
	IWorkflowSettings,
	OAuthResourceGrant,
	PlaintextExecutionContext,
} from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { DynamicCredentialsProxy } from '@/credentials/dynamic-credentials-proxy';
import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
import { saveCredential } from '@test-integration/db/credentials';
import { createMember, createOwner, createUser } from '@test-integration/db/users';
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
let member: User;
let ownerAgent: SuperAgentTest;

const proxy = () => Container.get(DynamicCredentialsProxy);
const contexts = () => Container.get(ExecutionContextService);

// #region The fake n8n token verifier and the fake gate of sealed identities

const verifierCalls: unknown[][] = [];

/** Tokens of the n8n OAuth server: the user of each token and the grant that admitted it. */
const n8nTokens = new Map<string, { user: () => User; grant?: OAuthResourceGrant }>();
let sealedGrantAllowed = true;

const fakeVerifier: OAuthTokenVerifier = {
	async verifyOAuthAccessToken(token, expectedAudience, grant): Promise<UserWithContext> {
		verifierCalls.push(['verifyOAuthAccessToken', token, expectedAudience ?? null, grant ?? null]);
		const known = n8nTokens.get(token);
		if (!known) {
			return { user: null, context: { reason: 'invalid_token', auth_type: 'oauth' } };
		}
		return { user: known.user(), grant: known.grant };
	},
};

/** Re-checks a sealed identity in place of the gate of the module `inbound-auth-core`. */
class FakeTrustedSourceGate extends TrustedSourceGate {
	async authorizeSealed(input: Parameters<TrustedSourceGate['authorizeSealed']>[0]) {
		verifierCalls.push(['authorizeSealed', input]);
		return sealedGrantAllowed;
	}
}

// Bind the gate before the module starts, as the module `inbound-auth-core` does: a service can
// take the gate when the container creates it.
Container.set(TrustedSourceGate, new FakeTrustedSourceGate());

// #endregion

// #region Recording

/** A stored value as its plain value, without the random ciphertext. */
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
	const line = (value: unknown) => JSON.stringify(rec.normalize(value));
	const entries = await query('SELECT * FROM dynamic_credential_entry');
	const userEntries = await query('SELECT * FROM dynamic_credential_user_entry');
	return {
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

let transcript: unknown[] = [];

type LogMock = { mock?: { calls: unknown[][] }; mockClear?: () => void };

/** The log lines of the module (only the first line of each message). */
function takeLogs() {
	const root = Container.get(Logger) as unknown as Record<string, LogMock> & {
		scoped?: () => Record<string, LogMock>;
	};
	const scoped = typeof root.scoped === 'function' ? root.scoped() : undefined;
	const result: unknown[] = [];
	for (const source of [root, scoped]) {
		if (!source) continue;
		for (const level of ['error', 'warn', 'info', 'debug']) {
			const method = source[level];
			if (!method?.mock) continue;
			for (const call of method.mock.calls) {
				result.push([level, rec.labelString(String(call[0]).split('\n')[0])]);
			}
			method.mockClear?.();
		}
	}
	return result;
}

/** The causes of an error, with the first line of each message. */
function causes(error: unknown) {
	const result: string[] = [];
	let current: unknown = error instanceof Error ? error.cause : undefined;
	while (current instanceof Error && result.length < 5) {
		result.push(`${current.constructor.name}: ${rec.labelString(current.message.split('\n')[0])}`);
		current = current.cause;
	}
	return result;
}

async function step(name: string, action: () => Promise<unknown>) {
	const before = await state();
	idp.take();
	takeLogs();
	verifierCalls.length = 0;
	let outcome: unknown;
	try {
		const value = await action();
		if (value !== null && typeof value === 'object' && 'status' in value && 'body' in value) {
			const response = value as { status: number; body: unknown };
			outcome = { status: response.status, body: rec.normalize(response.body) };
		} else {
			outcome = value === undefined ? 'done' : { value: rec.normalize(value) };
		}
	} catch (error) {
		const cause = causes(error);
		outcome = { threw: rec.describeError(error), ...(cause.length ? { causes: cause } : {}) };
	}
	const after = await state();
	const entry: Record<string, unknown> = { step: name, outcome };
	const logs = takeLogs();
	if (logs.length) entry.logs = logs;
	const requests = idp.take();
	if (requests.length) entry.provider = rec.normalize(requests);
	if (verifierCalls.length) entry.verifier = rec.normalize([...verifierCalls]);
	const changes = diff(before, after);
	if (Object.keys(changes).length) entry.changes = changes;
	transcript.push(JSON.parse(idp.label(JSON.stringify(entry))) as unknown);
}

// #endregion

// #region Fixtures

const STATIC_DATA = {
	grantType: 'authorizationCode',
	clientId: 'static-client',
	clientSecret: 'static-secret',
};

async function credential(
	name: string,
	attributes: {
		isResolvable?: boolean;
		resolvableAllowFallback?: boolean;
		resolverId?: string | null;
	},
	type = 'oAuth2Api',
) {
	const saved: CredentialsEntity = await saveCredential(
		{ name, type, data: STATIC_DATA, ...attributes } as never,
		{ user: owner, role: 'credential:owner' },
	);
	rec.label(saved.id, `credential ${name}`);
	return saved;
}

const meta = (c: CredentialsEntity, resolverId?: string) => ({
	id: c.id,
	name: c.name,
	type: c.type,
	isResolvable: c.isResolvable,
	resolverId: resolverId ?? c.resolverId ?? undefined,
});

/** An execution context of a run, with the credential context encrypted. */
async function runContext(credentials?: ICredentialContext): Promise<IExecutionContext> {
	const plain: PlaintextExecutionContext = {
		version: 1,
		establishedAt: 1_700_000_000_000,
		source: 'webhook',
		...(credentials ? { credentials } : {}),
	};
	return await contexts().encryptExecutionContext(plain);
}

const manual = (jwt: string): ICredentialContext => ({
	version: 1,
	identity: jwt,
	metadata: { source: 'manual-execution' },
});

async function resolve(
	c: CredentialsEntity,
	credentials: ICredentialContext | undefined,
	options: {
		settings?: IWorkflowSettings;
		executionId?: string;
		resolverId?: string;
		raw?: IExecutionContext;
	} = {},
) {
	const executionContext = options.raw ?? (credentials ? await runContext(credentials) : undefined);
	return await proxy().resolveIfNeeded(
		meta(c, options.resolverId),
		{ ...STATIC_DATA },
		executionContext,
		options.settings,
		options.executionId,
	);
}

async function store(
	c: CredentialsEntity,
	data: ICredentialDataDecryptedObject,
	credentials: ICredentialContext,
	options: { settings?: IWorkflowSettings; executionId?: string; resolverId?: string } = {},
) {
	return await proxy().storeIfNeeded(
		meta(c, options.resolverId),
		data,
		credentials,
		{ ...STATIC_DATA },
		options.settings,
		options.executionId,
	);
}

/** Creates a resolver through the API and labels its id. */
async function createResolver(name: string, type: string, config: Record<string, unknown>) {
	const response = await ownerAgent.post('/credential-resolvers').send({ name, type, config });
	const id = (response.body as { data?: { id?: string } }).data?.id;
	if (!id)
		throw new Error(`Could not create the resolver ${name}: ${JSON.stringify(response.body)}`);
	rec.label(id, `resolver ${name}`);
	return id;
}

/** The credential context that the bearer token hook gives for a token. */
async function bearer(token: string): Promise<ICredentialContext> {
	const hook = Container.get(ExecutionContextHookRegistry).getHookByName('BearerTokenExtractor');
	if (!hook) throw new Error('The bearer token hook is not registered');
	const result = await hook.execute({
		triggerNode: {
			id: 'trigger',
			name: 'Webhook',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			position: [0, 0],
			parameters: {},
		},
		workflow: {} as never,
		triggerItems: [{ json: { headers: { authorization: `Bearer ${token}` } } }],
		context: { version: 1, establishedAt: 1_700_000_000_000, source: 'webhook' },
		options: {},
	});
	const credentials = result.contextUpdate?.credentials;
	if (!credentials) throw new Error('The bearer token hook gave no credentials');
	return credentials;
}

// Signing keys of the fake provider.
let signingKey: KeyObject;
let otherKey: KeyObject;
const jwk = async (key: KeyObject, kid: string) => ({
	...(await exportJWK(key)),
	kid,
	alg: 'RS256',
	use: 'sig',
});

async function jwt(
	label: string,
	claims: Record<string, unknown>,
	options: { kid?: string; key?: KeyObject; expiresIn?: number } = {},
) {
	const now = Math.floor(Date.now() / 1000);
	const token = await new SignJWT(claims)
		.setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'key-1' })
		.setIssuedAt(now)
		.setExpirationTime(now + (options.expiresIn ?? 3600))
		.sign(options.key ?? signingKey);
	rec.label(token, `jwt ${label}`);
	return token;
}

// #endregion

beforeAll(async () => {
	await idp.start();
	await Container.get(ExecutionContextHookRegistry).init();
	Container.get(LoadNodesAndCredentials).loaded.credentials.oAuth2Api = {
		type: new OAuth2Api(),
		sourcePath: '',
	};
	Container.get(LoadNodesAndCredentials).loaded.credentials.slackOAuth2Api = {
		type: new SlackOAuth2Api(),
		sourcePath: '',
	};
	owner = await createOwner();
	member = await createMember();
	ownerAgent = testServer.authAgentFor(owner);
	rec.label(owner.id, 'owner');
	rec.label(member.id, 'member');
	const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
	signingKey = pair.privateKey;
	const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
	otherKey = other.privateKey;
	(globalThis as Record<string, unknown>).__publicKeys = {
		main: pair.publicKey,
		other: other.publicKey,
	};
});

afterAll(async () => {
	await idp.stop();
});

beforeEach(async () => {
	transcript = [];
	idp.reset();
	n8nTokens.clear();
	sealedGrantAllowed = true;
	const manager = Container.get(WorkflowRepository).manager;
	await manager.query("DELETE FROM dynamic_credential_resolver WHERE id != 'system-n8n'");
	for (const entity of [
		'DynamicCredentialUserEntry',
		'DynamicCredentialEntry',
		'SharedCredentials',
		'CredentialsEntity',
	] as const) {
		await testDb.truncate([entity]);
	}
});

describe('dynamic credential resolution', () => {
	test('the system resolver with the session of a manual run', async () => {
		const staticCredential = await credential('Static', { isResolvable: false });
		const privateCredential = await credential('Private', { isResolvable: true });
		const fallbackCredential = await credential('Fallback', {
			isResolvable: true,
			resolvableAllowFallback: true,
		});
		const auth = Container.get(AuthService);
		const ownerJwt = auth.issueJWT(owner, false, 'browser-1');
		rec.label(ownerJwt, 'jwt owner');
		const memberJwt = auth.issueJWT(member, false);
		rec.label(memberJwt, 'jwt member');
		const disabled = await createUser({ email: 'disabled@example.com', disabled: true });
		rec.label(disabled.id, 'disabled');
		const disabledJwt = auth.issueJWT(disabled, false);
		rec.label(disabledJwt, 'jwt disabled');

		await step('the system resolver id', async () => ({
			system: proxy().getSystemResolverId(),
			effectiveNone: proxy().getEffectiveResolverId(undefined),
			effectiveEmpty: proxy().getEffectiveResolverId({}),
			effectiveOverride: proxy().getEffectiveResolverId({ credentialResolverId: 'override' }),
		}));
		await step(
			'resolve a static credential without a context',
			async () => await resolve(staticCredential, undefined),
		);
		await step(
			'resolve a static credential with the owner session',
			async () => await resolve(staticCredential, manual(ownerJwt)),
		);
		await step(
			'resolve the private credential without a context',
			async () => await resolve(privateCredential, undefined),
		);
		await step(
			'resolve the private credential with a context without credentials',
			async () => await resolve(privateCredential, undefined, { raw: await runContext() }),
		);
		await step(
			'resolve the private credential before the owner connects',
			async () => await resolve(privateCredential, manual(ownerJwt)),
		);
		await step(
			'resolve the fallback credential before the owner connects',
			async () => await resolve(fallbackCredential, manual(ownerJwt)),
		);
		await step(
			'store the token of the owner',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'owner-access', refresh_token: 'owner-refresh' } },
					manual(ownerJwt),
				),
		);
		await step(
			'resolve the private credential with the owner session',
			async () => await resolve(privateCredential, manual(ownerJwt)),
		);
		await step(
			'resolve the private credential with the member session',
			async () => await resolve(privateCredential, manual(memberJwt)),
		);
		await step(
			'resolve the fallback credential with the member session',
			async () => await resolve(fallbackCredential, manual(memberJwt)),
		);
		await step(
			'store a second token of the owner',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'owner-access-2' } },
					manual(ownerJwt),
				),
		);
		await step(
			'store the token of the member with extra fields',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'member-access' }, clientSecret: 'member-secret' },
					manual(memberJwt),
				),
		);
		await step(
			'store a field that the credential type does not declare',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'member-access' }, customField: 'custom', scope: 'x' },
					manual(memberJwt),
				),
		);
		await step(
			'store only a declared field',
			async () => await store(privateCredential, { clientId: 'member-client' }, manual(memberJwt)),
		);
		await step(
			'store an empty object',
			async () => await store(privateCredential, {}, manual(memberJwt)),
		);
		const slackCredential = await credential(
			'Slack private',
			{ isResolvable: true },
			'slackOAuth2Api',
		);
		await step(
			'store fields of a credential type that extends another',
			async () =>
				await store(
					slackCredential,
					{
						oauthTokenData: { access_token: 'slack-access' },
						clientId: 'parent-field',
						signatureSecret: 'own-field',
						customField: 'custom',
					},
					manual(ownerJwt),
				),
		);
		await step(
			'resolve the credential type that extends another',
			async () => await resolve(slackCredential, manual(ownerJwt)),
		);
		await step(
			'store the member token again',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'member-access' } },
					manual(memberJwt),
				),
		);
		await step(
			'resolve the private credential with the member session after the store',
			async () => await resolve(privateCredential, manual(memberJwt)),
		);
		await step(
			'resolve with a session that is not a JWT',
			async () => await resolve(privateCredential, manual('not-a-jwt')),
		);
		await step(
			'resolve with the session of a disabled user',
			async () => await resolve(privateCredential, manual(disabledJwt)),
		);
		await step(
			'store with a session that is not a JWT',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'x' } },
					manual('not-a-jwt'),
				),
		);
		await step(
			'resolve with a context without metadata',
			async () => await resolve(privateCredential, { version: 1, identity: ownerJwt }),
		);
		await step(
			'resolve with an unknown source',
			async () =>
				await resolve(privateCredential, {
					version: 1,
					identity: ownerJwt,
					metadata: { source: 'other' },
				}),
		);
		await step(
			'resolve with a request-bound context of the right browser',
			async () =>
				await resolve(
					privateCredential,
					contexts().buildRequestBoundCredentialContext(ownerJwt, {
						method: 'POST',
						endpoint: '/rest/workflows/:workflowId/run',
						browserId: 'browser-1',
					}),
				),
		);
		await step(
			'resolve with a request-bound context of another browser',
			async () =>
				await resolve(
					privateCredential,
					contexts().buildRequestBoundCredentialContext(ownerJwt, {
						method: 'POST',
						endpoint: '/rest/workflows/:workflowId/run',
						browserId: 'browser-2',
					}),
				),
		);
		await step(
			'resolve with a request-bound context without a browser',
			async () =>
				await resolve(
					privateCredential,
					contexts().buildRequestBoundCredentialContext(ownerJwt, {
						method: 'POST',
						endpoint: '/rest/workflows/:workflowId/run',
					}),
				),
		);
		await step(
			'resolve with an unknown workflow resolver',
			async () =>
				await resolve(privateCredential, manual(ownerJwt), {
					settings: { credentialResolverId: 'unknown' },
				}),
		);
		await step(
			'resolve the fallback credential with an unknown workflow resolver',
			async () =>
				await resolve(fallbackCredential, manual(ownerJwt), {
					settings: { credentialResolverId: 'unknown' },
				}),
		);
		await step(
			'store with an unknown workflow resolver',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'x' } },
					manual(ownerJwt),
					{
						settings: { credentialResolverId: 'unknown' },
					},
				),
		);
		await step(
			'store for a static credential',
			async () =>
				await store(staticCredential, { oauthTokenData: { access_token: 'x' } }, manual(ownerJwt)),
		);
		await step(
			'identify the owner session',
			async () => await Container.get(ExecutingUserIdentifierProxy).identify(manual(ownerJwt)),
		);
		await step(
			'identify a request-bound context',
			async () =>
				await Container.get(ExecutingUserIdentifierProxy).identify(
					contexts().buildRequestBoundCredentialContext(ownerJwt, {
						method: 'GET',
						endpoint: '/rest/x',
						browserId: 'browser-1',
					}),
				),
		);
		await step(
			'identify a session that is not a JWT',
			async () => await Container.get(ExecutingUserIdentifierProxy).identify(manual('not-a-jwt')),
		);
		await step(
			'identify a bearer token',
			async () =>
				await Container.get(ExecutingUserIdentifierProxy).identify(await bearer('external-token')),
		);
		await step(
			'store the OAuth token data of the owner',
			async () =>
				await proxy().storeOAuthTokenDataIfNeeded(
					meta(privateCredential, 'system-n8n'),
					{ access_token: 'oauth-owner' },
					await runContext(manual(ownerJwt)),
					{ ...STATIC_DATA },
				),
		);
		await step(
			'store the OAuth token data without a resolver',
			async () =>
				await proxy().storeOAuthTokenDataIfNeeded(
					meta(privateCredential),
					{ access_token: 'oauth-none' },
					await runContext(manual(ownerJwt)),
					{ ...STATIC_DATA },
				),
		);
		await step(
			'store the OAuth token data without a context',
			async () =>
				await proxy().storeOAuthTokenDataIfNeeded(
					meta(privateCredential, 'system-n8n'),
					{ access_token: 'oauth-missing' },
					undefined,
					{ ...STATIC_DATA },
				),
		);
		await step(
			'resolve after the OAuth token data',
			async () => await resolve(privateCredential, manual(ownerJwt)),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the system resolver with n8n OAuth tokens', async () => {
		const privateCredential = await credential('Private', { isResolvable: true });
		const resource = 'http://localhost:5678/mcp/workflow';
		const grant: OAuthResourceGrant = { audiences: [resource], executeAccessWorkflowId: 'wf-1' };
		const oauth = async (
			token: string,
			options: { subject?: string; binding?: { sourceId: string; subject: string } } = {},
		) =>
			(await contexts().decryptCredentialContext(
				await contexts().buildTriggerIdentityCredentials(
					token,
					resource,
					grant,
					options.subject,
					options.binding,
				),
			)) as ICredentialContext;
		/** A seal of an older version of n8n: it has no version and no grant. */
		const legacySeal = async (token: string, subject: string) =>
			(await contexts().decryptCredentialContext(
				await Container.get(Cipher).encryptV2({
					version: 1,
					identity: token,
					metadata: { source: 'n8n-oauth', resource, establishedAt: 0, executionPath: [], subject },
				}),
			)) as ICredentialContext;
		const bound = async (credentials: ICredentialContext, executionId: string) => {
			const encrypted = await contexts().maybeBindExecutionId(
				await runContext(credentials),
				executionId,
			);
			return encrypted;
		};
		const withoutTime = (context: ICredentialContext) => context;

		await step(
			'resolve an n8n OAuth token before the verifier is registered',
			async () => await resolve(privateCredential, await oauth('token-owner')),
		);
		Container.get(OAuthTokenVerifierProxy).registerProvider(fakeVerifier);
		n8nTokens.set('token-owner', { user: () => owner, grant });
		n8nTokens.set('token-member', { user: () => member });
		await step(
			'store the token of the owner with an n8n OAuth token',
			async () =>
				await store(
					privateCredential,
					{ oauthTokenData: { access_token: 'owner-access' } },
					await oauth('token-owner'),
				),
		);
		await step(
			'resolve with the n8n OAuth token of the owner',
			async () => await resolve(privateCredential, await oauth('token-owner')),
		);
		await step(
			'resolve with the n8n OAuth token of the member',
			async () => await resolve(privateCredential, await oauth('token-member')),
		);
		await step(
			'resolve with an unknown n8n OAuth token',
			async () => await resolve(privateCredential, await oauth('token-unknown')),
		);
		await step('resolve with a sealed subject in the execution it was bound to', async () => {
			const context = await bound(await oauth('token-gone', { subject: owner.id }), 'execution-1');
			return await resolve(privateCredential, undefined, {
				raw: context,
				executionId: 'execution-1',
			});
		});
		await step('resolve with a sealed subject in another execution', async () => {
			const context = await bound(await oauth('token-gone', { subject: owner.id }), 'execution-1');
			return await resolve(privateCredential, undefined, {
				raw: context,
				executionId: 'execution-2',
			});
		});
		await step('resolve with a sealed subject without an execution id', async () => {
			const context = await bound(await oauth('token-gone', { subject: owner.id }), 'execution-1');
			return await resolve(privateCredential, undefined, { raw: context });
		});
		await step(
			'resolve with a sealed subject that was never bound',
			async () =>
				await resolve(privateCredential, await oauth('token-gone', { subject: owner.id }), {
					executionId: 'execution-3',
				}),
		);
		await step('resolve with a legacy sealed subject without a grant', async () => {
			const context = await bound(await legacySeal('token-gone', owner.id), 'execution-4');
			return await resolve(privateCredential, undefined, {
				raw: context,
				executionId: 'execution-4',
			});
		});
		sealedGrantAllowed = false;
		await step('resolve with a sealed subject whose grant is withdrawn', async () => {
			const context = await bound(await oauth('token-gone', { subject: owner.id }), 'execution-5');
			return await resolve(privateCredential, undefined, {
				raw: context,
				executionId: 'execution-5',
			});
		});
		sealedGrantAllowed = true;
		await step('resolve with a sealed subject of a known token', async () => {
			const context = await bound(await oauth('token-owner', { subject: owner.id }), 'execution-6');
			return await resolve(privateCredential, undefined, {
				raw: context,
				executionId: 'execution-6',
			});
		});
		await step('resolve with a sealed subject that is not the user of the token', async () => {
			const context = await bound(
				await oauth('token-member', { subject: owner.id }),
				'execution-7',
			);
			return await resolve(privateCredential, undefined, {
				raw: context,
				executionId: 'execution-7',
			});
		});
		await step('resolve with a sealed subject that came through a trusted source', async () => {
			const context = await bound(
				await oauth('token-gone', {
					subject: owner.id,
					binding: { sourceId: 'source-1', subject: 'external-owner' },
				}),
				'execution-8',
			);
			return await resolve(privateCredential, undefined, {
				raw: context,
				executionId: 'execution-8',
			});
		});
		await step(
			'identify the n8n OAuth token of the owner',
			async () =>
				await Container.get(ExecutingUserIdentifierProxy).identify(
					withoutTime(await oauth('token-owner')),
				),
		);
		await step(
			'identify a sealed subject',
			async () =>
				await Container.get(ExecutingUserIdentifierProxy).identify(
					await oauth('token-gone', { subject: member.id }),
				),
		);
		await step(
			'identify an unknown n8n OAuth token',
			async () =>
				await Container.get(ExecutingUserIdentifierProxy).identify(await oauth('token-unknown')),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the OAuth2 resolver with token introspection', async () => {
		const resolverId = await createResolver('Introspection', 'credential-resolver.oauth2-1.0', {
			metadataUri: `${idp.baseUrl}/.well-known/openid-configuration`,
			validation: 'oauth2-introspection',
			clientId: 'introspection-client',
			clientSecret: 'introspection-secret',
		});
		const bound = await credential('Bound', { isResolvable: true, resolverId });
		const viaWorkflow = await credential('Via workflow', { isResolvable: true });
		const settings = { credentialResolverId: resolverId };
		idp.introspection.set('active-1', {
			status: 200,
			body: { active: true, sub: 'user-1', aud: 'n8n' },
		});
		idp.introspection.set('active-2', {
			status: 200,
			body: { active: true, sub: 'user-2', email: 'two@example.com', exp: 4_102_444_800 },
		});
		idp.introspection.set('no-sub', { status: 200, body: { active: true } });
		idp.introspection.set('broken', { status: 500, body: { error: 'server_error' } });
		idp.introspection.set('not-json', { status: 200, body: 'text' });

		await step(
			'resolve an inactive token',
			async () => await resolve(bound, await bearer('inactive')),
		);
		await step(
			'resolve an active token before it is stored',
			async () => await resolve(bound, await bearer('active-1')),
		);
		await step(
			'store for an active token',
			async () =>
				await store(
					bound,
					{ oauthTokenData: { access_token: 'subject-1-access' } },
					await bearer('active-1'),
				),
		);
		await step(
			'resolve the active token after the store',
			async () => await resolve(bound, await bearer('active-1')),
		);
		await step(
			'resolve the active token again',
			async () => await resolve(bound, await bearer('active-1')),
		);
		await step(
			'resolve a token without a subject',
			async () => await resolve(bound, await bearer('no-sub')),
		);
		await step(
			'resolve when the introspection fails',
			async () => await resolve(bound, await bearer('broken')),
		);
		await step(
			'resolve when the introspection is not JSON',
			async () => await resolve(bound, await bearer('not-json')),
		);
		await step(
			'store for the second subject',
			async () =>
				await store(
					bound,
					{ oauthTokenData: { access_token: 'subject-2-access' } },
					await bearer('active-2'),
				),
		);
		await step(
			'resolve with the workflow resolver',
			async () => await resolve(viaWorkflow, await bearer('active-2'), { settings }),
		);
		await step(
			'store with the workflow resolver',
			async () =>
				await store(
					viaWorkflow,
					{ oauthTokenData: { access_token: 'via-workflow' } },
					await bearer('active-2'),
					{
						settings,
					},
				),
		);
		await step(
			'resolve with the workflow resolver after the store',
			async () => await resolve(viaWorkflow, await bearer('active-2'), { settings }),
		);
		await step(
			'resolve a bearer token with the system resolver',
			async () => await resolve(viaWorkflow, await bearer('active-2')),
		);
		await step(
			'resolve the owner session with the introspection resolver',
			async () => await resolve(bound, manual(Container.get(AuthService).issueJWT(owner, false))),
		);
		await step(
			'identify a bearer token for the introspection resolver',
			async () =>
				await Container.get(ExecutingUserIdentifierProxy).identify(await bearer('active-1')),
		);
		await step(
			'resolve the inactive token again',
			async () => await resolve(bound, await bearer('inactive')),
		);
		await step(
			'resolve when the introspection fails again',
			async () => await resolve(bound, await bearer('broken')),
		);
		idp.metadata = {
			...idp.defaultMetadata(),
			introspection_endpoint_auth_methods_supported: ['client_secret_post'],
		};
		const postResolver = await createResolver('Post auth', 'credential-resolver.oauth2-1.0', {
			metadataUri: `${idp.baseUrl}/post/.well-known/openid-configuration`,
			validation: 'oauth2-introspection',
			clientId: 'post-client',
			clientSecret: 'post-secret',
			subjectClaim: 'email',
		});
		const postBound = await credential('Post bound', {
			isResolvable: true,
			resolverId: postResolver,
		});
		await step(
			'store with client_secret_post and the email claim',
			async () =>
				await store(
					postBound,
					{ oauthTokenData: { access_token: 'by-email' } },
					await bearer('active-2'),
				),
		);
		await step(
			'resolve with client_secret_post and the email claim',
			async () => await resolve(postBound, await bearer('active-2')),
		);
		await step(
			'resolve a token without the email claim',
			async () => await resolve(postBound, await bearer('active-1')),
		);
		idp.metadata = idp.defaultMetadata();
		const audienceResolver = await createResolver('Audience', 'credential-resolver.oauth2-1.0', {
			metadataUri: `${idp.baseUrl}/audience/.well-known/openid-configuration`,
			validation: 'oauth2-introspection',
			clientId: 'audience-client',
			clientSecret: 'audience-secret',
			expectedAudience: 'n8n',
		});
		const audienceBound = await credential('Audience bound', {
			isResolvable: true,
			resolverId: audienceResolver,
		});
		idp.introspection.set('aud-list', {
			status: 200,
			body: { active: true, sub: 'user-3', aud: ['other', 'n8n'] },
		});
		idp.introspection.set('aud-other', {
			status: 200,
			body: { active: true, sub: 'user-4', aud: 'other' },
		});
		await step(
			'resolve a token with the expected audience',
			async () => await resolve(audienceBound, await bearer('active-1')),
		);
		await step(
			'resolve a token with the audience in a list',
			async () => await resolve(audienceBound, await bearer('aud-list')),
		);
		await step(
			'resolve a token with another audience',
			async () => await resolve(audienceBound, await bearer('aud-other')),
		);
		await step(
			'resolve a token without an audience',
			async () => await resolve(audienceBound, await bearer('active-2')),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the OAuth2 resolver with the userinfo endpoint', async () => {
		const keys = (globalThis as Record<string, unknown>).__publicKeys as {
			main: KeyObject;
			other: KeyObject;
		};
		idp.jwks = { status: 200, body: { keys: [await jwk(keys.main, 'key-1')] } };
		const resolverId = await createResolver('Userinfo', 'credential-resolver.oauth2-1.0', {
			metadataUri: `${idp.baseUrl}/.well-known/openid-configuration`,
			validation: 'oauth2-userinfo',
		});
		const bound = await credential('Bound', { isResolvable: true, resolverId });
		idp.userinfo.set('opaque-1', {
			status: 200,
			body: { sub: 'user-1', email: 'one@example.com' },
		});
		idp.userinfo.set('opaque-no-sub', { status: 200, body: { email: 'none@example.com' } });
		idp.userinfo.set('opaque-broken', { status: 500, body: { error: 'server_error' } });

		await step(
			'resolve an unknown opaque token',
			async () => await resolve(bound, await bearer('opaque-unknown')),
		);
		await step(
			'store for an opaque token',
			async () =>
				await store(
					bound,
					{ oauthTokenData: { access_token: 'user-1-access' } },
					await bearer('opaque-1'),
				),
		);
		await step(
			'resolve the opaque token',
			async () => await resolve(bound, await bearer('opaque-1')),
		);
		await step(
			'resolve the opaque token again',
			async () => await resolve(bound, await bearer('opaque-1')),
		);
		await step(
			'resolve an opaque token without a subject',
			async () => await resolve(bound, await bearer('opaque-no-sub')),
		);
		await step(
			'resolve when the userinfo endpoint fails',
			async () => await resolve(bound, await bearer('opaque-broken')),
		);
		const signed = await jwt('user-1', { sub: 'user-1', aud: 'n8n', iss: idp.baseUrl });
		idp.userinfo.set(signed, { status: 200, body: { sub: 'user-1' } });
		await step('resolve a signed token', async () => await resolve(bound, await bearer(signed)));
		const signedUnknownKey = await jwt(
			'unknown key',
			{ sub: 'user-1', aud: 'n8n' },
			{ kid: 'key-9', key: otherKey },
		);
		idp.userinfo.set(signedUnknownKey, { status: 200, body: { sub: 'user-1' } });
		await step(
			'resolve a token signed with an unknown key',
			async () => await resolve(bound, await bearer(signedUnknownKey)),
		);
		const expired = await jwt('expired', { sub: 'user-1', aud: 'n8n' }, { expiresIn: -60 });
		idp.userinfo.set(expired, { status: 200, body: { sub: 'user-1' } });
		await step(
			'resolve an expired signed token',
			async () => await resolve(bound, await bearer(expired)),
		);
		const audienceResolver = await createResolver(
			'Userinfo audience',
			'credential-resolver.oauth2-1.0',
			{
				metadataUri: `${idp.baseUrl}/.well-known/openid-configuration`,
				validation: 'oauth2-userinfo',
				expectedAudience: 'n8n',
				subjectClaim: 'email',
			},
		);
		const audienceBound = await credential('Audience bound', {
			isResolvable: true,
			resolverId: audienceResolver,
		});
		const iss = idp.baseUrl;
		const withEmail = await jwt('with email', {
			sub: 'user-5',
			aud: 'n8n',
			email: 'five@example.com',
			iss,
		});
		idp.userinfo.set(withEmail, {
			status: 200,
			body: { sub: 'user-5', email: 'five@example.com' },
		});
		const otherAudience = await jwt('other audience', { sub: 'user-6', aud: 'other', iss });
		idp.userinfo.set(otherAudience, {
			status: 200,
			body: { sub: 'user-6', email: 'six@example.com' },
		});
		const noAudience = await jwt('no audience', { sub: 'user-7', iss });
		idp.userinfo.set(noAudience, {
			status: 200,
			body: { sub: 'user-7', email: 'seven@example.com' },
		});
		const audienceList = await jwt('audience list', { sub: 'user-8', aud: ['x', 'n8n'], iss });
		idp.userinfo.set(audienceList, {
			status: 200,
			body: { sub: 'user-8', email: 'eight@example.com' },
		});
		const otherIssuer = await jwt('other issuer', {
			sub: 'user-9',
			aud: 'n8n',
			iss: 'https://other.example.com',
		});
		idp.userinfo.set(otherIssuer, {
			status: 200,
			body: { sub: 'user-9', email: 'nine@example.com' },
		});
		const expiredWithIssuer = await jwt(
			'expired with issuer',
			{ sub: 'user-5', aud: 'n8n', iss },
			{ expiresIn: -60 },
		);
		idp.userinfo.set(expiredWithIssuer, {
			status: 200,
			body: { sub: 'user-5', email: 'five@example.com' },
		});
		const newKey = await jwt(
			'new key',
			{ sub: 'user-5', aud: 'n8n', iss },
			{ kid: 'key-2', key: otherKey },
		);
		idp.userinfo.set(newKey, { status: 200, body: { sub: 'user-5', email: 'five@example.com' } });
		const withoutEmail = await jwt('without email', { sub: 'user-10', aud: 'n8n', iss });
		idp.userinfo.set(withoutEmail, { status: 200, body: { sub: 'user-10' } });
		await step(
			'store with the email claim',
			async () =>
				await store(
					audienceBound,
					{ oauthTokenData: { access_token: 'five' } },
					await bearer(withEmail),
				),
		);
		await step(
			'resolve with the expected audience and the email claim',
			async () => await resolve(audienceBound, await bearer(withEmail)),
		);
		await step(
			'resolve a signed token with another audience',
			async () => await resolve(audienceBound, await bearer(otherAudience)),
		);
		await step(
			'resolve a signed token without an audience',
			async () => await resolve(audienceBound, await bearer(noAudience)),
		);
		await step(
			'resolve a signed token with the audience in a list',
			async () => await resolve(audienceBound, await bearer(audienceList)),
		);
		await step(
			'resolve a signed token of another issuer',
			async () => await resolve(audienceBound, await bearer(otherIssuer)),
		);
		await step(
			'resolve an expired signed token with the issuer',
			async () => await resolve(audienceBound, await bearer(expiredWithIssuer)),
		);
		await step(
			'resolve a token of a key that the key set does not have yet',
			async () => await resolve(audienceBound, await bearer(newKey)),
		);
		idp.jwks = {
			status: 200,
			body: { keys: [await jwk(keys.main, 'key-1'), await jwk(keys.other, 'key-2')] },
		};
		await step(
			'resolve a token of a key after the key set has it',
			async () => await resolve(audienceBound, await bearer(newKey)),
		);
		await step(
			'resolve a signed token whose userinfo has no email',
			async () => await resolve(audienceBound, await bearer(withoutEmail)),
		);
		await step(
			'resolve an opaque token with an expected audience',
			async () => await resolve(audienceBound, await bearer('opaque-1')),
		);
		await step(
			'identify a signed token',
			async () => await Container.get(ExecutingUserIdentifierProxy).identify(await bearer(signed)),
		);
		expect(transcript).toMatchSnapshot();
	});
});
