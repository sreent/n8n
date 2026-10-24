// The behaviour of the OIDC sign-in: the config endpoints, the connection test, the login, the
// callback, the logout, and the service methods that the public API and the instance settings
// loader use. A fake OIDC provider answers the requests of n8n. For each case, the snapshot records
// the response, the cookies, the requests to the provider, the events, the pub/sub commands, the
// sign-in state, and the rows that the case changed. The snapshot records what n8n does, so a
// change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/sso-oidc/FORK.md tells how the fork made the snapshot.
import { EventService, JwtService } from '@n8n/backend-services';
import { mockInstance, testDb } from '@n8n/backend-test-utils';
import { GlobalConfig, InstanceSettingsLoaderConfig } from '@n8n/config';
import {
	AuthIdentity,
	AuthIdentityRepository,
	GLOBAL_ADMIN_ROLE,
	GLOBAL_CHAT_USER_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	SettingsRepository,
	UserRepository,
	type User,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { Cipher, InstanceSettings } from 'n8n-core';
import nock from 'nock';
import request from 'supertest';
import type { MockInstance } from 'vitest';

import { AuthService } from '@/auth/auth.service';
import config from '@/config';
import {
	OIDC_CLIENT_SECRET_REDACTED_VALUE,
	OIDC_PREFERENCES_DB_KEY,
} from '@/modules/sso-oidc/constants';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import { PubSubEventBus } from '@/scaling/pubsub/pubsub.eventbus';
import { PubSubRegistry } from '@/scaling/pubsub/pubsub.registry';
import { setCurrentAuthenticationMethod } from '@/sso/sso-helpers';

import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import { setupTestServer } from '@test-integration/utils';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at `@/modules/sso-oidc/oidc.service.ee` and
// `@/modules/sso-oidc/oidc.controller.ee`.
import { OidcService } from '@/modules/sso-oidc/oidc.service';
import '@/modules/sso-oidc/oidc.controller';

// `openid-client` sends its requests with the fetch that n8n gives it. The test gives it the global
// fetch instead, which nock answers for the fake provider. This is the only change to the code
// under test.
vi.mock('openid-client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('openid-client')>();
	const globalFetch = async (url: string, init: RequestInit) => await fetch(url, init);
	const wrapped: Record<string, unknown> = { ...actual };
	for (const [name, value] of Object.entries(actual)) {
		if (typeof value !== 'function' || /^[A-Z]/.test(name)) continue;
		wrapped[name] = (...args: unknown[]) => {
			if (args[0] instanceof actual.Configuration) {
				(args[0] as unknown as Record<symbol, unknown>)[actual.customFetch] = globalFetch;
			}
			if (name === 'discovery') {
				args[4] = { ...(args[4] as object | undefined), [actual.customFetch]: globalFetch };
			}
			return (value as (...a: unknown[]) => unknown)(...args);
		};
	}
	return wrapped;
});

/** The pub/sub commands that n8n sends. The mock keeps them instead of sending them. */
const published: unknown[] = [];
mockInstance(Publisher).publishCommand.mockImplementation(async (message) => {
	published.push(message);
});

const ISSUER = 'https://idp.example.test';
const DISCOVERY_ENDPOINT = `${ISSUER}/.well-known/openid-configuration`;
const OTHER_ISSUER = 'https://idp2.example.test';
const OTHER_DISCOVERY_ENDPOINT = `${OTHER_ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = 'n8n-client';
const CLIENT_SECRET = 'client-secret';
/** The test server gives every request this `req.browserId`. */
const TEST_SERVER_BROWSER_ID = 'test-browser-id';

const testServer = setupTestServer({ endpointGroups: ['auth'], enabledFeatures: ['feat:oidc'] });
const recorder = new GoldenRecorder();
const { label, labelString, normalize, describeError, dumpDb, diffDumps } = recorder;

// ----------------------------------------------------------------------------------------------
// The fake provider
// ----------------------------------------------------------------------------------------------

type ProviderSettings = {
	discovery:
		| 'ok'
		| 'not found'
		| 'invalid json'
		| 'other issuer'
		| 'no end session endpoint'
		| 'unavailable';
	token: 'ok' | 'invalid grant' | 'server error' | 'no id token';
	signingKey: 'provider key' | 'other key';
	issuer: 'provider' | 'other';
	audience: string;
	/** Seconds from now to the expiry of the id token. */
	lifetime: number;
	nonce: 'login nonce' | 'other nonce' | 'no nonce';
	subject: string;
	claims: Record<string, unknown>;
	userinfo: 'ok' | 'server error' | 'other subject';
	/** The userinfo response. Without it, the provider sends the claims of the id token. */
	userInfo?: Record<string, unknown>;
	/** A padding claim makes the id token this long. */
	idTokenLength?: number;
};

const alice = {
	email: 'alice@example.com',
	email_verified: true,
	given_name: 'Alice',
	family_name: 'Doe',
};

function defaultProviderSettings(): ProviderSettings {
	return {
		discovery: 'ok',
		token: 'ok',
		signingKey: 'provider key',
		issuer: 'provider',
		audience: CLIENT_ID,
		lifetime: 3600,
		nonce: 'login nonce',
		subject: 'alice-sub',
		claims: { ...alice },
		userinfo: 'ok',
	};
}

const provider = {
	settings: defaultProviderSettings(),
	log: [] as unknown[],
	keys: {} as Record<'provider key' | 'other key', CryptoKey>,
	publicJwk: {} as JWK,
	/** The nonce of the last login, which the provider puts in the id token. */
	loginNonce: undefined as string | undefined,
	idTokens: 0,
	accessTokens: 0,
};

function useProvider(changes: Partial<ProviderSettings> = {}) {
	provider.settings = { ...defaultProviderSettings(), ...changes };
}

/** The provider for a person with this name and a verified email, unless the claims say other. */
function usePerson(name: string, claims: Record<string, unknown> = {}) {
	useProvider({
		subject: `${name}-sub`,
		claims: { email: `${name}@example.com`, email_verified: true, ...claims },
	});
}

function describeAuthorization(header: unknown) {
	if (typeof header !== 'string') return '<none>';
	const [scheme, value] = header.split(' ');
	if (scheme === 'Basic') return `Basic ${Buffer.from(value, 'base64').toString()}`;
	return header;
}

function discoveryDocument(issuer: string) {
	const document: Record<string, unknown> = {
		issuer:
			provider.settings.discovery === 'other issuer' ? 'https://elsewhere.example.test' : issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		userinfo_endpoint: `${issuer}/userinfo`,
		jwks_uri: `${issuer}/jwks`,
		end_session_endpoint: `${issuer}/logout`,
		response_types_supported: ['code'],
		subject_types_supported: ['public'],
		id_token_signing_alg_values_supported: ['RS256'],
		scopes_supported: ['openid', 'email', 'profile'],
		token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
		code_challenge_methods_supported: ['S256'],
	};
	if (provider.settings.discovery === 'no end session endpoint') {
		delete document.end_session_endpoint;
	}
	return document;
}

async function signIdToken(issuer: string) {
	const { settings } = provider;
	const now = Math.floor(Date.now() / 1000);
	const nonce =
		settings.nonce === 'login nonce'
			? provider.loginNonce
			: settings.nonce === 'other nonce'
				? 'n8n_nonce:other'
				: undefined;
	const sign = async (claims: Record<string, unknown>) =>
		await new SignJWT({ ...claims, ...(nonce ? { nonce } : {}) })
			.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
			.setIssuer(settings.issuer === 'provider' ? issuer : 'https://elsewhere.example.test')
			.setAudience(settings.audience)
			.setSubject(settings.subject)
			.setIssuedAt(now)
			.setExpirationTime(now + settings.lifetime)
			.sign(provider.keys[settings.signingKey]);
	let token = await sign(settings.claims);
	if (settings.idTokenLength !== undefined) {
		// Base64url makes 4 characters of 3 bytes, so the padding grows by 3/4 of the missing length.
		let padding = 0;
		for (let attempt = 0; token.length !== settings.idTokenLength; attempt++) {
			if (attempt === 20) throw new Error(`No id token of ${settings.idTokenLength} characters`);
			const missing = settings.idTokenLength - token.length;
			padding = Math.max(0, padding + (Math.round((missing * 3) / 4) || Math.sign(missing)));
			token = await sign({ ...settings.claims, padding: 'x'.repeat(padding) });
		}
	}
	provider.idTokens += 1;
	label(token, `id token ${provider.idTokens}`);
	return token;
}

function mountProvider(issuer: string) {
	const host = new URL(issuer).host;
	const scope = nock(issuer).persist();
	scope.get('/.well-known/openid-configuration').reply(() => {
		provider.log.push(`GET ${host} discovery`);
		switch (provider.settings.discovery) {
			case 'not found':
				return [404, 'Not Found'];
			case 'invalid json':
				return [200, 'not json', { 'Content-Type': 'application/json' }];
			case 'unavailable':
				return [503, 'Service Unavailable'];
			default:
				return [200, discoveryDocument(issuer)];
		}
	});
	scope.get('/jwks').reply(() => {
		provider.log.push(`GET ${host} jwks`);
		return [200, { keys: [{ ...provider.publicJwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }];
	});
	scope.post('/token').reply(async function (_uri, body) {
		const form = [
			...new URLSearchParams(typeof body === 'string' ? body : JSON.stringify(body)).entries(),
		];
		provider.log.push({
			request: `POST ${host} token`,
			authorization: describeAuthorization(this.req.headers.authorization),
			form,
		});
		const { settings } = provider;
		if (settings.token === 'invalid grant') {
			return [400, { error: 'invalid_grant', error_description: 'The code is not valid' }];
		}
		if (settings.token === 'server error') return [500, 'Internal Server Error'];
		provider.accessTokens += 1;
		return [
			200,
			{
				access_token: `access-${provider.accessTokens}`,
				...(settings.token === 'no id token' ? {} : { id_token: await signIdToken(issuer) }),
				token_type: 'Bearer',
				expires_in: 3600,
			},
		];
	});
	scope.get('/userinfo').reply(function () {
		provider.log.push({
			request: `GET ${host} userinfo`,
			authorization: describeAuthorization(this.req.headers.authorization),
		});
		const { settings } = provider;
		if (settings.userinfo === 'server error') return [500, 'Internal Server Error'];
		const subject = settings.userinfo === 'other subject' ? 'someone-else' : settings.subject;
		return [200, { ...(settings.userInfo ?? settings.claims), sub: subject }];
	});
}

// ----------------------------------------------------------------------------------------------
// Descriptions of what n8n does
// ----------------------------------------------------------------------------------------------

const counters: Record<string, number> = {};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

/** Give a value of the sign-in flow (a state or a nonce) a numbered label that shows its form. */
function labelFlowValue(value: string, kind: string) {
	if (value === '' || recorder.labels.has(value)) return;
	counters[kind] = (counters[kind] ?? 0) + 1;
	label(value, `${kind} ${counters[kind]} ${value.replace(UUID, '<uuid v4>')}`);
}

/**
 * Give a session token a label: its user. Two sessions of one user in the same second are the same
 * token, so a numbered label would depend on timing.
 */
async function labelSessionToken(token: string) {
	if (recorder.labels.has(token)) return;
	await recorder.labelNewRows(['project', 'user']);
	const payload = Container.get(JwtService).decodeUnverified<{ id?: unknown } | null>(token);
	label(token, `session of ${labelString(String(payload?.id)).replace(/^@/, '')}`);
}

function describeTime(seconds: unknown) {
	return typeof seconds === 'number' && Math.abs(seconds - Date.now() / 1000) < 30
		? 'now'
		: String(seconds);
}

const SECRET_KEYS = new Set(['password', 'mfaSecret', 'mfaRecoveryCodes']);

/** A copy without passwords and MFA secrets. */
function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value instanceof Date) return value;
	if (value !== null && typeof value === 'object') {
		const source =
			'toJSON' in value && typeof value.toJSON === 'function' ? (value.toJSON() as object) : value;
		return Object.fromEntries(
			Object.entries(source).map(([key, entry]) => [
				key,
				SECRET_KEYS.has(key) && entry !== null && entry !== undefined
					? '<redacted>'
					: redact(entry),
			]),
		);
	}
	return value;
}

function describeFlowToken(purpose: 'oidcState' | 'oidcNonce', token: string) {
	const jwtService = Container.get(JwtService);
	let verified: unknown = true;
	try {
		jwtService.verify(purpose, token);
	} catch (error) {
		verified = describeError(error);
	}
	const payload = jwtService.decodeUnverified<Record<string, unknown> | null>(token);
	if (!payload) return { verified, payload: '<not a JWT>' };
	const { iat, exp, ...claims } = payload;
	for (const [key, value] of Object.entries(claims)) {
		if (typeof value === 'string' && (key === 'state' || key === 'nonce')) {
			labelFlowValue(value, key);
		}
	}
	return {
		verified,
		claims: normalize(claims),
		issuedAt: describeTime(iat),
		lifetime: typeof exp === 'number' && typeof iat === 'number' ? exp - iat : String(exp),
	};
}

async function describeSessionToken(token: string) {
	await labelSessionToken(token);
	const jwtService = Container.get(JwtService);
	let verified: unknown = true;
	try {
		jwtService.verify('session', token);
	} catch (error) {
		verified = describeError(error);
	}
	const payload = jwtService.decodeUnverified<Record<string, unknown>>(token);
	const { id, hash, browserId, usedMfa, iat, exp, ...rest } = payload;
	const user = await Container.get(UserRepository).findOne({
		where: { id: String(id) },
		relations: ['role'],
	});
	const expected = user
		? jwtService.decodeUnverified<Record<string, unknown>>(
				Container.get(AuthService).issueJWT(user, Boolean(usedMfa), TEST_SERVER_BROWSER_ID),
			)
		: undefined;
	return {
		verified,
		user: labelString(String(id)),
		hash: !expected ? '<no user>' : hash === expected.hash ? 'the hash of the user' : '<other>',
		browserId:
			browserId === undefined
				? '<none>'
				: browserId === expected?.browserId
					? 'the hash of req.browserId'
					: '<other>',
		usedMfa,
		issuedAt: describeTime(iat),
		lifetime: typeof exp === 'number' && typeof iat === 'number' ? exp - iat : String(exp),
		...(normalize(rest) as object),
	};
}

async function describeEncrypted(value: string) {
	const format = /^[A-Za-z0-9_-]{1,36}:/.test(value) ? 'key id prefix' : 'no key id';
	try {
		const plaintext = await Container.get(Cipher).decryptV2(value);
		return { encrypted: labelString(plaintext), format };
	} catch (error) {
		return { notDecryptable: describeError(error) };
	}
}

async function describeCookieValue(name: string, value: string): Promise<unknown> {
	if (value === '') return '<empty>';
	if (name === 'n8n-oidc-state') return describeFlowToken('oidcState', value);
	if (name === 'n8n-oidc-nonce') return describeFlowToken('oidcNonce', value);
	if (name === 'n8n-auth') return await describeSessionToken(value);
	if (name === 'n8n-oidc-id-token') {
		return { ...(await describeEncrypted(value)), length: value.length };
	}
	return labelString(value);
}

function setCookieHeaders(response: request.Response): string[] {
	const header = response.headers['set-cookie'] as unknown;
	if (Array.isArray(header)) return header as string[];
	return typeof header === 'string' ? [header] : [];
}

async function describeCookies(response: request.Response) {
	const cookies = [];
	for (const raw of setCookieHeaders(response)) {
		const [pair, ...attributes] = raw.split(';').map((part) => part.trim());
		const separator = pair.indexOf('=');
		const name = pair.slice(0, separator);
		const value = decodeURIComponent(pair.slice(separator + 1));
		cookies.push({
			name,
			value: await describeCookieValue(name, value),
			attributes: attributes.map((attribute) =>
				/^Expires=/i.test(attribute) && !attribute.includes('1970') ? 'Expires=<date>' : attribute,
			),
		});
	}
	return cookies;
}

/** The cookies of a response, as a browser sends them back. */
function cookiesOf(response: request.Response): string[] {
	return setCookieHeaders(response)
		.map((raw) => raw.split(';')[0])
		.filter((pair) => !pair.endsWith('='));
}

function describeUrl(location: string) {
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		return labelString(location);
	}
	if (url.search === '') return labelString(location);
	for (const [key, value] of url.searchParams.entries()) {
		if (key === 'state' || key === 'nonce') labelFlowValue(value, key);
	}
	return {
		url: labelString(`${url.origin}${url.pathname}`),
		params: [...url.searchParams.entries()].map(([key, value]) => [key, labelString(value)]),
	};
}

function describeHtml(html: string) {
	return labelString(
		html
			.replace(/(&quot;(?:iat|exp|auth_time)&quot;: )\d+/g, '$1<time>')
			.replace(/nonce="(?!\(n\/a\))[^"]*"/g, 'nonce="<csp nonce>"'),
	).split('\n');
}

function describeBody(response: request.Response): unknown {
	const contentType = String(response.headers['content-type'] ?? '');
	if (contentType.includes('json')) {
		const body = response.body as { data?: { url?: unknown } } | undefined;
		if (typeof body?.data?.url === 'string') {
			return { data: { ...body.data, url: describeUrl(body.data.url) } };
		}
		return normalize(response.body);
	}
	const text = response.text ?? '';
	const location = response.headers.location as string | undefined;
	if (location !== undefined && text === `Found. Redirecting to ${location}`) {
		return '<the text of a redirect>';
	}
	if (text.startsWith('<!DOCTYPE html>')) return describeHtml(text);
	return labelString(text);
}

async function describeResponse(response: request.Response) {
	const location = response.headers.location as string | undefined;
	const csp = response.headers['content-security-policy'] as string | undefined;
	return {
		status: response.status,
		...(location !== undefined ? { location: describeUrl(location) } : {}),
		cookies: await describeCookies(response),
		...(response.headers['content-type'] ? { contentType: response.headers['content-type'] } : {}),
		...(csp ? { csp: csp.replace(/'nonce-[^']*'/g, "'nonce-<csp nonce>'") } : {}),
		body: describeBody(response),
	};
}

/**
 * A settings value as the dump shows it. The client secret of the OIDC row is decrypted first,
 * because the labels of generated ids can change the text of a ciphertext.
 */
async function describeSettingValue(key: string, value: string): Promise<unknown> {
	if (key !== OIDC_PREFERENCES_DB_KEY) return labelString(value);
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return labelString(value);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return normalize(parsed);
	}
	const entries = [];
	for (const [entryKey, entry] of Object.entries(parsed)) {
		entries.push([
			entryKey,
			entryKey === 'clientSecret' && typeof entry === 'string' && entry !== ''
				? await describeEncrypted(entry)
				: normalize(entry),
		]);
	}
	return Object.fromEntries(entries);
}

async function dumpDatabase() {
	const dump = await dumpDb();
	const rows = await Container.get(SettingsRepository).manager.query<
		{ key: string; value: string; loadOnStartup: unknown }[]
	>('SELECT * FROM "settings"');
	dump.settings = (
		await Promise.all(
			rows.map(async ({ key, value, loadOnStartup }) =>
				JSON.stringify({ key, value: await describeSettingValue(key, value), loadOnStartup }),
			),
		)
	).sort();
	return dump;
}

function describePassword(password: string | null) {
	if (password === null) return '<none>';
	return /^\$2[aby]\$/.test(password) ? '<bcrypt hash>' : password;
}

/** The password of each user. The dump leaves the column out. */
async function readPasswords() {
	const users = await Container.get(UserRepository).find({ select: ['id', 'password'] });
	return new Map(users.map(({ id, password }) => [id, password]));
}

/** The passwords of the users that a case added, and the passwords that a case changed. */
function describePasswordChanges(
	before: Map<string, string | null>,
	after: Map<string, string | null>,
) {
	const changes: Record<string, string> = {};
	for (const [id, password] of after) {
		if (!before.has(id)) {
			changes[labelString(id)] = `new user: ${describePassword(password)}`;
		} else if (before.get(id) !== password) {
			changes[labelString(id)] =
				`${describePassword(before.get(id) ?? null)} changed to ${describePassword(password)}`;
		}
	}
	return changes;
}

function describeState() {
	return {
		authenticationMethod: config.getEnv('userManagement.authenticationMethod'),
		oidcLoginEnabled: Container.get(GlobalConfig).sso.oidc.loginEnabled,
	};
}

let emit: MockInstance<EventService['emit']>;

function describeEvents() {
	return emit.mock.calls.map(([name, payload]) => [name, normalize(redact(payload))]);
}

/** Run a case, and record what it did. */
async function runCase(action: () => Promise<unknown>) {
	provider.log = [];
	published.length = 0;
	emit.mockClear();
	await recorder.labelNewRows(['project', 'user']);
	const passwordsBefore = await readPasswords();
	const before = await dumpDatabase();
	let result: unknown;
	try {
		result = await action();
	} catch (error) {
		result = `throws ${describeError(error)}`;
	}
	const providerRequests = [...provider.log];
	await recorder.labelNewRows(['project', 'user']);
	const after = await dumpDatabase();
	return {
		result,
		provider: providerRequests,
		events: describeEvents(),
		published: normalize(published),
		state: describeState(),
		database: diffDumps(before, after),
		passwords: describePasswordChanges(passwordsBefore, await readPasswords()),
	};
}

// ----------------------------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------------------------

let owner: User;
let admin: User;
let member: User;
let chatUser: User;

const baseConfig = {
	clientId: CLIENT_ID,
	clientSecret: CLIENT_SECRET,
	discoveryEndpoint: DISCOVERY_ENDPOINT,
};

/** Remove the OIDC config, and make email the sign-in method. */
async function resetOidc() {
	await Container.get(SettingsRepository).delete({ key: OIDC_PREFERENCES_DB_KEY });
	await setCurrentAuthenticationMethod('email');
	Container.get(GlobalConfig).sso.oidc.loginEnabled = false;
	await Container.get(OidcService).init();
	useProvider();
}

/** Save an OIDC config through the API, outside of a case. */
async function configure(changes: Record<string, unknown> = {}) {
	const response = await testServer
		.authAgentFor(owner)
		.post('/sso/oidc/config')
		.send({ ...baseConfig, ...changes });
	if (response.status !== 200) {
		throw new Error(`Cannot configure OIDC: ${response.status} ${JSON.stringify(response.body)}`);
	}
}

async function startLogin(path = '/rest/sso/oidc/login') {
	const response = await request(testServer.app).get(path);
	const location = response.headers.location as string | undefined;
	let state: string | undefined;
	if (location?.startsWith('https://')) {
		const url = new URL(location);
		state = url.searchParams.get('state') ?? undefined;
		const nonce = url.searchParams.get('nonce') ?? undefined;
		if (state) labelFlowValue(state, 'state');
		if (nonce) {
			labelFlowValue(nonce, 'nonce');
			provider.loginNonce = nonce;
		}
	}
	return { response, state, cookies: cookiesOf(response) };
}

type Login = Awaited<ReturnType<typeof startLogin>>;

async function requestCallback(query: string, cookies: string[]) {
	let call = request(testServer.app).get(`/rest/sso/oidc/callback${query}`);
	if (cookies.length > 0) call = call.set('Cookie', cookies.join('; '));
	return await call;
}

const codeQuery = (login: { state?: string }) =>
	`?code=code-1&state=${encodeURIComponent(login.state ?? '')}`;

/** A login and its callback with the code of the provider. */
async function signIn(loginPath?: string) {
	const login = await startLogin(loginPath);
	return await requestCallback(codeQuery(login), login.cookies);
}

async function getConfigAs(user: User) {
	return await describeResponse(await testServer.authAgentFor(user).get('/sso/oidc/config'));
}

function setLicensed(licensed: boolean) {
	if (licensed) testServer.license.enable('feat:oidc');
	else testServer.license.disable('feat:oidc');
}

async function createFixtureUser(
	name: string,
	attributes: Parameters<typeof createUser>[0] = {},
): Promise<User> {
	const user = await createUser({
		email: `${name}@example.com`,
		firstName: name[0].toUpperCase() + name.slice(1),
		lastName: 'Fixture',
		...attributes,
	});
	label(user.id, `user ${name}`);
	return user;
}

/** Send the reload command, as another main instance does after it changes the config. */
async function sendReloadCommand() {
	(Container.get(PubSubEventBus).emit as (event: string) => boolean)('reload-oidc-config');
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeAll(async () => {
	const providerKeys = await generateKeyPair('RS256');
	const otherKeys = await generateKeyPair('RS256');
	provider.keys = { 'provider key': providerKeys.privateKey, 'other key': otherKeys.privateKey };
	provider.publicJwk = await exportJWK(providerKeys.publicKey);
	nock.cleanAll();
	mountProvider(ISSUER);
	mountProvider(OTHER_ISSUER);

	await testDb.truncate(['User']);
	owner = await createFixtureUser('owner', { role: GLOBAL_OWNER_ROLE });
	admin = await createFixtureUser('admin', { role: GLOBAL_ADMIN_ROLE });
	member = await createFixtureUser('member', { role: GLOBAL_MEMBER_ROLE });
	chatUser = await createFixtureUser('chat', { role: GLOBAL_CHAT_USER_ROLE });
	await recorder.labelNewRows(['project', 'user']);
});

beforeEach(async () => {
	// The test config restores spies before each test.
	emit = vi.spyOn(Container.get(EventService), 'emit');
	await resetOidc();
});

afterAll(() => {
	nock.cleanAll();
});

// ----------------------------------------------------------------------------------------------
// Cases
// ----------------------------------------------------------------------------------------------

/** Each test runs many cases one after another, against a real database. */
const TEST_TIMEOUT = 2 * 60 * 1000;

describe('OIDC', { timeout: TEST_TIMEOUT }, () => {
	test('reading the config', async () => {
		const outcomes: Record<string, unknown> = {};
		const users = { owner, admin, member, 'chat user': chatUser };
		for (const licensed of [true, false]) {
			setLicensed(licensed);
			const licence = licensed ? 'licensed' : 'not licensed';
			for (const [name, user] of Object.entries(users)) {
				outcomes[`${licence} | ${name}`] = await runCase(async () => await getConfigAs(user));
			}
			outcomes[`${licence} | no session`] = await runCase(
				async () =>
					await describeResponse(await request(testServer.app).get('/rest/sso/oidc/config')),
			);
		}
		setLicensed(true);
		await configure({ loginEnabled: true, prompt: 'consent', rpInitiatedLogoutEnabled: true });
		outcomes['a stored config | owner'] = await runCase(async () => await getConfigAs(owner));
		expect(outcomes).toMatchSnapshot();
	});

	test('saving the config', async () => {
		const outcomes: Record<string, unknown> = {};
		const save = async (body: unknown, user: User = owner) =>
			await runCase(async () => ({
				response: await describeResponse(
					await testServer
						.authAgentFor(user)
						.post('/sso/oidc/config')
						.send(body as object),
				),
				readBack: await getConfigAs(owner),
			}));

		// Who may save, with and without the licence.
		for (const licensed of [true, false]) {
			for (const [name, user] of Object.entries({ owner, admin, member, 'chat user': chatUser })) {
				await resetOidc();
				setLicensed(licensed);
				outcomes[`${licensed ? 'licensed' : 'not licensed'} | ${name}`] = await save(
					baseConfig,
					user,
				);
			}
		}
		await resetOidc();
		setLicensed(true);
		outcomes['no session'] = await runCase(
			async () =>
				await describeResponse(
					await request(testServer.app).post('/rest/sso/oidc/config').send(baseConfig),
				),
		);

		const bodies: Record<string, unknown> = {
			'the required fields': baseConfig,
			'every field': {
				...baseConfig,
				loginEnabled: true,
				prompt: 'consent',
				authenticationContextClassReference: ['mfa', 'phrh'],
				additionalScopes: 'groups offline_access',
				emailVerifiedRequired: true,
				rpInitiatedLogoutEnabled: true,
			},
			'login enabled': { ...baseConfig, loginEnabled: true },
			'emailVerifiedRequired false': { ...baseConfig, emailVerifiedRequired: false },
			'scopes with outer spaces': { ...baseConfig, additionalScopes: '  groups  ' },
			'an empty body': {},
			'no clientId': { clientSecret: CLIENT_SECRET, discoveryEndpoint: DISCOVERY_ENDPOINT },
			'an empty clientSecret': { ...baseConfig, clientSecret: '' },
			'a discoveryEndpoint that is not a URL': { ...baseConfig, discoveryEndpoint: 'not-a-url' },
			'a discoveryEndpoint that the URL parser changes': {
				...baseConfig,
				discoveryEndpoint: 'https://IDP.example.test:443/.well-known/openid-configuration',
			},
			'an http discoveryEndpoint': {
				...baseConfig,
				discoveryEndpoint: 'http://idp.example.test/.well-known/openid-configuration',
			},
			'a prompt that is not allowed': { ...baseConfig, prompt: 'bogus' },
			'the prompt none': { ...baseConfig, prompt: 'none' },
			'loginEnabled as a string': { ...baseConfig, loginEnabled: 'yes' },
			'ACR values as a string': { ...baseConfig, authenticationContextClassReference: 'mfa' },
			'an unknown key': { ...baseConfig, extra: true },
			'the redacted secret, with no stored config': {
				...baseConfig,
				clientSecret: OIDC_CLIENT_SECRET_REDACTED_VALUE,
			},
		};
		for (const [name, body] of Object.entries(bodies)) {
			await resetOidc();
			outcomes[`body: ${name}`] = await save(body);
		}

		const discoveryFailures: ProviderSettings['discovery'][] = [
			'not found',
			'invalid json',
			'other issuer',
			'unavailable',
		];
		for (const discovery of discoveryFailures) {
			await resetOidc();
			useProvider({ discovery });
			outcomes[`discovery: ${discovery}`] = await save({ ...baseConfig, loginEnabled: true });
		}

		await resetOidc();
		await configure({ loginEnabled: true });
		outcomes['the redacted secret, with a stored config'] = await save({
			...baseConfig,
			clientId: 'other-client',
			clientSecret: OIDC_CLIENT_SECRET_REDACTED_VALUE,
			loginEnabled: true,
		});
		outcomes['a new secret, with a stored config'] = await save({
			...baseConfig,
			clientSecret: 'new-secret',
			loginEnabled: true,
		});
		outcomes['another provider, with a stored config'] = await save({
			...baseConfig,
			discoveryEndpoint: OTHER_DISCOVERY_ENDPOINT,
			loginEnabled: true,
		});
		outcomes['login disabled again'] = await save({ ...baseConfig, loginEnabled: false });
		useProvider({ discovery: 'unavailable' });
		outcomes['a failing discovery, with a stored config'] = await save({
			...baseConfig,
			clientSecret: 'third-secret',
			loginEnabled: true,
		});

		for (const method of ['saml', 'ldap'] as const) {
			for (const loginEnabled of [true, false]) {
				await resetOidc();
				await setCurrentAuthenticationMethod(method);
				outcomes[`sign-in method ${method} | loginEnabled ${loginEnabled}`] = await save({
					...baseConfig,
					loginEnabled,
				});
			}
		}
		await resetOidc();
		await setCurrentAuthenticationMethod('oidc');
		outcomes['sign-in method oidc, without a stored config | loginEnabled false'] = await save({
			...baseConfig,
			loginEnabled: false,
		});

		await resetOidc();
		const loaderConfig = Container.get(InstanceSettingsLoaderConfig);
		loaderConfig.ssoManagedByEnv = true;
		try {
			outcomes['SSO managed by the environment'] = await save({
				...baseConfig,
				loginEnabled: true,
			});
			await setCurrentAuthenticationMethod('saml');
			outcomes['SSO managed by the environment, sign-in method saml'] = await save({
				...baseConfig,
				loginEnabled: true,
			});
			outcomes['SSO managed by the environment, a body that is not valid'] = await save({
				...baseConfig,
				prompt: 'bogus',
			});
		} finally {
			loaderConfig.ssoManagedByEnv = false;
		}

		await resetOidc();
		const instanceSettings = Container.get(InstanceSettings);
		instanceSettings.setMultiMainEnabled(true);
		instanceSettings.setMultiMainLicensed(true);
		try {
			outcomes['multi-main'] = await save({ ...baseConfig, loginEnabled: true });
			useProvider({ discovery: 'unavailable' });
			outcomes['multi-main, a failing discovery'] = await save({
				...baseConfig,
				clientSecret: 'other-secret',
				loginEnabled: true,
			});
		} finally {
			instanceSettings.setMultiMainEnabled(false);
			instanceSettings.setMultiMainLicensed(false);
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('the connection test', async () => {
		const outcomes: Record<string, unknown> = {};
		const runTest = async (user: User = owner) =>
			await runCase(
				async () =>
					await describeResponse(await testServer.authAgentFor(user).post('/sso/oidc/config/test')),
			);

		outcomes['no stored config'] = await runTest();
		await configure();
		outcomes['login disabled'] = await runTest();
		await configure({ loginEnabled: true });
		outcomes['login enabled'] = await runTest();
		outcomes['admin'] = await runTest(admin);
		outcomes['member'] = await runTest(member);
		outcomes['no session'] = await runCase(
			async () =>
				await describeResponse(await request(testServer.app).post('/rest/sso/oidc/config/test')),
		);
		setLicensed(false);
		outcomes['not licensed'] = await runTest();
		setLicensed(true);
		await configure({
			loginEnabled: true,
			prompt: 'login',
			authenticationContextClassReference: ['mfa', 'phrh'],
			additionalScopes: 'groups offline_access',
		});
		outcomes['prompt, ACR values and scopes'] = await runTest();
		useProvider({ discovery: 'unavailable' });
		outcomes['discovery fails'] = await runTest();
		expect(outcomes).toMatchSnapshot();
	});

	test('the login', async () => {
		const outcomes: Record<string, unknown> = {};
		const login = async (path?: string) =>
			await runCase(async () => await describeResponse((await startLogin(path)).response));

		outcomes['no stored config'] = await login();
		await configure();
		outcomes['login disabled'] = await login();
		await configure({ loginEnabled: true });
		outcomes['login enabled'] = await login();
		outcomes['a second login'] = await login();
		setLicensed(false);
		outcomes['not licensed'] = await login();
		setLicensed(true);
		outcomes['with a session'] = await runCase(
			async () =>
				await describeResponse(await testServer.authAgentFor(member).get('/sso/oidc/login')),
		);

		const redirects: Record<string, string> = {
			'a path': '/workflows',
			'a path with a query and a hash': '/workflow/1?x=1#y',
			'a path without a slash': 'workflows',
			'an empty value': '',
			'an absolute URL of this instance': 'http://localhost:5678/home',
			'an absolute URL of another site': 'https://evil.example.com/x',
			'a protocol-relative URL': '//evil.example.com/x',
			'a backslash URL': '/\\evil.example.com',
			'a javascript URL': 'javascript:alert(1)',
			'the signin page': '/signin',
			'only a slash': '/',
			'a path with outer spaces': '  /workflows  ',
			'an encoded double slash': '/%2F%2Fevil.example.com',
			'a path with a tab': '/\t/evil.example.com',
			'a path with a newline at the end': '/workflows\n',
			'a backslash inside the path': '/a\\b',
		};
		for (const [name, redirect] of Object.entries(redirects)) {
			outcomes[`redirect: ${name}`] = await login(
				`/rest/sso/oidc/login?redirect=${encodeURIComponent(redirect)}`,
			);
		}
		outcomes['redirect: twice in the query'] = await login(
			'/rest/sso/oidc/login?redirect=%2Fa&redirect=%2Fb',
		);

		for (const prompt of ['none', 'login', 'consent', 'select_account', 'create']) {
			await configure({ loginEnabled: true, prompt });
			outcomes[`prompt ${prompt}`] = await login();
		}
		await configure({
			loginEnabled: true,
			authenticationContextClassReference: ['mfa', 'phrh'],
			additionalScopes: 'groups offline_access',
		});
		outcomes['ACR values and scopes'] = await login();
		await configure({ loginEnabled: true, additionalScopes: '  openid   email extra  ' });
		outcomes['scopes with spaces and repeats'] = await login();

		await configure({ loginEnabled: true });
		const globalConfig = Container.get(GlobalConfig);
		const { editorBaseUrl } = globalConfig;
		globalConfig.editorBaseUrl = 'https://n8n.example.test/base/';
		try {
			outcomes['an editor base URL'] = await login();
		} finally {
			globalConfig.editorBaseUrl = editorBaseUrl;
		}

		const oidcConfig = globalConfig.sso.oidc;
		oidcConfig.loginEnabled = false;
		outcomes['the global login flag off'] = await login();
		oidcConfig.loginEnabled = true;
		await setCurrentAuthenticationMethod('email');
		outcomes['the sign-in method email'] = await login();
		await setCurrentAuthenticationMethod('oidc');

		useProvider({ discovery: 'unavailable' });
		outcomes['discovery fails, with cached provider metadata'] = await login();
		useProvider();
		await configure({ loginEnabled: true });
		useProvider({ discovery: 'unavailable' });
		outcomes['discovery fails, without cached provider metadata'] = await login();
		useProvider();
		outcomes['discovery works again'] = await login();
		expect(outcomes).toMatchSnapshot();
	});

	test('signing in', async () => {
		const outcomes: Record<string, unknown> = {};
		await configure({ loginEnabled: true });
		const signInCase = async (changes: Partial<ProviderSettings>, loginPath?: string) => {
			useProvider(changes);
			return await runCase(async () => await describeResponse(await signIn(loginPath)));
		};
		const personCase = async (name: string, claims: Record<string, unknown> = {}) => {
			usePerson(name, claims);
			return await runCase(async () => await describeResponse(await signIn()));
		};

		outcomes['a new user'] = await signInCase({});
		outcomes['the same user again'] = await signInCase({});
		outcomes['the same user, with new names'] = await signInCase({
			claims: { ...alice, given_name: 'Alicia', family_name: 'Smith' },
		});
		outcomes['the same user, with a new email'] = await signInCase({
			claims: { ...alice, email: 'alice.new@example.com' },
		});

		await createFixtureUser('bob');
		outcomes['an email user, without an identity'] = await signInCase({
			subject: 'bob-sub',
			claims: {
				email: 'bob@example.com',
				email_verified: true,
				given_name: 'Bobby',
				family_name: 'B',
			},
		});
		await createFixtureUser('henry');
		outcomes['an email user, with other letter case'] = await signInCase({
			subject: 'henry-sub',
			claims: { email: 'Henry@Example.COM', email_verified: true },
		});
		const carol = await createFixtureUser('carol');
		await Container.get(AuthIdentityRepository).save(
			AuthIdentity.create(carol, 'carol-sub', 'oidc'),
		);
		outcomes['a user with an identity, and another email'] = await signInCase({
			subject: 'carol-sub',
			claims: { email: 'carol.other@example.com', email_verified: true },
		});
		outcomes['a user with an identity, and the email of another user'] = await signInCase({
			subject: 'carol-sub',
			claims: { email: 'bob@example.com', email_verified: true },
		});
		outcomes['a user with an identity, and no email'] = await signInCase({
			subject: 'carol-sub',
			claims: { given_name: 'Carol' },
		});
		outcomes['a user with an identity, and an email that is not valid'] = await signInCase({
			subject: 'carol-sub',
			claims: { email: 'not-an-email', email_verified: true },
		});
		outcomes['a user with an identity, and an email with a non-ASCII letter'] = await signInCase({
			subject: 'carol-sub',
			claims: { email: 'c\u00fcrol@example.com', email_verified: true },
		});
		outcomes['a user with an identity, and an email with a one-letter top-level domain'] =
			await signInCase({
				subject: 'carol-sub',
				claims: { email: 'carol@example.c', email_verified: true },
			});
		outcomes['a new identity, and the email of a user with another identity'] = await signInCase({
			subject: 'carol-second-sub',
			claims: { email: 'carol@example.com', email_verified: true },
		});
		outcomes['the owner'] = await personCase('owner');
		outcomes['an admin'] = await personCase('admin');
		outcomes['a chat user'] = await personCase('chat');
		await createFixtureUser('frank', {
			mfaEnabled: true,
			mfaSecret: 'fake-secret',
			mfaRecoveryCodes: [],
		});
		outcomes['a user with MFA'] = await personCase('frank');
		const grace = await createFixtureUser('grace');
		await Container.get(AuthIdentityRepository).save(
			AuthIdentity.create(grace, 'grace-ldap', 'ldap'),
		);
		outcomes['an LDAP user'] = await personCase('grace');
		await createFixtureUser('dave', { disabled: true });
		outcomes['a disabled user'] = await personCase('dave');
		await createFixtureUser('erin', { password: null });
		outcomes['a pending user'] = await personCase('erin');

		const ssoConfig = Container.get(GlobalConfig).sso;
		ssoConfig.justInTimeProvisioning = false;
		try {
			outcomes['no JIT provisioning, a new user'] = await personCase('ivan');
			await createFixtureUser('judy');
			outcomes['no JIT provisioning, an email user'] = await personCase('judy');
		} finally {
			ssoConfig.justInTimeProvisioning = true;
		}

		outcomes['email only in userinfo'] = await signInCase({
			subject: 'kim-sub',
			claims: {},
			userInfo: { email: 'kim@example.com', email_verified: true, given_name: 'Kim' },
		});
		outcomes['email in the id token, other email in userinfo'] = await signInCase({
			subject: 'leo-sub',
			claims: { email: 'leo@example.com', email_verified: true },
			userInfo: { email: 'leo.info@example.com', email_verified: true },
		});
		outcomes['email only in the id token'] = await signInCase({
			subject: 'lis-sub',
			claims: { email: 'lis@example.com', email_verified: true },
			userInfo: { email_verified: true },
		});
		outcomes['names only in the id token'] = await signInCase({
			subject: 'lia-sub',
			claims: {
				email: 'lia@example.com',
				email_verified: true,
				given_name: 'Lia',
				family_name: 'Id',
			},
			userInfo: { email: 'lia@example.com', email_verified: true },
		});
		outcomes['no email'] = await signInCase({ subject: 'mia-sub', claims: { given_name: 'Mia' } });
		outcomes['an email that is not valid'] = await personCase('ned', { email: 'not-an-email' });
		outcomes['an email with spaces and capitals'] = await personCase('nia', {
			email: '  Nia.Upper@Example.com ',
		});
		outcomes['a new user, an email with capitals'] = await personCase('noa', {
			email: 'Noa.Upper@Example.COM',
		});
		outcomes['a new user, an email with a local part of 70 characters'] = await personCase('nao', {
			email: `${'n'.repeat(70)}@example.com`,
		});
		outcomes['no names'] = await personCase('oli');
		outcomes['long names'] = await personCase('pat', {
			given_name: 'P'.repeat(40),
			family_name: 'Q'.repeat(40),
		});
		outcomes['names with spaces'] = await personCase('pam', {
			given_name: '  Pam  ',
			family_name: ' ',
		});
		outcomes['email not verified'] = await personCase('quinn', { email_verified: false });
		outcomes['no email_verified claim'] = await personCase('rob', { email_verified: undefined });
		await createFixtureUser('nora');
		outcomes['an email user, email not verified'] = await personCase('nora', {
			email_verified: false,
		});
		await createFixtureUser('omar');
		outcomes['an email user, no email_verified claim'] = await personCase('omar', {
			email_verified: undefined,
		});
		await createFixtureUser('olga');
		outcomes['an email user, email_verified the string false'] = await personCase('olga', {
			email_verified: 'false',
		});
		await createFixtureUser('otto');
		outcomes['an email user, email_verified 0'] = await personCase('otto', { email_verified: 0 });

		await configure({ loginEnabled: true, emailVerifiedRequired: false });
		await createFixtureUser('pia');
		outcomes['emailVerifiedRequired false, an email user, email not verified'] = await personCase(
			'pia',
			{ email_verified: false },
		);
		await createFixtureUser('pim');
		outcomes['an email user, not verified in the id token, no claim in userinfo'] =
			await signInCase({
				subject: 'pim-sub',
				claims: { email: 'pim@example.com', email_verified: false },
				userInfo: { email: 'pim@example.com' },
			});

		await configure({ loginEnabled: true, emailVerifiedRequired: true });
		outcomes['emailVerifiedRequired, a new user, email not verified'] = await personCase('sam', {
			email_verified: false,
		});
		outcomes['emailVerifiedRequired, a new user, no email_verified claim'] = await personCase(
			'tia',
			{ email_verified: undefined },
		);
		outcomes['emailVerifiedRequired, a new user, email verified'] = await personCase('vic');
		const verifiedClaims: Record<string, [string, unknown]> = {
			ray: ['false', false],
			sue: ['missing', undefined],
			ted: ['the string true', 'true'],
			tom: ['the string false', 'false'],
			tyr: ['1', 1],
			una: ['true', true],
		};
		for (const [name, [description, emailVerified]] of Object.entries(verifiedClaims)) {
			await createFixtureUser(name);
			outcomes[`emailVerifiedRequired, an email user, email_verified ${description}`] =
				await personCase(name, { email_verified: emailVerified });
		}
		await createFixtureUser('val');
		outcomes['emailVerifiedRequired, an email user, verified only in the id token'] =
			await signInCase({
				subject: 'val-sub',
				claims: { email: 'val@example.com', email_verified: true },
				userInfo: { email: 'val@example.com', email_verified: false },
			});
		await createFixtureUser('wil');
		outcomes['emailVerifiedRequired, an email user, verified only in userinfo'] = await signInCase({
			subject: 'wil-sub',
			claims: { email: 'wil@example.com', email_verified: false },
			userInfo: { email: 'wil@example.com', email_verified: true },
		});
		await createFixtureUser('xan');
		outcomes[
			'emailVerifiedRequired, an email user, verified in the id token, no claim in userinfo'
		] = await signInCase({
			subject: 'xan-sub',
			claims: { email: 'xan@example.com', email_verified: true },
			userInfo: { email: 'xan@example.com' },
		});
		outcomes['emailVerifiedRequired, a user with an identity, email not verified'] =
			await signInCase({
				subject: 'carol-sub',
				claims: { email: 'carol@example.com', email_verified: false },
			});

		await configure({ loginEnabled: true });
		outcomes['a large id token'] = await personCase('wes', { padding: 'x'.repeat(4000) });
		for (const length of [2831, 2833, 3801]) {
			usePerson(`size${length}`);
			provider.settings.idTokenLength = length;
			outcomes[`an id token of ${length} characters`] = await runCase(
				async () => await describeResponse(await signIn()),
			);
		}

		const redirects: Record<string, string> = {
			'a path': '/workflows',
			'a path with a query and a hash': '/workflow/1?x=1#y',
			'a path without a slash': 'workflows',
			'an absolute URL of this instance': 'http://localhost:5678/home',
			'an absolute URL of another site': 'https://evil.example.com/x',
			'a protocol-relative URL': '//evil.example.com/x',
			'a backslash URL': '/\\evil.example.com',
			'a javascript URL': 'javascript:alert(1)',
			'only a slash': '/',
			'a path with outer spaces': '  /workflows  ',
			'an encoded double slash': '/%2F%2Fevil.example.com',
		};
		for (const [name, redirect] of Object.entries(redirects)) {
			outcomes[`redirect: ${name}`] = await signInCase(
				{},
				`/rest/sso/oidc/login?redirect=${encodeURIComponent(redirect)}`,
			);
		}

		// An ordinary email sign-in, to show that the test records events.
		outcomes['an email sign-in of the owner, for comparison'] = await runCase(
			async () =>
				await describeResponse(
					await request(testServer.app)
						.post('/rest/login')
						.send({ emailOrLdapLoginId: 'owner@example.com', password: 'password' }),
				),
		);
		expect(outcomes).toMatchSnapshot();
	});

	test('rejected callbacks', async () => {
		const outcomes: Record<string, unknown> = {};
		await configure({ loginEnabled: true });
		const reject = async (
			changes: Partial<ProviderSettings>,
			makeCall: (login: Login) => Promise<request.Response>,
			before?: () => Promise<void> | void,
		) => {
			usePerson('xena');
			Object.assign(provider.settings, changes);
			const login = await startLogin();
			await before?.();
			return await runCase(async () => await describeResponse(await makeCall(login)));
		};
		const normal = async (login: Login) => await requestCallback(codeQuery(login), login.cookies);
		const withoutCookie = (name: string) => async (login: Login) =>
			await requestCallback(
				codeQuery(login),
				login.cookies.filter((cookie) => !cookie.startsWith(`${name}=`)),
			);
		const withChangedSignature = (name: string) => async (login: Login) =>
			await requestCallback(
				codeQuery(login),
				login.cookies.map((cookie) =>
					cookie.startsWith(`${name}=`) ? `${cookie.slice(0, -2)}xx` : cookie,
				),
			);

		outcomes['no cookies'] = await reject(
			{},
			async (login) => await requestCallback(codeQuery(login), []),
		);
		outcomes['no state cookie'] = await reject({}, withoutCookie('n8n-oidc-state'));
		outcomes['no nonce cookie'] = await reject({}, withoutCookie('n8n-oidc-nonce'));
		outcomes['another state in the query'] = await reject(
			{},
			async (login) => await requestCallback('?code=code-1&state=n8n_state%3Aother', login.cookies),
		);
		outcomes['no state in the query'] = await reject(
			{},
			async (login) => await requestCallback('?code=code-1', login.cookies),
		);
		outcomes['no code'] = await reject(
			{},
			async (login) =>
				await requestCallback(`?state=${encodeURIComponent(login.state ?? '')}`, login.cookies),
		);
		outcomes['an error from the provider'] = await reject(
			{},
			async (login) =>
				await requestCallback(
					`?error=access_denied&error_description=The%20user%20said%20no&state=${encodeURIComponent(login.state ?? '')}`,
					login.cookies,
				),
		);
		outcomes['another error from the provider'] = await reject(
			{},
			async (login) =>
				await requestCallback(
					`?error=login_required&state=${encodeURIComponent(login.state ?? '')}`,
					login.cookies,
				),
		);
		outcomes['an error from the provider, without cookies'] = await reject(
			{},
			async (login) =>
				await requestCallback(
					`?error=access_denied&state=${encodeURIComponent(login.state ?? '')}`,
					[],
				),
		);
		outcomes['an error from the provider, and another state'] = await reject(
			{},
			async (login) =>
				await requestCallback('?error=access_denied&state=n8n_state%3Aother', login.cookies),
		);
		outcomes['a state cookie with a changed signature'] = await reject(
			{},
			withChangedSignature('n8n-oidc-state'),
		);
		outcomes['a nonce cookie with a changed signature'] = await reject(
			{},
			withChangedSignature('n8n-oidc-nonce'),
		);
		outcomes['the state and nonce cookies swapped'] = await reject({}, async (login) => {
			const state = login.cookies.find((cookie) => cookie.startsWith('n8n-oidc-state='));
			const nonce = login.cookies.find((cookie) => cookie.startsWith('n8n-oidc-nonce='));
			return await requestCallback(codeQuery(login), [
				`n8n-oidc-state=${nonce?.split('=')[1]}`,
				`n8n-oidc-nonce=${state?.split('=')[1]}`,
			]);
		});
		outcomes['the cookies of another login'] = await reject({}, async (login) => {
			const other = await startLogin();
			return await requestCallback(codeQuery(login), other.cookies);
		});
		outcomes['the token endpoint rejects the code'] = await reject(
			{ token: 'invalid grant' },
			normal,
		);
		outcomes['the token endpoint fails'] = await reject({ token: 'server error' }, normal);
		outcomes['no id token'] = await reject({ token: 'no id token' }, normal);
		outcomes['an id token signed with another key'] = await reject(
			{ signingKey: 'other key' },
			normal,
		);
		outcomes['an id token for another client'] = await reject({ audience: 'other-client' }, normal);
		outcomes['an id token of another issuer'] = await reject({ issuer: 'other' }, normal);
		outcomes['an expired id token'] = await reject({ lifetime: -120 }, normal);
		outcomes['another nonce'] = await reject({ nonce: 'other nonce' }, normal);
		outcomes['no nonce'] = await reject({ nonce: 'no nonce' }, normal);
		outcomes['userinfo fails'] = await reject({ userinfo: 'server error' }, normal);
		outcomes['userinfo of another subject'] = await reject({ userinfo: 'other subject' }, normal);
		outcomes['discovery fails at the callback'] = await reject({}, normal, () => {
			provider.settings.discovery = 'unavailable';
		});
		outcomes['login disabled after the login'] = await reject({}, normal, async () => {
			await configure({ loginEnabled: false });
		});
		await configure({ loginEnabled: true });
		outcomes['a new config after the login'] = await reject({}, normal, async () => {
			await configure({ loginEnabled: true, clientId: 'other-client' });
		});
		await configure({ loginEnabled: true });
		outcomes['not licensed at the callback'] = await reject({}, normal, () => setLicensed(false));
		setLicensed(true);
		const oidcConfig = Container.get(GlobalConfig).sso.oidc;
		outcomes['the global login flag off at the callback'] = await reject({}, normal, () => {
			oidcConfig.loginEnabled = false;
		});
		oidcConfig.loginEnabled = true;
		outcomes['the sign-in method email at the callback'] = await reject({}, normal, async () => {
			await setCurrentAuthenticationMethod('email');
		});
		await setCurrentAuthenticationMethod('oidc');
		const globalConfig = Container.get(GlobalConfig);
		const { editorBaseUrl } = globalConfig;
		outcomes['an editor base URL'] = await reject({ token: 'invalid grant' }, async (login) => {
			globalConfig.editorBaseUrl = 'https://n8n.example.test/base/';
			try {
				return await normal(login);
			} finally {
				globalConfig.editorBaseUrl = editorBaseUrl;
			}
		});
		expect(outcomes).toMatchSnapshot();
	});

	test('the connection test callback', async () => {
		const outcomes: Record<string, unknown> = {};
		const testFlow = async (
			changes: Partial<ProviderSettings>,
			makeQuery: (state: string) => string = (state) =>
				`?code=code-1&state=${encodeURIComponent(state)}`,
			before?: () => void,
		) => {
			usePerson('yuri', { given_name: 'Yuri' });
			Object.assign(provider.settings, changes);
			const start = await testServer.authAgentFor(owner).post('/sso/oidc/config/test');
			const url = new URL(String((start.body as { data?: { url?: string } }).data?.url));
			const state = url.searchParams.get('state') ?? '';
			const nonce = url.searchParams.get('nonce') ?? '';
			labelFlowValue(state, 'state');
			labelFlowValue(nonce, 'nonce');
			provider.loginNonce = nonce;
			before?.();
			return await runCase(
				async () =>
					await describeResponse(await requestCallback(makeQuery(state), cookiesOf(start))),
			);
		};

		await configure({ loginEnabled: true });
		outcomes['success'] = await testFlow({
			claims: {
				email: 'yuri@example.com',
				email_verified: true,
				given_name: 'Yuri',
				family_name: 'Test',
				groups: ['a', '<b>'],
			},
		});
		const failures: Record<string, Partial<ProviderSettings>> = {
			'the token endpoint rejects the code': { token: 'invalid grant' },
			'the token endpoint fails': { token: 'server error' },
			'no id token': { token: 'no id token' },
			'an id token for another client': { audience: 'other-client' },
			'an id token of another issuer': { issuer: 'other' },
			'an expired id token': { lifetime: -120 },
			'another nonce': { nonce: 'other nonce' },
			'no nonce': { nonce: 'no nonce' },
			'userinfo fails': { userinfo: 'server error' },
			'userinfo of another subject': { userinfo: 'other subject' },
			'no email': { claims: {} },
			'an email that is not valid': { claims: { email: 'not-an-email', email_verified: true } },
		};
		for (const [name, changes] of Object.entries(failures)) {
			outcomes[name] = await testFlow(changes);
		}
		outcomes['discovery fails at the callback'] = await testFlow({}, undefined, () => {
			provider.settings.discovery = 'unavailable';
		});
		outcomes['another state in the query'] = await testFlow(
			{},
			() => '?code=code-1&state=n8n_state%3Aother',
		);
		outcomes['no code'] = await testFlow({}, (state) => `?state=${encodeURIComponent(state)}`);
		outcomes['an error from the provider'] = await testFlow(
			{},
			(state) => `?error=access_denied&error_description=No&state=${encodeURIComponent(state)}`,
		);
		await configure({ loginEnabled: true, emailVerifiedRequired: true });
		outcomes['emailVerifiedRequired, email not verified'] = await testFlow({
			claims: { email: 'yuri@example.com', email_verified: false },
		});
		await configure({ loginEnabled: false });
		outcomes['login disabled'] = await testFlow({});
		expect(outcomes).toMatchSnapshot();
	});

	test('the logout', async () => {
		const outcomes: Record<string, unknown> = {};
		const authService = Container.get(AuthService);
		const logout = async (cookies: string[]) =>
			await runCase(async () => {
				let call = request(testServer.app).post('/rest/sso/oidc/logout');
				if (cookies.length > 0) call = call.set('Cookie', cookies.join('; '));
				const response = await call;
				const session = cookies.find((cookie) => cookie.startsWith('n8n-auth='));
				let sessionAfterwards: unknown = '<no session>';
				if (session) {
					const check = await request(testServer.app).get('/rest/login').set('Cookie', session);
					sessionAfterwards = check.status;
				}
				return { response: await describeResponse(response), sessionAfterwards };
			});
		// Each session has its own user, because two sessions of one user in the same second are
		// the same token, and a logout revokes the token.
		let sessions = 0;
		const passwordSession = async () => {
			sessions += 1;
			const user = await createFixtureUser(`password${sessions}`);
			const token = authService.issueJWT(user, false, TEST_SERVER_BROWSER_ID);
			await labelSessionToken(token);
			return [`n8n-auth=${token}`];
		};
		const oidcSession = async () => {
			sessions += 1;
			usePerson(`logout${sessions}`);
			const cookies = cookiesOf(await signIn());
			for (const cookie of cookies) {
				if (cookie.startsWith('n8n-auth=')) await labelSessionToken(cookie.slice(9));
			}
			return cookies;
		};

		outcomes['no session'] = await logout([]);
		await configure({ loginEnabled: true });
		outcomes['a password session'] = await logout(await passwordSession());
		outcomes['an OIDC session'] = await logout(await oidcSession());
		outcomes['an OIDC session, without the id token cookie'] = await logout(
			(await oidcSession()).filter((cookie) => !cookie.startsWith('n8n-oidc-id-token=')),
		);
		await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
		outcomes['RP-initiated logout, a password session'] = await logout(await passwordSession());
		outcomes['RP-initiated logout, an OIDC session'] = await logout(await oidcSession());
		outcomes['RP-initiated logout, an id token cookie that is not valid'] = await logout(
			(await oidcSession()).map((cookie) =>
				cookie.startsWith('n8n-oidc-id-token=') ? 'n8n-oidc-id-token=not-valid' : cookie,
			),
		);
		const editorSession = await oidcSession();
		const globalConfig = Container.get(GlobalConfig);
		const { editorBaseUrl } = globalConfig;
		globalConfig.editorBaseUrl = 'https://n8n.example.test/base/';
		try {
			outcomes['RP-initiated logout, an editor base URL'] = await logout(editorSession);
		} finally {
			globalConfig.editorBaseUrl = editorBaseUrl;
		}
		const cachedSession = await oidcSession();
		provider.settings.discovery = 'unavailable';
		outcomes['RP-initiated logout, discovery fails, with cached provider metadata'] =
			await logout(cachedSession);
		const uncachedSession = await oidcSession();
		await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
		provider.settings.discovery = 'unavailable';
		outcomes['RP-initiated logout, discovery fails, without cached provider metadata'] =
			await logout(uncachedSession);
		useProvider();
		await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
		const noEndSession = await oidcSession();
		await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
		provider.settings.discovery = 'no end session endpoint';
		outcomes['RP-initiated logout, no end session endpoint'] = await logout(noEndSession);
		useProvider();
		await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
		const disabledSession = await oidcSession();
		await configure({ loginEnabled: false, rpInitiatedLogoutEnabled: true });
		outcomes['RP-initiated logout, login disabled'] = await logout(disabledSession);
		await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
		const flagSession = await oidcSession();
		const oidcConfig = Container.get(GlobalConfig).sso.oidc;
		oidcConfig.loginEnabled = false;
		outcomes['RP-initiated logout, the global login flag off'] = await logout(flagSession);
		oidcConfig.loginEnabled = true;
		const methodSession = await oidcSession();
		await setCurrentAuthenticationMethod('email');
		outcomes['RP-initiated logout, the sign-in method email'] = await logout(methodSession);
		await setCurrentAuthenticationMethod('oidc');
		const unlicensedSession = await oidcSession();
		setLicensed(false);
		outcomes['RP-initiated logout, not licensed'] = await logout(unlicensedSession);
		setLicensed(true);
		expect(outcomes).toMatchSnapshot();
	});

	test('the cookie settings', async () => {
		const outcomes: Record<string, unknown> = {};
		const globalConfig = Container.get(GlobalConfig);
		const cookieConfig = { ...globalConfig.auth.cookie };
		const { jwtSessionDurationHours } = globalConfig.userManagement;
		globalConfig.auth.cookie.samesite = 'strict';
		globalConfig.auth.cookie.secure = true;
		globalConfig.userManagement.jwtSessionDurationHours = 24;
		try {
			await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
			usePerson('cookie');
			const login = await startLogin();
			outcomes['the login'] = await runCase(async () => await describeResponse(login.response));
			const signedIn = await requestCallback(codeQuery(login), login.cookies);
			outcomes['the callback'] = await runCase(async () => await describeResponse(signedIn));
			const cookies = cookiesOf(signedIn);
			for (const cookie of cookies) {
				if (cookie.startsWith('n8n-auth=')) await labelSessionToken(cookie.slice(9));
			}
			outcomes['the logout'] = await runCase(
				async () =>
					await describeResponse(
						await request(testServer.app)
							.post('/rest/sso/oidc/logout')
							.set('Cookie', cookies.join('; ')),
					),
			);
			outcomes['the connection test'] = await runCase(
				async () =>
					await describeResponse(
						await testServer.authAgentFor(owner).post('/sso/oidc/config/test'),
					),
			);
		} finally {
			Object.assign(globalConfig.auth.cookie, cookieConfig);
			globalConfig.userManagement.jwtSessionDurationHours = jwtSessionDurationHours;
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('the service', async () => {
		const outcomes: Record<string, unknown> = {};
		const service = Container.get(OidcService);
		const settings = Container.get(SettingsRepository);
		const describeConfig = async (decrypt?: boolean) => {
			const loaded = await (decrypt === undefined
				? service.loadConfig()
				: service.loadConfig(decrypt));
			const { clientSecret, discoveryEndpoint, ...rest } = loaded as unknown as Record<
				string,
				unknown
			>;
			return {
				...(normalize(rest) as object),
				clientSecret:
					typeof clientSecret === 'string' && clientSecret.startsWith('U2FsdGVkX1')
						? await describeEncrypted(clientSecret)
						: clientSecret,
				discoveryEndpoint:
					discoveryEndpoint instanceof URL ? `URL ${discoveryEndpoint.href}` : discoveryEndpoint,
			};
		};
		const readAll = async () => ({
			loadConfig: await describeConfig(),
			'loadConfig(true)': await describeConfig(true),
			'loadConfig(false)': await describeConfig(false),
		});
		const writeRow = async (value: string) => {
			await settings.delete({ key: OIDC_PREFERENCES_DB_KEY });
			await settings.insert({ key: OIDC_PREFERENCES_DB_KEY, value, loadOnStartup: true });
		};
		const cipher = Container.get(Cipher);
		const storedConfig = async (changes: Record<string, unknown> = {}) =>
			JSON.stringify({
				...baseConfig,
				clientSecret: await cipher.encryptV2(CLIENT_SECRET),
				loginEnabled: true,
				prompt: 'consent',
				authenticationContextClassReference: ['mfa'],
				additionalScopes: 'groups',
				rpInitiatedLogoutEnabled: true,
				...changes,
			});

		const initWith = async (name: string, value: string | undefined) => {
			await resetOidc();
			if (value !== undefined) await writeRow(value);
			outcomes[`init: ${name}`] = await runCase(async () => {
				await service.init();
				return await readAll();
			});
		};
		await initWith('no row', undefined);
		await initWith('a stored config', await storedConfig());
		await initWith('a stored config, login disabled', await storedConfig({ loginEnabled: false }));
		await initWith(
			'the row of the settings loader, login disabled',
			JSON.stringify({ loginEnabled: false }),
		);
		await initWith('a row that is not JSON', 'not json');
		await initWith('a secret that is not encrypted', await storedConfig({ clientSecret: 'plain' }));
		await initWith('a row without a secret', await storedConfig({ clientSecret: undefined }));
		await initWith('a row with an unknown key', await storedConfig({ extra: 'value' }));
		await initWith(
			'a row with a prompt that is not allowed',
			await storedConfig({ prompt: 'bogus' }),
		);
		await initWith('a row without a prompt', await storedConfig({ prompt: undefined }));
		await initWith(
			'a row with emailVerifiedRequired',
			await storedConfig({ emailVerifiedRequired: true }),
		);

		await resetOidc();
		await setCurrentAuthenticationMethod('saml');
		await writeRow(await storedConfig());
		outcomes['init: a stored config, sign-in method saml'] = await runCase(async () => {
			await service.init();
			return await readAll();
		});
		await resetOidc();
		await setCurrentAuthenticationMethod('oidc');
		await writeRow(await storedConfig({ loginEnabled: false }));
		outcomes['init: a stored config, login disabled, sign-in method oidc'] = await runCase(
			async () => {
				await service.init();
				return await readAll();
			},
		);

		const publicBody = {
			...baseConfig,
			loginEnabled: true,
			prompt: 'consent' as const,
			authenticationContextClassReference: ['mfa'],
			additionalScopes: 'groups',
			emailVerifiedRequired: false,
			rpInitiatedLogoutEnabled: false,
		};
		await resetOidc();
		outcomes['updateConfig'] = await runCase(async () => ({
			result: normalize(await service.updateConfig(publicBody)),
			config: await readAll(),
		}));
		outcomes['updateConfig, the redacted secret'] = await runCase(async () => ({
			result: normalize(
				await service.updateConfig({
					...publicBody,
					clientSecret: OIDC_CLIENT_SECRET_REDACTED_VALUE,
					clientId: 'other-client',
				}),
			),
			config: await readAll(),
		}));
		const loaderConfig = Container.get(InstanceSettingsLoaderConfig);
		loaderConfig.ssoManagedByEnv = true;
		try {
			outcomes['updateConfig, SSO managed by the environment'] = await runCase(async () => ({
				result: normalize(await service.updateConfig({ ...publicBody, clientId: 'env-client' })),
				config: await readAll(),
			}));
		} finally {
			loaderConfig.ssoManagedByEnv = false;
		}
		useProvider({ discovery: 'unavailable' });
		outcomes['updateConfig, discovery fails'] = await runCase(async () => ({
			result: normalize(await service.updateConfig({ ...publicBody, clientSecret: 'new-secret' })),
			config: await readAll(),
		}));
		useProvider();

		// Another main instance changes the config, and sends the reload command.
		await resetOidc();
		await configure({ loginEnabled: true });
		Container.get(PubSubRegistry).init();
		await writeRow(await storedConfig({ clientId: 'reloaded-client', loginEnabled: false }));
		outcomes['a changed row, before the reload command'] = await runCase(async () => ({
			config: await readAll(),
			getConfig: await getConfigAs(owner),
			login: await describeResponse((await startLogin()).response),
		}));
		await resetOidc();
		await configure({ loginEnabled: true, rpInitiatedLogoutEnabled: true });
		usePerson('row');
		const rowSession = cookiesOf(await signIn());
		await writeRow(await storedConfig({ clientId: 'db-client', prompt: 'login' }));
		outcomes['a changed row: the connection test and its callback'] = await runCase(async () => {
			const start = await testServer.authAgentFor(owner).post('/sso/oidc/config/test');
			const url = new URL(String((start.body as { data?: { url?: string } }).data?.url));
			provider.loginNonce = url.searchParams.get('nonce') ?? undefined;
			const state = url.searchParams.get('state') ?? '';
			return {
				start: await describeResponse(start),
				callbackStatus: (
					await requestCallback(`?code=code-1&state=${encodeURIComponent(state)}`, cookiesOf(start))
				).status,
			};
		});
		outcomes['a changed row: a sign-in'] = await runCase(
			async () => await describeResponse(await signIn()),
		);
		outcomes['a changed row: a save with the redacted secret'] = await runCase(async () => {
			await writeRow(
				await storedConfig({
					clientId: 'db-client',
					clientSecret: await cipher.encryptV2('db-secret'),
				}),
			);
			const response = await testServer
				.authAgentFor(owner)
				.post('/sso/oidc/config')
				.send({
					...baseConfig,
					clientSecret: OIDC_CLIENT_SECRET_REDACTED_VALUE,
					loginEnabled: true,
				});
			return { status: response.status, config: await describeConfig(true) };
		});
		outcomes['a changed row: a logout'] = await runCase(async () => {
			for (const cookie of rowSession) {
				if (cookie.startsWith('n8n-auth=')) await labelSessionToken(cookie.slice(9));
			}
			return await describeResponse(
				await request(testServer.app)
					.post('/rest/sso/oidc/logout')
					.set('Cookie', rowSession.join('; ')),
			);
		});

		const instanceSettings = Container.get(InstanceSettings);
		for (const role of ['unset', 'leader', 'follower'] as const) {
			await resetOidc();
			await configure({ loginEnabled: true });
			await startLogin();
			await writeRow(await storedConfig({ clientId: `reloaded-${role}`, prompt: 'login' }));
			instanceSettings.instanceRole = role;
			try {
				outcomes[`the reload command, instance role ${role}`] = await runCase(async () => {
					await sendReloadCommand();
					return {
						getConfig: await getConfigAs(owner),
						login: await describeResponse((await startLogin()).response),
					};
				});
			} finally {
				instanceSettings.instanceRole = 'unset';
			}
		}
		await resetOidc();
		await configure({ loginEnabled: true });
		await writeRow(await storedConfig({ clientId: 'reloaded-disabled', loginEnabled: false }));
		outcomes['the reload command, login disabled by another instance'] = await runCase(async () => {
			await sendReloadCommand();
			return { login: await describeResponse((await startLogin()).response) };
		});
		await resetOidc();
		await configure({ loginEnabled: false });
		await writeRow(await storedConfig({ clientId: 'reloaded-enabled', loginEnabled: true }));
		outcomes['the reload command, login enabled by another instance'] = await runCase(async () => {
			await sendReloadCommand();
			return { login: await describeResponse((await startLogin()).response) };
		});
		expect(outcomes).toMatchSnapshot();
	});

	test('the provider metadata over time', async () => {
		const outcomes: Record<string, unknown> = {};
		vi.useFakeTimers({ toFake: ['Date'] });
		const start = Date.now();
		const at = (seconds: number) => vi.setSystemTime(start + seconds * 1000);
		const loginAt = async (seconds: number) => {
			at(seconds);
			return await runCase(async () => (await startLogin()).response.status);
		};
		const connectionTest = async () =>
			await runCase(
				async () => (await testServer.authAgentFor(owner).post('/sso/oidc/config/test')).status,
			);
		try {
			at(0);
			await configure({ loginEnabled: true });
			outcomes['A: login at 0 s'] = await loginAt(0);
			outcomes['A: login at 1 s'] = await loginAt(1);
			outcomes['A: login at 10 min'] = await loginAt(600);
			outcomes['A: login at 3599.999 s'] = await loginAt(3599.999);
			outcomes['A: login at 3600 s'] = await loginAt(3600);
			outcomes['A: login at 3600.001 s'] = await loginAt(3600.001);
			outcomes['A: login at 2 h'] = await loginAt(7200);
			outcomes['A: login at 2 h 1 s'] = await loginAt(7201);
			outcomes['A: login at 25 h'] = await loginAt(90000);

			at(100000);
			await configure({ loginEnabled: true });
			useProvider({ discovery: 'unavailable' });
			outcomes['B: a failing discovery, without cached metadata'] = await loginAt(100000);
			useProvider();
			outcomes['B: the next login'] = await loginAt(100001);
			outcomes['B: a login 3599 s after the failure'] = await loginAt(103599);
			outcomes['B: a login 3600 s after the failure'] = await loginAt(103600);

			at(200000);
			await configure({ loginEnabled: true });
			outcomes['C: a connection test'] = await connectionTest();
			outcomes['C: a login after the connection test'] = await loginAt(200001);
			outcomes['C: a second connection test'] = await connectionTest();
			outcomes['C: a login after the second connection test'] = await loginAt(200002);

			at(300000);
			await configure({ loginEnabled: true });
			outcomes['D: login at 0 s'] = await loginAt(300000);
			outcomes['D: init of the service'] = await runCase(async () => {
				await Container.get(OidcService).init();
				return 'done';
			});
			outcomes['D: login after the init'] = await loginAt(300001);

			at(400000);
			await configure({ loginEnabled: true });
			await startLogin();
			usePerson('tim');
			at(400000 + 3000);
			const late = await startLogin();
			at(400000 + 3660);
			outcomes['E: a callback after the metadata expired'] = await runCase(
				async () => await describeResponse(await requestCallback(codeQuery(late), late.cookies)),
			);

			at(500000);
			usePerson('tom');
			const fourteen = await startLogin();
			at(500000 + 14 * 60);
			outcomes['F: a callback 14 minutes after the login'] = await runCase(
				async () =>
					await describeResponse(await requestCallback(codeQuery(fourteen), fourteen.cookies)),
			);
			at(600000);
			usePerson('tod');
			const sixteen = await startLogin();
			at(600000 + 16 * 60);
			outcomes['F: a callback 16 minutes after the login'] = await runCase(
				async () =>
					await describeResponse(await requestCallback(codeQuery(sixteen), sixteen.cookies)),
			);

			at(700000);
			await configure({ loginEnabled: true, discoveryEndpoint: OTHER_DISCOVERY_ENDPOINT });
			outcomes['G: another provider'] = await loginAt(700000);
			outcomes['G: another provider, again'] = await loginAt(700001);
		} finally {
			vi.useRealTimers();
		}
		expect(outcomes).toMatchSnapshot();
	});
});
