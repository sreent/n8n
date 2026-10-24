// The behaviour of the role provisioning of SSO: the config endpoints, the role mapping rule
// endpoints and their public API, the service methods that ordinary code calls, the start of the
// module, the check before a custom role is deleted, and the roles that an OIDC sign-in sets. A
// fake OIDC provider answers the requests of n8n. For each case, the snapshot records the result,
// the events, the pub/sub commands and the rows that the case changed. The snapshot records what
// n8n does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/provisioning/FORK.md tells how the fork made the snapshot.
import { ModuleRegistry } from '@n8n/backend-common';
import { EventService, JwtService, RoleDeletionCheckProxy } from '@n8n/backend-services';
import {
	createTeamProject,
	linkUserToProject,
	mockInstance,
	testDb,
} from '@n8n/backend-test-utils';
import { GlobalConfig } from '@n8n/config';
import type { BooleanLicenseFeature } from '@n8n/constants';
import {
	GLOBAL_ADMIN_ROLE,
	GLOBAL_CHAT_USER_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRelationRepository,
	ProjectRepository,
	RoleMappingRuleRepository,
	SettingsRepository,
	UserRepository,
	type Project,
	type User,
} from '@n8n/db';
import { ModuleMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { ALL_API_KEY_SCOPES, getApiKeyScopesForRole } from '@n8n/permissions';
import type { AssignableProjectRole } from '@n8n/permissions';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { InstanceSettings } from 'n8n-core';
import nock from 'nock';
import request from 'supertest';
import type { MockInstance } from 'vitest';

import config from '@/config';
import { OIDC_PREFERENCES_DB_KEY } from '@/modules/sso-oidc/constants';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import { PubSubEventBus } from '@/scaling/pubsub/pubsub.eventbus';
import { PubSubRegistry } from '@/scaling/pubsub/pubsub.registry';
import { setCurrentAuthenticationMethod } from '@/sso/sso-helpers';

import { createRole } from '@test-integration/db/roles';
import { addApiKey, createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import { setupTestServer } from '@test-integration/utils';

// The code under test. FORK.md tells how to record the snapshot against the original files.
import { PROVISIONING_PREFERENCES_DB_KEY } from '@/modules/provisioning/constants';
import { ProvisioningService } from '@/modules/provisioning/provisioning.service';
import '@/modules/provisioning/provisioning.module';
import '@/modules/provisioning/provisioning.controller';
import '@/modules/provisioning/role-mapping-rule.controller';
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
const CLIENT_ID = 'n8n-client';
const CLIENT_SECRET = 'client-secret';

const testServer = setupTestServer({
	endpointGroups: ['auth', 'users', 'project', 'role', 'publicApi'],
	enabledFeatures: [
		'feat:oidc',
		'feat:saml',
		'feat:advancedPermissions',
		'feat:customRoles',
		'feat:projectRole:admin',
		'feat:projectRole:editor',
		'feat:projectRole:viewer',
	],
});
const recorder = new GoldenRecorder();
const { label, labelString, normalize, describeError, dumpDb, diffDumps } = recorder;

const SSO_LICENCES: Record<string, BooleanLicenseFeature[]> = {
	'oidc and saml': ['feat:oidc', 'feat:saml'],
	'oidc only': ['feat:oidc'],
	'saml only': ['feat:saml'],
	'no sso licence': [],
};

function setSsoLicence(features: BooleanLicenseFeature[]) {
	for (const feature of ['feat:oidc', 'feat:saml'] as const) {
		if (features.includes(feature)) testServer.license.enable(feature);
		else testServer.license.disable(feature);
	}
}

// ----------------------------------------------------------------------------------------------
// The fake provider
// ----------------------------------------------------------------------------------------------

const provider = {
	subject: 'nobody-sub',
	/** The claims of the id token, next to the standard claims. */
	idToken: {} as Record<string, unknown>,
	/** The userinfo response. Without it, the provider sends the claims of the id token. */
	userInfo: undefined as Record<string, unknown> | undefined,
	privateKey: undefined as unknown as CryptoKey,
	publicJwk: {} as JWK,
	/** The nonce of the last login, which the provider puts in the id token. */
	loginNonce: undefined as string | undefined,
	tokens: 0,
};

function mountProvider() {
	const scope = nock(ISSUER).persist();
	scope.get('/.well-known/openid-configuration').reply(200, {
		issuer: ISSUER,
		authorization_endpoint: `${ISSUER}/authorize`,
		token_endpoint: `${ISSUER}/token`,
		userinfo_endpoint: `${ISSUER}/userinfo`,
		jwks_uri: `${ISSUER}/jwks`,
		end_session_endpoint: `${ISSUER}/logout`,
		response_types_supported: ['code'],
		subject_types_supported: ['public'],
		id_token_signing_alg_values_supported: ['RS256'],
		scopes_supported: ['openid', 'email', 'profile'],
		token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
	});
	scope
		.get('/jwks')
		.reply(() => [200, { keys: [{ ...provider.publicJwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }]);
	scope.post('/token').reply(async () => {
		const now = Math.floor(Date.now() / 1000);
		provider.tokens += 1;
		const idToken = await new SignJWT({
			...provider.idToken,
			...(provider.loginNonce ? { nonce: provider.loginNonce } : {}),
		})
			.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
			.setIssuer(ISSUER)
			.setAudience(CLIENT_ID)
			.setSubject(provider.subject)
			.setIssuedAt(now)
			.setExpirationTime(now + 3600)
			.sign(provider.privateKey);
		return [
			200,
			{
				access_token: `access-${provider.tokens}`,
				id_token: idToken,
				token_type: 'Bearer',
				expires_in: 3600,
			},
		];
	});
	scope
		.get('/userinfo')
		.reply(() => [200, { ...(provider.userInfo ?? provider.idToken), sub: provider.subject }]);
}

// ----------------------------------------------------------------------------------------------
// Descriptions of what n8n does
// ----------------------------------------------------------------------------------------------

let ruleCount = 0;

/** Give each new role mapping rule a numbered label, in the order of the rows. */
async function labelNewRules() {
	const rows = await Container.get(RoleMappingRuleRepository).manager.query<Array<{ id: string }>>(
		'SELECT id FROM "role_mapping_rule" ORDER BY rowid',
	);
	for (const { id } of rows) {
		if (!recorder.labels.has(id)) {
			ruleCount += 1;
			label(id, `rule ${ruleCount}`);
		}
	}
}

async function labelNewRows() {
	await recorder.labelNewRows(['project', 'user']);
	await labelNewRules();
}

const SECRET_KEYS = new Set(['password', 'mfaSecret', 'mfaRecoveryCodes', 'apiKey']);

/** A copy without passwords and secrets. */
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

function setCookieHeaders(response: request.Response): string[] {
	const header = response.headers['set-cookie'] as unknown;
	if (Array.isArray(header)) return header as string[];
	return typeof header === 'string' ? [header] : [];
}

/** The cookies of a response, as a browser sends them back. */
function cookiesOf(response: request.Response): string[] {
	return setCookieHeaders(response)
		.map((raw) => raw.split(';')[0])
		.filter((pair) => !pair.endsWith('='));
}

/**
 * A copy with the project ids of each rule sorted. n8n loads the projects of a rule in no fixed
 * order.
 */
function sortProjectIds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortProjectIds);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				key === 'projectIds' && Array.isArray(entry)
					? [...(entry as string[])].sort()
					: sortProjectIds(entry),
			]),
		);
	}
	return value;
}

function describeBody(response: request.Response): unknown {
	const contentType = String(response.headers['content-type'] ?? '');
	if (contentType.includes('json')) return sortProjectIds(normalize(response.body));
	const text = response.text ?? '';
	const location = response.headers.location as string | undefined;
	if (location !== undefined && text === `Found. Redirecting to ${location}`) {
		return '<the text of a redirect>';
	}
	return labelString(text);
}

async function describeResponse(response: request.Response) {
	await labelNewRows();
	const location = response.headers.location as string | undefined;
	return {
		status: response.status,
		...(location !== undefined ? { location: labelString(location) } : {}),
		body: describeBody(response),
	};
}

/** The response of an OIDC callback: the redirect and the user of the session cookie. */
async function describeSignIn(response: request.Response) {
	await labelNewRows();
	const location = response.headers.location as string | undefined;
	const session = cookiesOf(response).find((cookie) => cookie.startsWith('n8n-auth='));
	let sessionOf = '<none>';
	if (session) {
		const payload = Container.get(JwtService).decodeUnverified<{ id?: unknown } | null>(
			decodeURIComponent(session.slice('n8n-auth='.length)),
		);
		sessionOf = labelString(String(payload?.id));
	}
	return {
		status: response.status,
		location: location === undefined ? '<none>' : labelString(location),
		session: sessionOf,
	};
}

/** The global role and the team project roles of the user with this email. */
async function describePerson(email: string) {
	const user = await Container.get(UserRepository).findOne({
		where: { email },
		relations: ['role'],
	});
	if (!user) return '<no user>';
	const relations = await Container.get(ProjectRelationRepository).find({
		where: { userId: user.id },
		relations: ['role', 'project'],
	});
	return {
		role: user.role.slug,
		projects: relations
			.filter((relation) => relation.project.type === 'team')
			.map((relation) => `${labelString(relation.projectId)}: ${relation.role.slug}`)
			.sort(),
	};
}

async function dumpDatabase() {
	const dump = await dumpDb();
	const rows = await Container.get(SettingsRepository).manager.query<
		Array<{ key: string; value: string; loadOnStartup: unknown }>
	>('SELECT * FROM "settings"');
	dump.settings = rows
		.map(({ key, value, loadOnStartup }) =>
			JSON.stringify({ key, value: labelString(value), loadOnStartup }),
		)
		.sort();
	return dump;
}

function describeState() {
	return {
		authenticationMethod: config.getEnv('userManagement.authenticationMethod'),
	};
}

let emit: MockInstance<EventService['emit']>;

function describeEvents() {
	return emit.mock.calls.map(([name, payload]) => {
		const described = normalize(redact(payload)) as Record<string, unknown>;
		if (name !== 'expression-mapping-roles-resolved') return [name, described];
		// The project roles come in the order in which n8n loads the projects of the rules.
		const projectRoles = described.projectRoles as Array<{ projectId: string }>;
		return [
			name,
			{
				...described,
				projectRoles: [...projectRoles].sort((a, b) => a.projectId.localeCompare(b.projectId)),
				removedProjectIds: [...(described.removedProjectIds as string[])].sort(),
			},
		];
	});
}

/** The update time that a case starts with. A rule with another update time after the case was written. */
const OLD_TIME = '2020-01-01 00:00:00.000';

/** The rules that a case wrote: their update time changed, also when no other column changed. */
async function readWrittenRules() {
	const rows = await Container.get(RoleMappingRuleRepository).manager.query<
		Array<{ id: string; updatedAt: string }>
	>('SELECT id, updatedAt FROM "role_mapping_rule"');
	return rows
		.filter(({ updatedAt }) => updatedAt !== OLD_TIME)
		.map(({ id }) => labelString(id))
		.sort();
}

/**
 * Run a case, and record what it did. A case that sorts rules by their update time keeps the update
 * times, and does not record which rules it wrote.
 */
async function runCase(action: () => Promise<unknown>, { keepUpdateTimes = false } = {}) {
	published.length = 0;
	emit.mockClear();
	await labelNewRows();
	if (!keepUpdateTimes) {
		await Container.get(RoleMappingRuleRepository).manager.query(
			'UPDATE "role_mapping_rule" SET "updatedAt" = ?',
			[OLD_TIME],
		);
	}
	const before = await dumpDatabase();
	let result: unknown;
	try {
		result = await action();
	} catch (error) {
		result = `throws ${describeError(error)}`;
	}
	await labelNewRows();
	const after = await dumpDatabase();
	return {
		result,
		events: describeEvents(),
		published: normalize(published),
		state: describeState(),
		database: diffDumps(before, after),
		...(keepUpdateTimes ? {} : { writtenRules: await readWrittenRules() }),
	};
}

/**
 * The items of a rule list. Rules of both types can have the same order value, and n8n returns
 * those in no fixed order. So inside each run of equal order values, the description sorts the
 * rules by type and expression.
 */
function describeListItems(items: unknown) {
	if (!Array.isArray(items)) return normalize(items);
	const rules = items as Array<{ order: number; type: string; expression: string }>;
	const sorted: typeof rules = [];
	for (let start = 0; start < rules.length; ) {
		let end = start + 1;
		while (end < rules.length && rules[end].order === rules[start].order) end++;
		sorted.push(
			...rules
				.slice(start, end)
				.sort((a, b) => `${a.type} ${a.expression}`.localeCompare(`${b.type} ${b.expression}`)),
		);
		start = end;
	}
	return sortProjectIds(normalize(sorted));
}

/** A response of a rule list, of the REST API (`data.items`) or of the public API (`data`). */
async function describeListResponse(response: request.Response) {
	const described = await describeResponse(response);
	const body = response.body as { data?: unknown; nextCursor?: unknown };
	if (response.status !== 200 || body?.data === undefined) return described;
	if (Array.isArray(body.data)) {
		return {
			...described,
			body: { ...(described.body as object), data: describeListItems(body.data) },
		};
	}
	const data = body.data as { count?: unknown; items?: unknown };
	return {
		...described,
		body: { data: { count: data.count, items: describeListItems(data.items) } },
	};
}

// ----------------------------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------------------------

let owner: User;
let admin: User;
let member: User;
let chatUser: User;
let alpha: Project;
let beta: Project;
let gamma: Project;
let memberPersonalProject: Project;
/** The first read of the config after the start of n8n, with a row that the start did not see. */
let firstRead: unknown;

/** The full config with every flag off and the default claim names. */
const OFF_ROW = {
	scopesProvisionInstanceRole: false,
	scopesProvisionProjectRoles: false,
	scopesName: 'n8n',
	scopesInstanceRoleClaimName: 'n8n_instance_role',
	scopesProjectsRolesClaimName: 'n8n_projects',
	scopesUseExpressionMapping: false,
};

/** The body of a PATCH that sets every flag off and clears the default role. */
const OFF = { ...OFF_ROW, defaultInstanceRole: null };

const service = () => Container.get(ProvisioningService);

/** Remove the provisioning row and every rule, and load the config again. */
async function resetProvisioning() {
	await Container.get(SettingsRepository).delete({ key: PROVISIONING_PREFERENCES_DB_KEY });
	await Container.get(RoleMappingRuleRepository).delete({});
	await service().handleReloadSsoProvisioningConfiguration();
}

/** Save a config through the API, outside of a case. */
async function setConfig(changes: Record<string, unknown>) {
	const response = await testServer
		.authAgentFor(owner)
		.patch('/sso/provisioning/config')
		.send({ ...OFF, ...changes });
	if (response.status !== 200) {
		throw new Error(`Cannot save the config: ${response.status} ${JSON.stringify(response.body)}`);
	}
}

/** Add a rule through the API, outside of a case. */
async function addRule(rule: {
	expression: string;
	role: string;
	type: 'instance' | 'project';
	projectIds?: string[];
	order?: number;
}) {
	const response = await testServer.authAgentFor(owner).post('/role-mapping-rule').send(rule);
	if (response.status !== 200) {
		throw new Error(`Cannot add the rule: ${response.status} ${JSON.stringify(response.body)}`);
	}
	await labelNewRules();
	return (response.body as { data: { id: string } }).data.id;
}

async function writeRow(value: string) {
	const settings = Container.get(SettingsRepository);
	await settings.delete({ key: PROVISIONING_PREFERENCES_DB_KEY });
	await settings.insert({ key: PROVISIONING_PREFERENCES_DB_KEY, value, loadOnStartup: true });
}

async function getConfig() {
	return await describeResponse(
		await testServer.authAgentFor(owner).get('/sso/provisioning/config'),
	);
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

async function createFixtureProject(name: string) {
	const project = await createTeamProject(name);
	label(project.id, `project ${name}`);
	return project;
}

/** Send the reload command, as another main instance does after it changes the config. */
async function sendReloadCommand() {
	(Container.get(PubSubEventBus).emit as (event: string) => boolean)(
		'reload-sso-provisioning-configuration',
	);
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Save the OIDC config with the login on, outside of a case. */
async function enableOidcLogin() {
	await Container.get(SettingsRepository).delete({ key: OIDC_PREFERENCES_DB_KEY });
	await setCurrentAuthenticationMethod('email');
	Container.get(GlobalConfig).sso.oidc.loginEnabled = false;
	await Container.get(OidcService).init();
	const response = await testServer.authAgentFor(owner).post('/sso/oidc/config').send({
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		discoveryEndpoint: DISCOVERY_ENDPOINT,
		loginEnabled: true,
	});
	if (response.status !== 200) {
		throw new Error(`Cannot configure OIDC: ${response.status} ${JSON.stringify(response.body)}`);
	}
}

type Person = { email: string; subject: string };

let personCount = 0;

/** A person without a user in n8n. */
function newPerson(): Person {
	personCount += 1;
	return { email: `new${personCount}@example.com`, subject: `new${personCount}-sub` };
}

/** A person with a user in n8n: the global role, and roles in team projects. */
async function existingPerson(
	role: User['role'] = GLOBAL_MEMBER_ROLE,
	projects: Array<[Project, AssignableProjectRole]> = [],
): Promise<Person> {
	personCount += 1;
	const name = `person${personCount}`;
	const user = await createFixtureUser(name, { role });
	for (const [project, projectRole] of projects) {
		await linkUserToProject(user, project, projectRole);
	}
	await labelNewRows();
	return { email: user.email, subject: `${name}-sub` };
}

const fixturePerson = (user: User): Person => ({
	email: user.email,
	subject: `${user.email.split('@')[0]}-sub`,
});

/**
 * A login and its callback. The id token has the claims, with the email of the person. The
 * userinfo response has the claims of `userInfo` with the email, or else the claims of the id token.
 */
async function signIn(
	person: Person,
	claims: Record<string, unknown>,
	userInfo?: Record<string, unknown>,
) {
	const base = { email: person.email, email_verified: true };
	provider.subject = person.subject;
	provider.idToken = { ...base, ...claims };
	provider.userInfo = userInfo && { ...base, ...userInfo };
	const login = await request(testServer.app).get('/rest/sso/oidc/login');
	const location = login.headers.location as string | undefined;
	if (!location?.startsWith('https://')) return login;
	const url = new URL(location);
	provider.loginNonce = url.searchParams.get('nonce') ?? undefined;
	const state = url.searchParams.get('state') ?? '';
	return await request(testServer.app)
		.get(`/rest/sso/oidc/callback?code=code-1&state=${encodeURIComponent(state)}`)
		.set('Cookie', cookiesOf(login).join('; '));
}

async function signInCase(
	person: Person,
	claims: Record<string, unknown>,
	userInfo?: Record<string, unknown>,
) {
	return await runCase(async () => ({
		response: await describeSignIn(await signIn(person, claims, userInfo)),
		after: await describePerson(person.email),
	}));
}

/** A claim value as a part of a case name. */
const describeValue = (value: unknown) =>
	value === MISSING ? 'missing' : JSON.stringify(value).slice(0, 60);
const MISSING = Symbol('missing');
const claim = (name: string, value: unknown) => (value === MISSING ? {} : { [name]: value });

beforeAll(async () => {
	const keys = await generateKeyPair('RS256');
	provider.privateKey = keys.privateKey;
	provider.publicJwk = await exportJWK(keys.publicKey);
	nock.cleanAll();
	mountProvider();

	await testDb.truncate(['User', 'Project', 'RoleMappingRule']);
	owner = await createFixtureUser('owner', { role: GLOBAL_OWNER_ROLE });
	admin = await createFixtureUser('admin', { role: GLOBAL_ADMIN_ROLE });
	member = await createFixtureUser('member', { role: GLOBAL_MEMBER_ROLE });
	chatUser = await createFixtureUser('chat', { role: GLOBAL_CHAT_USER_ROLE });
	// Only the API key scopes of upstream n8n: the snapshot comes from upstream, which has no fork
	// API key scopes (packages/@n8n/permissions/src/fork-scopes.ts).
	const apiKey = await addApiKey(owner, {
		scopes: getApiKeyScopesForRole(owner).filter((scope) => ALL_API_KEY_SCOPES.has(scope)),
	});
	owner.apiKeys = [apiKey];
	// A generated id without a digit does not get the `<id>` placeholder, so the key needs a label.
	label(apiKey.id, 'id of the api key of the owner');
	label(apiKey.apiKey, 'api key of the owner');
	label(apiKey.label, 'label of the api key of the owner');
	alpha = await createFixtureProject('alpha');
	beta = await createFixtureProject('beta');
	gamma = await createFixtureProject('gamma');
	memberPersonalProject = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
		member.id,
	);
	await createRole({ slug: 'global:auditor', displayName: 'Auditor', roleType: 'global' });
	await createRole({ slug: 'project:reviewer', displayName: 'Reviewer', roleType: 'project' });
	await createRole({ slug: 'project:odd-global', displayName: 'Odd global', roleType: 'global' });
	await createRole({ slug: 'global:odd-project', displayName: 'Odd project', roleType: 'project' });
	await labelNewRows();
	await writeRow(JSON.stringify({ ...OFF_ROW, scopesName: 'stored after the start' }));
	firstRead = {
		GET: await getConfig(),
		getConfig: normalize(await Container.get(ProvisioningService).getConfig()),
	};
	await Container.get(SettingsRepository).delete({ key: PROVISIONING_PREFERENCES_DB_KEY });
});

beforeEach(async () => {
	// The test config restores spies before each test.
	emit = vi.spyOn(Container.get(EventService), 'emit');
	await resetProvisioning();
});

afterAll(() => {
	nock.cleanAll();
});

// ----------------------------------------------------------------------------------------------
// Cases
// ----------------------------------------------------------------------------------------------

/** Each test runs many cases one after another, against a real database. */
const TEST_TIMEOUT = 10 * 60 * 1000;

describe('Role provisioning', { timeout: TEST_TIMEOUT }, () => {
	test('the config endpoints', async () => {
		const outcomes: Record<string, unknown> = {};
		const users = { owner, admin, member, 'chat user': chatUser };

		for (const [licence, features] of Object.entries(SSO_LICENCES)) {
			setSsoLicence(features);
			for (const [name, user] of Object.entries(users)) {
				outcomes[`${licence} | ${name} | GET`] = await runCase(
					async () =>
						await describeResponse(
							await testServer.authAgentFor(user).get('/sso/provisioning/config'),
						),
				);
				outcomes[`${licence} | ${name} | PATCH`] = await runCase(
					async () =>
						await describeResponse(
							await testServer
								.authAgentFor(user)
								.patch('/sso/provisioning/config')
								.send({ scopesName: `set by ${name}` }),
						),
				);
				await resetProvisioning();
			}
			outcomes[`${licence} | no session | GET`] = await runCase(
				async () =>
					await describeResponse(
						await request(testServer.app).get('/rest/sso/provisioning/config'),
					),
			);
			outcomes[`${licence} | no session | PATCH`] = await runCase(
				async () =>
					await describeResponse(
						await request(testServer.app)
							.patch('/rest/sso/provisioning/config')
							.send({ scopesName: 'set without a session' }),
					),
			);
		}
		setSsoLicence(SSO_LICENCES['oidc and saml']);

		outcomes['GET without a row'] = await runCase(getConfig);

		const bodies: Record<string, unknown> = {
			'no body': undefined,
			'an empty object': {},
			'an array': [],
			'every field': {
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: true,
				scopesName: 'groups',
				scopesInstanceRoleClaimName: 'role',
				scopesProjectsRolesClaimName: 'projects',
				scopesUseExpressionMapping: false,
				defaultInstanceRole: 'global:admin',
			},
			'the instance role from claims': { scopesProvisionInstanceRole: true },
			'the project roles from claims': { scopesProvisionProjectRoles: true },
			'both from claims': {
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: true,
			},
			'expression mapping': { scopesUseExpressionMapping: true },
			'expression mapping and claims': {
				scopesUseExpressionMapping: true,
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: true,
			},
			'claim names': {
				scopesName: 'groups',
				scopesInstanceRoleClaimName: 'role',
				scopesProjectsRolesClaimName: 'projects',
			},
			'empty claim names': {
				scopesName: '',
				scopesInstanceRoleClaimName: '',
				scopesProjectsRolesClaimName: '',
			},
			'every field null': {
				scopesProvisionInstanceRole: null,
				scopesProvisionProjectRoles: null,
				scopesName: null,
				scopesInstanceRoleClaimName: null,
				scopesProjectsRolesClaimName: null,
				scopesUseExpressionMapping: null,
				defaultInstanceRole: null,
			},
			'an unknown key': { scopesName: 'with an unknown key', unknownKey: 'value' },
			'a boolean as a string': { scopesProvisionInstanceRole: 'true' },
			'a number as a name': { scopesName: 5 },
			'deleteProjectRules false': { deleteProjectRules: false },
			'deleteProjectRules as a string': { deleteProjectRules: 'true' },
		};
		const defaultRoles: Record<string, unknown> = {
			'global:owner': 'global:owner',
			'global:admin': 'global:admin',
			'global:member': 'global:member',
			'global:chatUser': 'global:chatUser',
			'a custom global role': 'global:auditor',
			'project:editor': 'project:editor',
			'a custom project role': 'project:reviewer',
			'project:personalOwner': 'project:personalOwner',
			'credential:owner': 'credential:owner',
			'workflow:owner': 'workflow:owner',
			'a global role with a project prefix': 'project:odd-global',
			'a project role with a global prefix': 'global:odd-project',
			'block:access': 'block:access',
			'block:other': 'block:other',
			'an empty string': '',
			'128 characters': `global:${'x'.repeat(121)}`,
			'129 characters': `global:${'x'.repeat(122)}`,
			'an unknown global role': 'global:does-not-exist',
			'admin without a prefix': 'admin',
			'GLOBAL:ADMIN': 'GLOBAL:ADMIN',
			'a leading space': ' global:admin',
			'a number': 5,
			'a boolean': true,
		};
		for (const [name, role] of Object.entries(defaultRoles)) {
			bodies[`defaultInstanceRole ${name}`] = { defaultInstanceRole: role };
		}
		for (const [name, body] of Object.entries(bodies)) {
			await resetProvisioning();
			outcomes[`PATCH ${name}`] = await runCase(async () => {
				const call = testServer.authAgentFor(owner).patch('/sso/provisioning/config');
				const response = body === undefined ? await call : await call.send(body as object);
				return { response: await describeResponse(response), get: await getConfig() };
			});
		}

		// A PATCH after another PATCH.
		await resetProvisioning();
		await setConfig({
			scopesProvisionInstanceRole: true,
			scopesName: 'first',
			defaultInstanceRole: 'global:admin',
		});
		outcomes['a second PATCH with one key'] = await runCase(async () => ({
			response: await describeResponse(
				await testServer
					.authAgentFor(owner)
					.patch('/sso/provisioning/config')
					.send({ scopesProvisionProjectRoles: true }),
			),
			get: await getConfig(),
		}));
		outcomes['a third PATCH with nulls'] = await runCase(async () => ({
			response: await describeResponse(
				await testServer.authAgentFor(owner).patch('/sso/provisioning/config').send({
					scopesName: null,
					defaultInstanceRole: null,
					scopesProvisionInstanceRole: null,
				}),
			),
			get: await getConfig(),
		}));

		// The project rules and deleteProjectRules.
		const withRules: Record<string, Record<string, unknown>> = {
			'deleteProjectRules true': { deleteProjectRules: true },
			'deleteProjectRules true and expression mapping off': {
				deleteProjectRules: true,
				scopesUseExpressionMapping: false,
			},
			'deleteProjectRules true and the instance role from claims': {
				deleteProjectRules: true,
				scopesUseExpressionMapping: false,
				scopesProvisionInstanceRole: true,
			},
			'deleteProjectRules false': { deleteProjectRules: false },
			'expression mapping off': { scopesUseExpressionMapping: false },
			'an invalid default role and deleteProjectRules true': {
				deleteProjectRules: true,
				defaultInstanceRole: 'global:owner',
			},
		};
		for (const [name, body] of Object.entries(withRules)) {
			await resetProvisioning();
			await setConfig({ scopesUseExpressionMapping: true });
			await addRule({ expression: 'instance rule A', role: 'global:admin', type: 'instance' });
			await addRule({ expression: 'instance rule B', role: 'global:member', type: 'instance' });
			await addRule({
				expression: 'project rule A',
				role: 'project:editor',
				type: 'project',
				projectIds: [alpha.id],
			});
			await addRule({
				expression: 'project rule B',
				role: 'project:viewer',
				type: 'project',
				projectIds: [alpha.id, beta.id],
			});
			outcomes[`with rules | PATCH ${name}`] = await runCase(async () => ({
				response: await describeResponse(
					await testServer.authAgentFor(owner).patch('/sso/provisioning/config').send(body),
				),
				get: await getConfig(),
			}));
		}
		await resetProvisioning();
		await addRule({ expression: 'instance rule C', role: 'global:admin', type: 'instance' });
		outcomes['with an instance rule only | PATCH deleteProjectRules true'] = await runCase(
			async () =>
				await describeResponse(
					await testServer
						.authAgentFor(owner)
						.patch('/sso/provisioning/config')
						.send({ deleteProjectRules: true }),
				),
		);
		await resetProvisioning();
		outcomes['without rules | PATCH deleteProjectRules true'] = await runCase(
			async () =>
				await describeResponse(
					await testServer
						.authAgentFor(owner)
						.patch('/sso/provisioning/config')
						.send({ deleteProjectRules: true }),
				),
		);

		// Multi-main mode.
		const instanceSettings = Container.get(InstanceSettings);
		instanceSettings.setMultiMainEnabled(true);
		instanceSettings.setMultiMainLicensed(true);
		try {
			await resetProvisioning();
			outcomes['multi-main | PATCH'] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.patch('/sso/provisioning/config')
							.send({ scopesName: 'multi-main' }),
					),
			);
			await addRule({
				expression: 'project rule in multi-main',
				role: 'project:editor',
				type: 'project',
				projectIds: [alpha.id],
			});
			outcomes['multi-main | PATCH deleteProjectRules true'] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.patch('/sso/provisioning/config')
							.send({ deleteProjectRules: true }),
					),
			);
			outcomes['multi-main | GET'] = await runCase(getConfig);
		} finally {
			instanceSettings.setMultiMainEnabled(false);
			instanceSettings.setMultiMainLicensed(false);
		}

		// The base of a PATCH: the config in memory, or the stored row.
		await resetProvisioning();
		await setConfig({ scopesName: 'in memory' });
		await writeRow(
			JSON.stringify({
				...OFF_ROW,
				scopesName: 'stored only',
				scopesProvisionInstanceRole: true,
			}),
		);
		outcomes['a PATCH after another instance changed the row'] = await runCase(async () => ({
			response: await describeResponse(
				await testServer
					.authAgentFor(owner)
					.patch('/sso/provisioning/config')
					.send({ scopesInstanceRoleClaimName: 'patched_role' }),
			),
			get: await getConfig(),
		}));

		// When a PATCH deletes the project rules.
		const switches: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
			'expression mapping on, PATCH expression mapping on': [
				{ scopesUseExpressionMapping: true },
				{ scopesUseExpressionMapping: true },
			],
			'expression mapping on, PATCH another key': [
				{ scopesUseExpressionMapping: true },
				{ scopesName: 'other' },
			],
			'expression mapping on, PATCH expression mapping null': [
				{ scopesUseExpressionMapping: true },
				{ scopesUseExpressionMapping: null },
			],
			'expression mapping off, PATCH expression mapping off': [
				{},
				{ scopesUseExpressionMapping: false },
			],
			'expression mapping off, PATCH another key': [{}, { scopesName: 'other' }],
			'expression mapping off, PATCH expression mapping on': [
				{},
				{ scopesUseExpressionMapping: true },
			],
			'project roles from claims, PATCH project roles off': [
				{ scopesProvisionProjectRoles: true },
				{ scopesProvisionProjectRoles: false },
			],
			'project roles from claims, PATCH expression mapping on': [
				{ scopesProvisionProjectRoles: true },
				{ scopesProvisionProjectRoles: false, scopesUseExpressionMapping: true },
			],
			'expression mapping on, PATCH the instance role from claims': [
				{ scopesUseExpressionMapping: true },
				{ scopesUseExpressionMapping: false, scopesProvisionInstanceRole: true },
			],
			'both from claims, PATCH project roles off': [
				{ scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true },
				{ scopesProvisionProjectRoles: false },
			],
			'expression mapping on, PATCH project roles from claims': [
				{ scopesUseExpressionMapping: true },
				{ scopesUseExpressionMapping: false, scopesProvisionProjectRoles: true },
			],
			'the instance role from claims, PATCH it off': [
				{ scopesProvisionInstanceRole: true },
				{ scopesProvisionInstanceRole: false },
			],
			'expression mapping on, a failing PATCH that turns it off': [
				{ scopesUseExpressionMapping: true },
				{ scopesUseExpressionMapping: false, defaultInstanceRole: 'global:owner' },
			],
		};
		for (const [name, [initial, body]] of Object.entries(switches)) {
			await resetProvisioning();
			await setConfig(initial);
			await addRule({ expression: 'switch instance', role: 'global:admin', type: 'instance' });
			await addRule({
				expression: 'switch project',
				role: 'project:editor',
				type: 'project',
				projectIds: [alpha.id],
			});
			outcomes[`project rules | ${name}`] = await runCase(
				async () =>
					await describeResponse(
						await testServer.authAgentFor(owner).patch('/sso/provisioning/config').send(body),
					),
			);
		}

		// Rows that the GET reads.
		const full = {
			scopesProvisionInstanceRole: true,
			scopesProvisionProjectRoles: true,
			scopesName: 'stored',
			scopesInstanceRoleClaimName: 'stored_role',
			scopesProjectsRolesClaimName: 'stored_projects',
			scopesUseExpressionMapping: false,
		};
		const rows: Record<string, string> = {
			'a full row': JSON.stringify(full),
			'a full row with a default role': JSON.stringify({
				...full,
				defaultInstanceRole: 'global:admin',
			}),
			'a partial row': JSON.stringify({ scopesProvisionInstanceRole: true }),
			'a row with an unknown key': JSON.stringify({ ...full, unknownKey: 1 }),
			'a row with a wrong type': JSON.stringify({ ...full, scopesName: 5 }),
			'a row with a project default role': JSON.stringify({
				...full,
				defaultInstanceRole: 'project:editor',
			}),
			'a row that is not JSON': 'not json',
			'a row with null': 'null',
			'a row with an array': '[]',
		};
		for (const [name, value] of Object.entries(rows)) {
			await resetProvisioning();
			await writeRow(value);
			outcomes[`${name} | GET`] = await runCase(getConfig);
			outcomes[`${name} | reload, then GET`] = await runCase(async () => {
				await service().handleReloadSsoProvisioningConfiguration();
				return await getConfig();
			});
			outcomes[`${name} | PATCH`] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.patch('/sso/provisioning/config')
							.send({ scopesName: 'patched' }),
					),
			);
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('the rule endpoints', async () => {
		const outcomes: Record<string, unknown> = {};

		/** Three instance rules and two project rules. */
		const baseRules = async () => {
			await Container.get(RoleMappingRuleRepository).delete({});
			const instance = [
				await addRule({ expression: 'instance 0', role: 'global:member', type: 'instance' }),
				await addRule({ expression: 'instance 1', role: 'global:admin', type: 'instance' }),
				await addRule({ expression: 'instance 2', role: 'global:chatUser', type: 'instance' }),
			];
			const project = [
				await addRule({
					expression: 'project 0',
					role: 'project:editor',
					type: 'project',
					projectIds: [alpha.id],
				}),
				await addRule({
					expression: 'project 1',
					role: 'project:viewer',
					type: 'project',
					projectIds: [alpha.id, beta.id],
				}),
			];
			return { instance, project };
		};

		// Access, by licence and by role.
		const endpoints: Record<string, (agent: request.Agent, ids: string[]) => request.Test> = {
			GET: (agent) => agent.get('/role-mapping-rule'),
			POST: (agent) =>
				agent
					.post('/role-mapping-rule')
					.send({ expression: 'access probe', role: 'global:member', type: 'instance' }),
			PATCH: (agent, ids) =>
				agent.patch(`/role-mapping-rule/${ids[0]}`).send({ expression: 'patched' }),
			move: (agent, ids) =>
				agent.post(`/role-mapping-rule/${ids[0]}/move`).send({ targetIndex: 2 }),
			DELETE: (agent, ids) => agent.delete(`/role-mapping-rule/${ids[1]}`),
		};
		const agents: Record<string, () => request.Agent> = {
			owner: () => testServer.authAgentFor(owner),
			admin: () => testServer.authAgentFor(admin),
			member: () => testServer.authAgentFor(member),
			'chat user': () => testServer.authAgentFor(chatUser),
			'no session': () => testServer.authlessAgent,
		};
		for (const [licence, features] of Object.entries(SSO_LICENCES)) {
			for (const [endpoint, call] of Object.entries(endpoints)) {
				for (const [name, agent] of Object.entries(agents)) {
					setSsoLicence(SSO_LICENCES['oidc and saml']);
					const { instance } = await baseRules();
					setSsoLicence(features);
					const describe = endpoint === 'GET' ? describeListResponse : describeResponse;
					outcomes[`${licence} | ${name} | ${endpoint}`] = await runCase(
						async () => await describe(await call(agent(), instance)),
					);
				}
			}
		}
		setSsoLicence(SSO_LICENCES['oidc and saml']);

		// Creating a rule.
		const create: Record<string, unknown> = {
			'no body': undefined,
			'an instance rule': { expression: 'new', role: 'global:admin', type: 'instance' },
			'an instance rule at order 0': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				order: 0,
			},
			'an instance rule at order 1': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				order: 1,
			},
			'an instance rule at order 3, the end': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				order: 3,
			},
			'an instance rule at order 9': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				order: 9,
			},
			'an instance rule at order -1': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				order: -1,
			},
			'an instance rule at order 1.5': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				order: 1.5,
			},
			'an instance rule at order "1"': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				order: '1',
			},
			'a project rule': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [gamma.id],
			},
			'a project rule with two projects': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [gamma.id, alpha.id],
			},
			'a project rule at order 0': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [gamma.id],
				order: 0,
			},
			'a project rule at order 9': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [gamma.id],
				order: 9,
			},
			'a project rule without projectIds': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
			},
			'a project rule with empty projectIds': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [],
			},
			'a project rule with an unknown project': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: ['unknownproject1'],
			},
			'a project rule with a known and an unknown project': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [gamma.id, 'unknownproject1'],
			},
			'a project rule with a project twice': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [gamma.id, gamma.id],
			},
			'a project rule with a personal project': {
				expression: 'new',
				role: 'project:editor',
				type: 'project',
				projectIds: [memberPersonalProject.id],
			},
			'an instance rule with projectIds': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				projectIds: [gamma.id],
			},
			'an instance rule with empty projectIds': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				projectIds: [],
			},
			'an unknown type': { expression: 'new', role: 'global:admin', type: 'other' },
			'no type': { expression: 'new', role: 'global:admin' },
			'no role': { expression: 'new', type: 'instance' },
			'no expression': { role: 'global:admin', type: 'instance' },
			'an empty expression': { expression: '', role: 'global:admin', type: 'instance' },
			'a blank expression': { expression: '   ', role: 'global:admin', type: 'instance' },
			'an expression with invalid syntax': {
				expression: '{{ ) }}',
				role: 'global:admin',
				type: 'instance',
			},
			'an expression of 10000 characters': {
				expression: `{{ ${'1'.repeat(9994)} }}`,
				role: 'global:admin',
				type: 'instance',
			},
			'an unknown key': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				unknownKey: 1,
			},
			'a role of 129 characters': {
				expression: 'new',
				role: `global:${'x'.repeat(122)}`,
				type: 'instance',
			},
		};
		const instanceRoles: Record<string, string> = {
			'global:owner': 'global:owner',
			'global:member': 'global:member',
			'global:chatUser': 'global:chatUser',
			'a custom global role': 'global:auditor',
			'project:editor': 'project:editor',
			'a custom project role': 'project:reviewer',
			'project:personalOwner': 'project:personalOwner',
			'credential:owner': 'credential:owner',
			'block:access': 'block:access',
			'a global role with a project prefix': 'project:odd-global',
			'a project role with a global prefix': 'global:odd-project',
			'an unknown global role': 'global:none',
		};
		const combinations: Record<string, unknown> = {
			'a project rule without projectIds and with an unknown role': {
				expression: 'new',
				role: 'project:none',
				type: 'project',
			},
			'a project rule without projectIds and with a global role': {
				expression: 'new',
				role: 'global:admin',
				type: 'project',
			},
			'a project rule with an unknown project and a global role': {
				expression: 'new',
				role: 'global:admin',
				type: 'project',
				projectIds: ['unknownproject1'],
			},
			'a project rule with an unknown project and an unknown role': {
				expression: 'new',
				role: 'project:none',
				type: 'project',
				projectIds: ['unknownproject1'],
			},
			'an instance rule with projectIds and a project role': {
				expression: 'new',
				role: 'project:editor',
				type: 'instance',
				projectIds: [gamma.id],
			},
			'an instance rule with projectIds and an unknown role': {
				expression: 'new',
				role: 'global:none',
				type: 'instance',
				projectIds: [gamma.id],
			},
			'an instance rule with an unknown project': {
				expression: 'new',
				role: 'global:admin',
				type: 'instance',
				projectIds: ['unknownproject1'],
			},
		};
		Object.assign(create, combinations);
		for (const [name, role] of Object.entries(instanceRoles)) {
			create[`an instance rule with ${name}`] = { expression: 'new', role, type: 'instance' };
		}
		const projectRoles: Record<string, string> = {
			'project:admin': 'project:admin',
			'project:viewer': 'project:viewer',
			'project:chatUser': 'project:chatUser',
			'project:personalOwner': 'project:personalOwner',
			'a custom project role': 'project:reviewer',
			'global:admin': 'global:admin',
			'a custom global role': 'global:auditor',
			'block:access': 'block:access',
			'a global role with a project prefix': 'project:odd-global',
			'a project role with a global prefix': 'global:odd-project',
			'an unknown project role': 'project:none',
		};
		for (const [name, role] of Object.entries(projectRoles)) {
			create[`a project rule with ${name}`] = {
				expression: 'new',
				role,
				type: 'project',
				projectIds: [gamma.id],
			};
		}
		for (const [name, body] of Object.entries(create)) {
			await baseRules();
			outcomes[`POST ${name}`] = await runCase(async () => {
				const call = testServer.authAgentFor(owner).post('/role-mapping-rule');
				return await describeResponse(
					body === undefined ? await call : await call.send(body as object),
				);
			});
		}

		// Listing the rules.
		await Container.get(RoleMappingRuleRepository).delete({});
		for (let index = 0; index < 12; index++) {
			await addRule({ expression: `list ${index}`, role: 'global:member', type: 'instance' });
		}
		for (let index = 0; index < 3; index++) {
			await addRule({
				expression: `list project ${index}`,
				role: 'project:viewer',
				type: 'project',
				projectIds: [alpha.id],
			});
		}
		// Creation and update times in an order that differs from the evaluation order.
		const listed = await Container.get(RoleMappingRuleRepository).find({
			order: { order: 'ASC' },
		});
		const timeOf = (offset: number) =>
			new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString().replace('T', ' ').slice(0, 23);
		for (const [index, rule] of listed.entries()) {
			await Container.get(RoleMappingRuleRepository).manager.query(
				'UPDATE "role_mapping_rule" SET "createdAt" = ?, "updatedAt" = ? WHERE id = ?',
				[
					timeOf(((index * 7) % listed.length) + 1),
					timeOf(((index * 11) % listed.length) + 1),
					rule.id,
				],
			);
		}
		const queries: Record<string, string> = {
			'no query': '',
			'type instance': '?type=instance',
			'type project': '?type=project',
			'type other': '?type=other',
			'sortBy order:asc': '?sortBy=order:asc',
			'sortBy order:desc, take 20': '?sortBy=order:desc&take=20',
			'sortBy createdAt:asc': '?sortBy=createdAt:asc',
			'sortBy createdAt:desc': '?sortBy=createdAt:desc',
			'sortBy updatedAt:asc': '?sortBy=updatedAt:asc',
			'sortBy updatedAt:desc': '?sortBy=updatedAt:desc',
			'sortBy expression:asc': '?sortBy=expression:asc',
			'skip 2': '?skip=2',
			'take 2': '?take=2',
			'skip 4 and take 2': '?skip=4&take=2',
			'take 0': '?take=0',
			'take 250': '?take=250',
			'take 251': '?take=251',
			'take 1000': '?take=1000',
			'skip -1': '?skip=-1',
			'take abc': '?take=abc',
			'skip 100': '?skip=100',
			'type project, sortBy order:desc, skip 1, take 1':
				'?type=project&sortBy=order:desc&skip=1&take=1',
		};
		for (const [name, query] of Object.entries(queries)) {
			outcomes[`GET ${name}`] = await runCase(
				async () =>
					await describeListResponse(
						await testServer.authAgentFor(owner).get(`/role-mapping-rule${query}`),
					),
				{ keepUpdateTimes: true },
			);
		}

		// Changing a rule.
		const patches: Record<string, [number | string, unknown]> = {
			'the expression': [1, { expression: 'patched' }],
			'the role': [1, { role: 'global:auditor' }],
			'the role to a project role': [1, { role: 'project:editor' }],
			'the role to an unknown role': [1, { role: 'global:none' }],
			'the role to block:access': [1, { role: 'block:access' }],
			'the type to project': [1, { type: 'project' }],
			'the type to project with projectIds': [1, { type: 'project', projectIds: [gamma.id] }],
			'the type to project with a project role and projectIds': [
				1,
				{ type: 'project', role: 'project:editor', projectIds: [gamma.id] },
			],
			'the type to instance': [3, { type: 'instance' }],
			'the type to instance with a global role': [3, { type: 'instance', role: 'global:admin' }],
			'the type to instance with a global role and empty projectIds': [
				3,
				{ type: 'instance', role: 'global:admin', projectIds: [] },
			],
			'the same type': [1, { type: 'instance' }],
			'order 0, taken': [1, { order: 0 }],
			'order 1, its own': [1, { order: 1 }],
			'order 2, taken': [1, { order: 2 }],
			'order 3, free': [1, { order: 3 }],
			'order 9': [1, { order: 9 }],
			'order -1': [1, { order: -1 }],
			'order 0 of a project rule, taken': [4, { order: 0 }],
			'order 1 of the last project rule, its own': [4, { order: 1 }],
			'the projectIds of a project rule': [3, { projectIds: [beta.id, gamma.id] }],
			'empty projectIds of a project rule': [3, { projectIds: [] }],
			'an unknown project': [3, { projectIds: ['unknownproject1'] }],
			'the role of a project rule to a global role': [3, { role: 'global:admin' }],
			'projectIds of an instance rule': [1, { projectIds: [gamma.id] }],
			'empty projectIds of an instance rule': [1, { projectIds: [] }],
			'every field': [
				1,
				{
					expression: 'patched',
					role: 'global:auditor',
					type: 'instance',
					order: 1,
					projectIds: [],
				},
			],
			'an empty body': [1, {}],
			'only an unknown key': [1, { unknownKey: 1 }],
			'an empty expression': [1, { expression: '' }],
			'no body': [1, undefined],
			'an unknown rule': ['0000000000000099', { expression: 'patched' }],
			'keys in another order': [
				1,
				{ projectIds: [], order: 1, role: 'global:auditor', expression: 'patched' },
			],
			'the type of the last instance rule to project': [
				2,
				{ type: 'project', role: 'project:editor', projectIds: [gamma.id] },
			],
			'the type to project at order 5': [
				1,
				{ type: 'project', role: 'project:editor', projectIds: [gamma.id], order: 5 },
			],
			'the type of the last instance rule to project at order 0': [
				2,
				{ type: 'project', role: 'project:editor', projectIds: [gamma.id], order: 0 },
			],
			'an unknown rule with an empty body': ['0000000000000099', {}],
			'an unknown rule with an unknown role': ['0000000000000099', { role: 'global:none' }],
			'an unknown role and the type project': [1, { role: 'project:none', type: 'project' }],
			'the expression to its value': [1, { expression: 'instance 1' }],
			'the role to its value': [1, { role: 'global:admin' }],
			'the projectIds of a project rule to their value': [3, { projectIds: [alpha.id] }],
			'the projectIds of a project rule with a project twice': [
				3,
				{ projectIds: [beta.id, beta.id] },
			],
			'the projectIds of a project rule to a personal project': [
				3,
				{ projectIds: [memberPersonalProject.id] },
			],
		};
		for (const [name, [target, body]] of Object.entries(patches)) {
			const { instance, project } = await baseRules();
			const ids = [...instance, ...project];
			const id = typeof target === 'number' ? ids[target] : target;
			outcomes[`PATCH ${name}`] = await runCase(async () => {
				const call = testServer.authAgentFor(owner).patch(`/role-mapping-rule/${id}`);
				return await describeResponse(
					body === undefined ? await call : await call.send(body as object),
				);
			});
		}

		// Type changes that leave a gap.
		const gapCase = async (instanceCount: number, projectCount: number, target: number) => {
			await Container.get(RoleMappingRuleRepository).delete({});
			const ids: string[] = [];
			for (let index = 0; index < instanceCount; index++) {
				ids.push(
					await addRule({ expression: `gap ${index}`, role: 'global:member', type: 'instance' }),
				);
			}
			for (let index = 0; index < projectCount; index++) {
				await addRule({
					expression: `gap project ${index}`,
					role: 'project:viewer',
					type: 'project',
					projectIds: [alpha.id],
				});
			}
			return await runCase(async () => ({
				response: await describeResponse(
					await testServer
						.authAgentFor(owner)
						.patch(`/role-mapping-rule/${ids[target]}`)
						.send({ type: 'project', role: 'project:editor', projectIds: [gamma.id] }),
				),
				rules: await describeListResponse(
					await testServer.authAgentFor(owner).get('/role-mapping-rule?take=50'),
				),
			}));
		};
		outcomes['PATCH the type of the last of 3 instance rules, 1 project rule'] = await gapCase(
			3,
			1,
			2,
		);
		outcomes['PATCH the type of the first of 3 instance rules, no project rules'] = await gapCase(
			3,
			0,
			0,
		);
		outcomes['PATCH the type of the middle of 3 instance rules, 1 project rule'] = await gapCase(
			3,
			1,
			1,
		);

		// Moving a rule.
		const moves: Record<string, [number | string, unknown]> = {
			'the first to the end': [0, 2],
			'the last to the start': [2, 0],
			'to its own index': [1, 1],
			'the middle to the end': [1, 2],
			'beyond the end': [0, 99],
			'a project rule to the start': [4, 0],
			'a negative index': [0, -1],
			'a string': [0, 'x'],
			'a fraction': [0, 1.5],
			'no index': [0, undefined],
			'an unknown rule': ['0000000000000099', 0],
		};
		for (const [name, [target, targetIndex]] of Object.entries(moves)) {
			const { instance, project } = await baseRules();
			const ids = [...instance, ...project];
			const id = typeof target === 'number' ? ids[target] : target;
			outcomes[`move ${name}`] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.post(`/role-mapping-rule/${id}/move`)
							.send(targetIndex === undefined ? {} : { targetIndex }),
					),
			);
		}

		// Deleting a rule.
		const deletes: Record<string, number | string> = {
			'the first rule': 0,
			'the middle rule': 1,
			'the last rule': 2,
			'a project rule': 3,
			'an unknown rule': '0000000000000099',
		};
		for (const [name, target] of Object.entries(deletes)) {
			const { instance, project } = await baseRules();
			const ids = [...instance, ...project];
			const id = typeof target === 'number' ? ids[target] : target;
			outcomes[`DELETE ${name}`] = await runCase(
				async () =>
					await describeResponse(
						await testServer.authAgentFor(owner).delete(`/role-mapping-rule/${id}`),
					),
			);
		}
		const { instance } = await baseRules();
		await testServer.authAgentFor(owner).delete(`/role-mapping-rule/${instance[0]}`);
		outcomes['DELETE a deleted rule'] = await runCase(
			async () =>
				await describeResponse(
					await testServer.authAgentFor(owner).delete(`/role-mapping-rule/${instance[0]}`),
				),
		);
		expect(outcomes).toMatchSnapshot();
	});

	test('the public API of the rules', async () => {
		const outcomes: Record<string, unknown> = {};
		const api = () => testServer.publicApiAgentFor(owner);
		const steps: Array<[string, () => request.Test]> = [
			['list without rules', () => api().get('/role-mapping-rules')],
			[
				'create an instance rule',
				() =>
					api()
						.post('/role-mapping-rules')
						.send({ expression: 'public 0', role: 'global:admin', type: 'instance' }),
			],
			[
				'create a second instance rule at order 0',
				() =>
					api()
						.post('/role-mapping-rules')
						.send({ expression: 'public 1', role: 'global:member', type: 'instance', order: 0 }),
			],
			[
				'create a project rule',
				() =>
					api()
						.post('/role-mapping-rules')
						.send({
							expression: 'public project 0',
							role: 'project:editor',
							type: 'project',
							projectIds: [alpha.id],
						}),
			],
			[
				'create an instance rule with an unknown role',
				() =>
					api()
						.post('/role-mapping-rules')
						.send({ expression: 'public x', role: 'global:none', type: 'instance' }),
			],
			['list', () => api().get('/role-mapping-rules')],
			[
				'list the instance rules with limit 1',
				() => api().get('/role-mapping-rules?limit=1&type=instance'),
			],
			['list the project rules', () => api().get('/role-mapping-rules?type=project')],
			['list with a bad cursor', () => api().get('/role-mapping-rules?cursor=not-a-cursor')],
		];
		for (const [name, call] of steps) {
			outcomes[name] = await runCase(async () => await describeListResponse(await call()));
		}
		const rules = await Container.get(RoleMappingRuleRepository).find({
			order: { type: 'ASC', order: 'ASC' },
		});
		const [first, second] = rules.filter((rule) => rule.type === 'instance');
		const [projectRule] = rules.filter((rule) => rule.type === 'project');
		const later: Array<[string, () => request.Test]> = [
			[
				'move the second instance rule to 0',
				() => api().post(`/role-mapping-rules/${second.id}/move`).send({ targetIndex: 0 }),
			],
			[
				'patch an instance rule',
				() =>
					api()
						.patch(`/role-mapping-rules/${first.id}`)
						.send({ expression: 'public patched', role: 'global:chatUser' }),
			],
			[
				'patch the type of an instance rule',
				() => api().patch(`/role-mapping-rules/${first.id}`).send({ type: 'project' }),
			],
			[
				'patch the projects of a project rule',
				() =>
					api()
						.patch(`/role-mapping-rules/${projectRule.id}`)
						.send({ projectIds: [beta.id, gamma.id] }),
			],
			['patch with an empty body', () => api().patch(`/role-mapping-rules/${first.id}`).send({})],
			['delete an instance rule', () => api().delete(`/role-mapping-rules/${first.id}`)],
			['delete it again', () => api().delete(`/role-mapping-rules/${first.id}`)],
			['list at the end', () => api().get('/role-mapping-rules')],
		];
		for (const [name, call] of later) {
			outcomes[name] = await runCase(async () => await describeListResponse(await call()));
		}
		setSsoLicence(SSO_LICENCES['no sso licence']);
		outcomes['list without an sso licence'] = await runCase(
			async () => await describeResponse(await api().get('/role-mapping-rules')),
		);
		setSsoLicence(SSO_LICENCES['oidc and saml']);
		expect(outcomes).toMatchSnapshot();
	});

	test('deleting a custom role', async () => {
		const outcomes: Record<string, unknown> = {};
		const roles = [
			['global:audit-one', 'global'],
			['global:audit-two', 'global'],
			['project:review-one', 'project'],
			['project:review-two', 'project'],
			['global:unused', 'global'],
		] as const;
		for (const [slug, roleType] of roles) {
			await createRole({ slug, displayName: slug, roleType });
		}
		await addRule({ expression: 'audit one', role: 'global:audit-one', type: 'instance' });
		await addRule({ expression: 'audit two A', role: 'global:audit-two', type: 'instance' });
		await addRule({ expression: 'audit two B', role: 'global:audit-two', type: 'instance' });
		await addRule({
			expression: 'review one',
			role: 'project:review-one',
			type: 'project',
			projectIds: [alpha.id],
		});
		await addRule({
			expression: 'review two A',
			role: 'project:review-two',
			type: 'project',
			projectIds: [alpha.id],
		});
		await addRule({
			expression: 'review two B',
			role: 'project:review-two',
			type: 'project',
			projectIds: [beta.id],
		});
		for (const [slug] of roles) {
			outcomes[`DELETE /roles/${slug}`] = await runCase(
				async () =>
					await describeResponse(await testServer.authAgentFor(owner).delete(`/roles/${slug}`)),
			);
		}
		setSsoLicence(SSO_LICENCES['no sso licence']);
		outcomes['without an sso licence | DELETE /roles/global:audit-one'] = await runCase(
			async () =>
				await describeResponse(
					await testServer.authAgentFor(owner).delete('/roles/global:audit-one'),
				),
		);
		setSsoLicence(SSO_LICENCES['oidc and saml']);
		outcomes['the blockers of the proxy'] = await runCase(async () => {
			const proxy = Container.get(RoleDeletionCheckProxy);
			return {
				'global:audit-one': await proxy.findRoleDeletionBlockers('global:audit-one'),
				'global:audit-two': await proxy.findRoleDeletionBlockers('global:audit-two'),
				'project:review-two': await proxy.findRoleDeletionBlockers('project:review-two'),
				'global:member': await proxy.findRoleDeletionBlockers('global:member'),
				'global:none': await proxy.findRoleDeletionBlockers('global:none'),
			};
		});
		expect(outcomes).toMatchSnapshot();
	});

	test('the service', async () => {
		const outcomes: Record<string, unknown> = {};

		/** What ordinary code sees when it asks whether roles are managed. */
		const describeManaged = async () => {
			const subject = await existingPerson(GLOBAL_MEMBER_ROLE, [[alpha, 'project:viewer']]);
			const user = await Container.get(UserRepository).findOneByOrFail({ email: subject.email });
			const agent = testServer.authAgentFor(owner);
			const changeRole = await agent
				.patch(`/users/${user.id}/role`)
				.send({ newRoleName: 'global:admin' });
			const changeProjectRole = await agent
				.patch(`/projects/${alpha.id}/users/${user.id}`)
				.send({ role: 'project:editor' });
			const project = await agent.get(`/projects/${alpha.id}`);
			return {
				isInstanceRoleManaged: await service().isInstanceRoleManaged(),
				isProjectRoleManaged: await service().isProjectRoleManaged(),
				'PATCH /users/:id/role': await describeResponse(changeRole),
				'PATCH /projects/:projectId/users/:userId': await describeResponse(changeProjectRole),
				'GET /projects/:projectId rolesManaged': normalize(
					(project.body as { data?: { rolesManaged?: unknown } }).data?.rolesManaged,
				),
			};
		};
		const modes: Record<string, Record<string, unknown>> = {
			'every flag off': {},
			'the instance role from claims': { scopesProvisionInstanceRole: true },
			'the project roles from claims': { scopesProvisionProjectRoles: true },
			'both from claims': {
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: true,
			},
			'expression mapping': { scopesUseExpressionMapping: true },
		};
		const ruleSets: Record<string, Array<'instance' | 'project'>> = {
			'no rules': [],
			'an instance rule': ['instance'],
			'a project rule': ['project'],
			'both kinds of rules': ['instance', 'project'],
		};
		for (const [mode, changes] of Object.entries(modes)) {
			for (const [ruleSet, types] of Object.entries(ruleSets)) {
				await resetProvisioning();
				await setConfig(changes);
				for (const type of types) {
					await addRule(
						type === 'instance'
							? { expression: 'managed instance', role: 'global:admin', type }
							: {
									expression: 'managed project',
									role: 'project:editor',
									type,
									projectIds: [beta.id],
								},
					);
				}
				outcomes[`managed | ${mode} | ${ruleSet}`] = await runCase(describeManaged);
			}
		}
		await resetProvisioning();
		await setConfig({ scopesUseExpressionMapping: true });
		await addRule({ expression: 'managed instance', role: 'global:admin', type: 'instance' });
		setSsoLicence(SSO_LICENCES['no sso licence']);
		outcomes['managed | expression mapping | an instance rule | no sso licence'] =
			await runCase(describeManaged);
		setSsoLicence(SSO_LICENCES['oidc and saml']);

		// The config without a row, and the values of the environment.
		const describeConfigs = async () => ({
			getConfig: normalize(await service().getConfig()),
			loadConfig: normalize(await service().loadConfig()),
			GET: await getConfig(),
		});
		outcomes['the first read after the start'] = firstRead;
		await resetProvisioning();
		outcomes['no row'] = await runCase(describeConfigs);
		const globalConfig = Container.get(GlobalConfig);
		const saved = { ...globalConfig.sso.provisioning };
		Object.assign(globalConfig.sso.provisioning, {
			scopesProvisionInstanceRole: true,
			scopesProvisionProjectRoles: true,
			scopesName: 'env-scope',
			scopesInstanceRoleClaimName: 'env_role',
			scopesProjectsRolesClaimName: 'env_projects',
			scopesUseExpressionMapping: true,
		});
		try {
			outcomes['no row, environment values, before a reload'] = await runCase(describeConfigs);
			outcomes['no row, environment values, after a reload'] = await runCase(async () => {
				await service().handleReloadSsoProvisioningConfiguration();
				return await describeConfigs();
			});
			outcomes['no row, environment values, after init'] = await runCase(async () => {
				await service().init();
				return await describeConfigs();
			});
			await writeRow(JSON.stringify({ scopesProvisionInstanceRole: true }));
			outcomes['a partial row, environment values'] = await runCase(async () => ({
				loadConfig: normalize(await service().loadConfig()),
				afterReload: await (async () => {
					await service().handleReloadSsoProvisioningConfiguration();
					return normalize(await service().getConfig());
				})(),
			}));
			await writeRow('not json');
			outcomes['a row that is not JSON, environment values'] = await runCase(async () => ({
				loadConfig: normalize(await service().loadConfig()),
			}));
		} finally {
			Object.assign(globalConfig.sso.provisioning, saved);
		}
		await resetProvisioning();

		// The service methods with each kind of row.
		const full = {
			scopesProvisionInstanceRole: true,
			scopesProvisionProjectRoles: false,
			scopesName: 'stored',
			scopesInstanceRoleClaimName: 'stored_role',
			scopesProjectsRolesClaimName: 'stored_projects',
			scopesUseExpressionMapping: false,
		};
		const rows: Record<string, string> = {
			'a full row': JSON.stringify(full),
			'a partial row': JSON.stringify({ scopesProvisionInstanceRole: true }),
			'a row that is not JSON': 'not json',
		};
		for (const [name, value] of Object.entries(rows)) {
			await resetProvisioning();
			await writeRow(value);
			outcomes[`${name} | getConfig, then loadConfig`] = await runCase(async () => ({
				getConfig: normalize(await service().getConfig()),
				loadConfig: normalize(await service().loadConfig()),
				getConfigAfterLoad: normalize(await service().getConfig()),
				isInstanceRoleManaged: await service().isInstanceRoleManaged(),
			}));
			outcomes[`${name} | init`] = await runCase(async () => {
				await service().init();
				return {
					getConfig: normalize(await service().getConfig()),
					isInstanceRoleManaged: await service().isInstanceRoleManaged(),
				};
			});
		}

		// The reload command in each instance role.
		const instanceSettings = Container.get(InstanceSettings);
		Container.get(PubSubRegistry).init();
		for (const role of ['unset', 'leader', 'follower'] as const) {
			await resetProvisioning();
			await writeRow(JSON.stringify({ ...full, scopesName: `reloaded-${role}` }));
			instanceSettings.instanceRole = role;
			try {
				outcomes[`the reload command, instance role ${role}`] = await runCase(async () => {
					await sendReloadCommand();
					return await getConfig();
				});
			} finally {
				instanceSettings.instanceRole = 'unset';
			}
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('the start of the module', async () => {
		const outcomes: Record<string, unknown> = {};
		const entry = Container.get(ModuleMetadata).get('provisioning');
		if (!entry) throw new Error('The provisioning module is not registered');
		const moduleInstance = Container.get(entry.class) as { init: () => Promise<void> };
		const init = vi.spyOn(moduleInstance, 'init');
		const registry = Container.get(ModuleRegistry);
		const proxy = Container.get(RoleDeletionCheckProxy) as unknown as { provider: unknown };

		await createRole({
			slug: 'global:module-probe',
			displayName: 'Module probe',
			roleType: 'global',
		});
		await addRule({ expression: 'module probe', role: 'global:module-probe', type: 'instance' });
		for (const [licence, features] of Object.entries(SSO_LICENCES)) {
			for (const instanceType of ['main', 'worker', 'webhook'] as const) {
				setSsoLicence(features);
				await writeRow(JSON.stringify({ ...OFF_ROW, scopesName: `${licence} ${instanceType}` }));
				init.mockClear();
				proxy.provider = null;
				outcomes[`${licence} | ${instanceType}`] = await runCase(async () => {
					await registry.initModules(instanceType, ['provisioning']);
					setSsoLicence(SSO_LICENCES['oidc and saml']);
					return {
						initCalls: init.mock.calls.length,
						settings: normalize(registry.settings.get('provisioning')),
						context: normalize(registry.context.get('provisioning')),
						blockers:
							await Container.get(RoleDeletionCheckProxy).findRoleDeletionBlockers(
								'global:module-probe',
							),
						config: normalize(await service().getConfig()),
					};
				});
			}
		}
		setSsoLicence(SSO_LICENCES['oidc and saml']);
		expect(outcomes).toMatchSnapshot();
	});

	test('signing in with OIDC', async () => {
		const outcomes: Record<string, unknown> = {};
		await enableOidcLogin();

		// The scope of the authorization request.
		const scopeModes: Record<string, Record<string, unknown>> = {
			'every flag off': {},
			'the instance role from claims': { scopesProvisionInstanceRole: true },
			'the project roles from claims': { scopesProvisionProjectRoles: true },
			'both from claims': {
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: true,
			},
			'expression mapping': { scopesUseExpressionMapping: true },
			'the instance role from claims, scope groups': {
				scopesProvisionInstanceRole: true,
				scopesName: 'groups',
			},
			'the instance role from claims, an empty scope': {
				scopesProvisionInstanceRole: true,
				scopesName: '',
			},
			'every flag off, scope groups': { scopesName: 'groups' },
		};
		for (const [name, changes] of Object.entries(scopeModes)) {
			await setConfig(changes);
			outcomes[`the scope | ${name}`] = await runCase(async () => {
				const login = await request(testServer.app).get('/rest/sso/oidc/login');
				const location = String(login.headers.location ?? '');
				return location.startsWith('https://')
					? new URL(location).searchParams.get('scope')
					: await describeResponse(login);
			});
		}

		// The scope with the extra scopes of the OIDC config, and the scope of the connection test.
		const scopeOf = (location: string) =>
			location.startsWith('https://') ? new URL(location).searchParams.get('scope') : location;
		await setConfig({ scopesProvisionInstanceRole: true });
		await testServer.authAgentFor(owner).post('/sso/oidc/config').send({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			discoveryEndpoint: DISCOVERY_ENDPOINT,
			loginEnabled: true,
			additionalScopes: ' groups offline_access ',
		});
		outcomes['the scope | the instance role from claims, extra scopes'] = await runCase(async () =>
			scopeOf(String((await request(testServer.app).get('/rest/sso/oidc/login')).headers.location)),
		);
		await enableOidcLogin();
		outcomes['the scope | the instance role from claims, the connection test'] = await runCase(
			async () => {
				const response = await testServer.authAgentFor(owner).post('/sso/oidc/config/test');
				return scopeOf(String((response.body as { data?: { url?: string } }).data?.url));
			},
		);
		await setConfig({ scopesUseExpressionMapping: true, scopesName: 'groups' });
		outcomes['the scope | expression mapping, scope groups, the connection test'] = await runCase(
			async () => {
				const response = await testServer.authAgentFor(owner).post('/sso/oidc/config/test');
				return scopeOf(String((response.body as { data?: { url?: string } }).data?.url));
			},
		);

		// Provisioning off.
		await setConfig({});
		outcomes['off | a member with role claims'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[alpha, 'project:viewer']]),
			{ n8n_instance_role: 'global:admin', n8n_projects: [`${beta.id}:editor`] },
		);

		// The instance role from claims.
		await setConfig({ scopesProvisionInstanceRole: true });
		const instanceClaims: unknown[] = [
			'global:admin',
			'global:member',
			'global:chatUser',
			'global:owner',
			'global:auditor',
			'project:odd-global',
			'global:odd-project',
			'project:editor',
			'block:access',
			'admin',
			'GLOBAL:ADMIN',
			'',
			'global:none',
			5,
			true,
			null,
			['global:admin'],
			{ slug: 'global:admin' },
			MISSING,
		];
		for (const value of instanceClaims) {
			outcomes[`instance claim | a member | ${describeValue(value)}`] = await signInCase(
				await existingPerson(),
				claim('n8n_instance_role', value),
			);
			outcomes[`instance claim | a new user | ${describeValue(value)}`] = await signInCase(
				newPerson(),
				claim('n8n_instance_role', value),
			);
		}
		outcomes['instance claim | an admin | missing'] = await signInCase(
			await existingPerson(GLOBAL_ADMIN_ROLE),
			{},
		);
		outcomes['instance claim | an admin | global:member'] = await signInCase(
			await existingPerson(GLOBAL_ADMIN_ROLE),
			{ n8n_instance_role: 'global:member' },
		);
		outcomes['instance claim | the owner | global:member'] = await signInCase(
			fixturePerson(owner),
			{ n8n_instance_role: 'global:member' },
		);
		outcomes['instance claim | the owner | missing'] = await signInCase(fixturePerson(owner), {});
		outcomes['instance claim | a member | only in userinfo'] = await signInCase(
			await existingPerson(),
			{},
			{ n8n_instance_role: 'global:admin' },
		);
		outcomes['instance claim | a member | only in the id token'] = await signInCase(
			await existingPerson(),
			{ n8n_instance_role: 'global:admin' },
			{},
		);
		outcomes['instance claim | a member | id token admin, userinfo chatUser'] = await signInCase(
			await existingPerson(),
			{ n8n_instance_role: 'global:admin' },
			{ n8n_instance_role: 'global:chatUser' },
		);
		outcomes['instance claim | a member with projects | global:admin'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[alpha, 'project:viewer']]),
			{ n8n_instance_role: 'global:admin', n8n_projects: [`${beta.id}:editor`] },
		);
		await setConfig({ scopesProvisionInstanceRole: true, scopesInstanceRoleClaimName: 'role' });
		outcomes['instance claim named role | a member | role global:admin'] = await signInCase(
			await existingPerson(),
			{ role: 'global:admin' },
		);
		outcomes['instance claim named role | a member | n8n_instance_role global:admin'] =
			await signInCase(await existingPerson(), { n8n_instance_role: 'global:admin' });
		for (const defaultRole of ['global:admin', 'global:chatUser', 'block:access']) {
			await setConfig({ scopesProvisionInstanceRole: true, defaultInstanceRole: defaultRole });
			for (const value of ['global:member', 'global:none', MISSING]) {
				outcomes[`instance claim, default ${defaultRole} | a member | ${describeValue(value)}`] =
					await signInCase(await existingPerson(), claim('n8n_instance_role', value));
			}
			outcomes[`instance claim, default ${defaultRole} | a new user | missing`] = await signInCase(
				newPerson(),
				{},
			);
			outcomes[`instance claim, default ${defaultRole} | the owner | missing`] = await signInCase(
				fixturePerson(owner),
				{},
			);
		}

		// The order of the checks: a blocked sign-in with an email that does not pass.
		outcomes['instance claim, default block:access | a member | an unverified email'] =
			await signInCase(await existingPerson(), { email_verified: false });
		outcomes['instance claim, default block:access | a new user | an invalid email'] =
			await signInCase(newPerson(), { email: 'not-an-email' });

		// The project roles from claims.
		await setConfig({ scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true });
		const projectClaims: Record<string, unknown> = {
			'alpha editor': [`${alpha.id}:editor`],
			'alpha viewer and beta admin': [`${alpha.id}:viewer`, `${beta.id}:admin`],
			'alpha chatUser': [`${alpha.id}:chatUser`],
			'alpha personalOwner': [`${alpha.id}:personalOwner`],
			'alpha project:editor': [`${alpha.id}:project:editor`],
			'alpha Editor': [`${alpha.id}:Editor`],
			'alpha reviewer': [`${alpha.id}:reviewer`],
			'alpha odd-global, a global role with a project prefix': [`${alpha.id}:odd-global`],
			'alpha without a role': [alpha.id],
			'alpha with an empty role': [`${alpha.id}:`],
			'an empty project id': [':editor'],
			'an unknown project': ['unknownproject1:editor'],
			'a personal project': [`${memberPersonalProject.id}:editor`],
			'alpha twice': [`${alpha.id}:viewer`, `${alpha.id}:editor`],
			'gamma admin, as the person has': [`${gamma.id}:admin`],
			'an empty list': [],
			'a string': `${alpha.id}:editor`,
			'a number in the list': [5],
			null: null,
			missing: MISSING,
		};
		for (const [name, value] of Object.entries(projectClaims)) {
			outcomes[`project claim | a member in beta and gamma | ${name}`] = await signInCase(
				await existingPerson(GLOBAL_MEMBER_ROLE, [
					[beta, 'project:viewer'],
					[gamma, 'project:admin'],
				]),
				{ n8n_instance_role: 'global:member', ...claim('n8n_projects', value) },
			);
		}
		outcomes['project claim | a new user | alpha editor'] = await signInCase(newPerson(), {
			n8n_instance_role: 'global:member',
			n8n_projects: [`${alpha.id}:editor`],
		});
		outcomes['project claim | the owner | alpha editor'] = await signInCase(fixturePerson(owner), {
			n8n_projects: [`${alpha.id}:editor`],
		});
		outcomes['project claim | a member | only in userinfo'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[beta, 'project:viewer']]),
			{ n8n_instance_role: 'global:member' },
			{ n8n_instance_role: 'global:member', n8n_projects: [`${alpha.id}:editor`] },
		);
		await setConfig({ scopesProvisionProjectRoles: true });
		outcomes['project claim only | a member in beta | alpha editor and an admin role'] =
			await signInCase(await existingPerson(GLOBAL_MEMBER_ROLE, [[beta, 'project:viewer']]), {
				n8n_instance_role: 'global:admin',
				n8n_projects: [`${alpha.id}:editor`],
			});
		await setConfig({
			scopesProvisionInstanceRole: true,
			scopesProvisionProjectRoles: true,
			scopesProjectsRolesClaimName: 'projects',
		});
		outcomes['project claim named projects | a member in beta | alpha editor'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[beta, 'project:viewer']]),
			{ projects: [`${alpha.id}:editor`] },
		);

		// Expression mapping without rules.
		await setConfig({ scopesUseExpressionMapping: true });
		outcomes['expressions without rules | an admin in alpha'] = await signInCase(
			await existingPerson(GLOBAL_ADMIN_ROLE, [[alpha, 'project:viewer']]),
			{ groups: ['admins'] },
		);
		outcomes['expressions without rules | a new user'] = await signInCase(newPerson(), {});

		// Instance rules.
		await addRule({
			expression: "{{ $claims.groups.includes('admins') }}",
			role: 'global:admin',
			type: 'instance',
		});
		await addRule({
			expression: "{{ $claims.department === 'support' }}",
			role: 'global:chatUser',
			type: 'instance',
		});
		const instanceCases: Record<string, Record<string, unknown>> = {
			'the first rule': { groups: ['admins'] },
			'the second rule': { groups: [], department: 'support' },
			'both rules': { groups: ['admins'], department: 'support' },
			'no rule': { groups: ['devs'] },
			'no groups claim': { department: 'sales' },
		};
		for (const [name, claims] of Object.entries(instanceCases)) {
			outcomes[`instance rules | a member in alpha | ${name}`] = await signInCase(
				await existingPerson(GLOBAL_MEMBER_ROLE, [[alpha, 'project:viewer']]),
				claims,
			);
			outcomes[`instance rules | a new user | ${name}`] = await signInCase(newPerson(), claims);
		}
		outcomes['instance rules | an admin | no rule'] = await signInCase(
			await existingPerson(GLOBAL_ADMIN_ROLE),
			{ groups: ['devs'] },
		);
		outcomes['instance rules | a chat user | the first rule'] = await signInCase(
			await existingPerson(GLOBAL_CHAT_USER_ROLE),
			{ groups: ['admins'] },
		);
		outcomes['instance rules | the owner | the second rule'] = await signInCase(
			fixturePerson(owner),
			{ groups: [], department: 'support' },
		);
		for (const defaultRole of ['global:admin', 'global:member', 'block:access']) {
			await setConfig({ scopesUseExpressionMapping: true, defaultInstanceRole: defaultRole });
			outcomes[`instance rules, default ${defaultRole} | a member | no rule`] = await signInCase(
				await existingPerson(GLOBAL_MEMBER_ROLE, [[alpha, 'project:viewer']]),
				{ groups: ['devs'] },
			);
			outcomes[`instance rules, default ${defaultRole} | a member | the second rule`] =
				await signInCase(await existingPerson(), { groups: [], department: 'support' });
			outcomes[`instance rules, default ${defaultRole} | a new user | no rule`] = await signInCase(
				newPerson(),
				{ groups: ['devs'] },
			);
			outcomes[`instance rules, default ${defaultRole} | the owner | no rule`] = await signInCase(
				fixturePerson(owner),
				{ groups: ['devs'] },
			);
		}

		// A rule with the role block:access, when the API accepts it.
		await resetProvisioning();
		await setConfig({ scopesUseExpressionMapping: true });
		const blockRule = await testServer.authAgentFor(owner).post('/role-mapping-rule').send({
			expression: '{{ $claims.blocked === true }}',
			role: 'block:access',
			type: 'instance',
		});
		await labelNewRules();
		outcomes['a block rule | its creation'] = normalize(blockRule.body);
		if (blockRule.status === 200) {
			outcomes['a block rule | a member | blocked'] = await signInCase(await existingPerson(), {
				blocked: true,
			});
			outcomes['a block rule | a new user | blocked'] = await signInCase(newPerson(), {
				blocked: true,
			});
			outcomes['a block rule | a member | not blocked'] = await signInCase(await existingPerson(), {
				blocked: false,
			});
		}

		// Project rules.
		await resetProvisioning();
		await setConfig({ scopesUseExpressionMapping: true });
		await addRule({
			expression: "{{ $claims.team === 'alpha' }}",
			role: 'project:editor',
			type: 'project',
			projectIds: [alpha.id],
		});
		await addRule({
			expression: '{{ $claims.team !== undefined }}',
			role: 'project:viewer',
			type: 'project',
			projectIds: [alpha.id, beta.id],
		});
		const projectCases: Record<string, Record<string, unknown>> = {
			'team alpha': { team: 'alpha' },
			'team other': { team: 'other' },
			'no team': {},
		};
		for (const [name, claims] of Object.entries(projectCases)) {
			outcomes[`project rules | an admin in beta and gamma | ${name}`] = await signInCase(
				await existingPerson(GLOBAL_ADMIN_ROLE, [
					[beta, 'project:admin'],
					[gamma, 'project:editor'],
				]),
				claims,
			);
			outcomes[`project rules | a new user | ${name}`] = await signInCase(newPerson(), claims);
		}
		outcomes['project rules | the owner | team alpha'] = await signInCase(fixturePerson(owner), {
			team: 'alpha',
		});
		await addRule({
			expression: "{{ $claims.team === 'alpha' }}",
			role: 'global:admin',
			type: 'instance',
		});
		outcomes['project and instance rules | a member in gamma | team alpha'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[gamma, 'project:editor']]),
			{ team: 'alpha' },
		);
		outcomes['project and instance rules | a member in gamma | team other'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[gamma, 'project:editor']]),
			{ team: 'other' },
		);
		await setConfig({ scopesUseExpressionMapping: true, defaultInstanceRole: 'block:access' });
		outcomes['project rules, default block:access | a member in gamma | team other'] =
			await signInCase(await existingPerson(GLOBAL_MEMBER_ROLE, [[gamma, 'project:editor']]), {
				team: 'other',
			});

		// How a rule expression evaluates. The rule makes an admin. The id token and the userinfo
		// response have different claims.
		await resetProvisioning();
		await setConfig({ scopesUseExpressionMapping: true });
		const prober = await existingPerson();
		const proberUser = await Container.get(UserRepository).findOneByOrFail({
			email: prober.email,
		});
		const idTokenClaims = {
			a: 'id',
			b: 'only-id',
			n: 5,
			groups: ['admins', 'devs'],
			nested: { level: { value: 'deep' } },
		};
		const userInfoClaims = { a: 'ui', c: 'only-ui' };
		const probes = [
			'true',
			'false',
			'yes',
			'1',
			'0',
			'claims.group === "admins"',
			'{{ true }}',
			'{{ false }}',
			'{{ 1 }}',
			'{{ 0 }}',
			"{{ 'yes' }}",
			"{{ '' }}",
			"{{ 'true' }}",
			"{{ 'false' }}",
			'{{ null }}',
			'{{ undefined }}',
			'{{ [] }}',
			'{{ {} }}',
			'  {{ true }}  ',
			'{{ true }} trailing',
			'leading {{ true }}',
			'{{true}}',
			'={{ true }}',
			'{{ true }}{{ false }}',
			'{{ false }}{{ true }}',
			'{{ ) }}',
			'{{ $claims.missing.deep }}',
			'{{ notDefined }}',
			"{{ $claims.a === 'ui' }}",
			"{{ $claims.a === 'id' }}",
			"{{ $claims.b === 'only-id' }}",
			"{{ $claims.c === 'only-ui' }}",
			'{{ $claims.n === 5 }}',
			"{{ $claims.nested.level.value === 'deep' }}",
			`{{ $claims.sub === '${prober.subject}' }}`,
			`{{ $claims.email === '${prober.email}' }}`,
			'{{ $claims.email_verified === true }}',
			`{{ $claims.iss === '${ISSUER}' }}`,
			`{{ $claims.aud === '${CLIENT_ID}' }}`,
			"{{ typeof $claims.exp === 'number' }}",
			"{{ typeof $claims.iat === 'number' }}",
			"{{ typeof $claims.nonce === 'string' }}",
			"{{ $claims.groups.includes('admins') }}",
			'{{ $claims.groups.length === 2 }}',
			'{{ Array.isArray($claims.groups) }}',
			'{{ $oidc !== undefined }}',
			"{{ $oidc.idToken.a === 'id' }}",
			"{{ $oidc.userInfo.a === 'ui' }}",
			'{{ $oidc.idToken.c === undefined }}',
			'{{ $oidc.userInfo.b === undefined }}',
			`{{ $oidc.idToken.iss === '${ISSUER}' }}`,
			`{{ $oidc.userInfo.sub === '${prober.subject}' }}`,
			"{{ typeof $oidc.idToken.exp === 'number' }}",
			'{{ Object.keys($oidc).length === 2 }}',
			"{{ $provider === 'oidc' }}",
			'{{ $saml === undefined }}',
			"{{ typeof $saml === 'object' }}",
			'{{ $json === undefined }}',
			'{{ $now !== undefined }}',
			"{{ typeof DateTime !== 'undefined' }}",
			'{{ Math.max(1, 2) === 2 }}',
			"{{ 'a@b.co'.isEmail() }}",
			"{{ typeof process === 'undefined' }}",
			"{{ typeof require === 'undefined' }}",
			'{{ (() => true)() }}',
			"{{ JSON.stringify([1]) === '[1]' }}",
			"{{ $claims.constructor.constructor('return true')() }}",
			'{{ this.process === undefined }}',
			"{{ $claims.a = 'changed' }}",
		];
		for (const expression of probes) {
			await Container.get(RoleMappingRuleRepository).delete({});
			const creation = await testServer
				.authAgentFor(owner)
				.post('/role-mapping-rule')
				.send({ expression, role: 'global:admin', type: 'instance' });
			await labelNewRules();
			if (creation.status !== 200) {
				outcomes[`expression | ${expression}`] = { creation: await describeResponse(creation) };
				continue;
			}
			await Container.get(UserRepository).update(proberUser.id, {
				role: { slug: GLOBAL_MEMBER_ROLE.slug },
			});
			outcomes[`expression | ${expression}`] = await signInCase(
				prober,
				idTokenClaims,
				userInfoClaims,
			);
		}

		// Two rules: the first changes a claim, the second reads it.
		await Container.get(RoleMappingRuleRepository).delete({});
		await addRule({
			expression: "{{ ($claims.a = 'changed') && false }}",
			role: 'global:chatUser',
			type: 'instance',
		});
		await addRule({
			expression: "{{ $claims.a === 'changed' }}",
			role: 'global:admin',
			type: 'instance',
		});
		await Container.get(UserRepository).update(proberUser.id, {
			role: { slug: GLOBAL_MEMBER_ROLE.slug },
		});
		outcomes['expression | a rule changes a claim that a later rule reads'] = await signInCase(
			prober,
			idTokenClaims,
			userInfoClaims,
		);
		await Container.get(RoleMappingRuleRepository).delete({});
		await addRule({
			expression: "{{ $oidc.idToken.a === 'changed' }}",
			role: 'global:admin',
			type: 'instance',
		});
		await addRule({
			expression: "{{ ($oidc.idToken.a = 'changed') && false }}",
			role: 'global:chatUser',
			type: 'instance',
			order: 0,
		});
		await Container.get(UserRepository).update(proberUser.id, {
			role: { slug: GLOBAL_MEMBER_ROLE.slug },
		});
		outcomes['expression | a rule changes $oidc that a later rule reads'] = await signInCase(
			prober,
			idTokenClaims,
			userInfoClaims,
		);

		// What the rules share: two rules, the first changes a value, the second reads it.
		const pairs: Record<string, [string, string]> = {
			'$claims.b, then $oidc.idToken.b': [
				"{{ ($claims.b = 'changed') && false }}",
				"{{ $oidc.idToken.b === 'changed' }}",
			],
			'$oidc.userInfo.c, then $claims.c': [
				"{{ ($oidc.userInfo.c = 'changed') && false }}",
				"{{ $claims.c === 'changed' }}",
			],
			'$claims.nested, then $oidc.idToken.nested': [
				"{{ ($claims.nested.level.value = 'changed') && false }}",
				"{{ $oidc.idToken.nested.level.value === 'changed' }}",
			],
			'$claims.groups, then $oidc.idToken.groups': [
				"{{ $claims.groups.push('pushed') && false }}",
				'{{ $oidc.idToken.groups.length === 3 }}',
			],
		};
		for (const [name, [first, second]] of Object.entries(pairs)) {
			await Container.get(RoleMappingRuleRepository).delete({});
			await addRule({ expression: first, role: 'global:chatUser', type: 'instance' });
			await addRule({ expression: second, role: 'global:admin', type: 'instance' });
			await Container.get(UserRepository).update(proberUser.id, {
				role: { slug: GLOBAL_MEMBER_ROLE.slug },
			});
			outcomes[`expression pair | ${name}`] = await signInCase(
				prober,
				idTokenClaims,
				userInfoClaims,
			);
		}
		const keyProbes = [
			"{{ (() => { const keys = []; for (const key in $oidc) keys.push(key); return keys.join(',') === 'idToken,userInfo'; })() }}",
			'{{ (() => { let count = 0; for (const key in $oidc.userInfo) count++; return count === 5; })() }}',
			'{{ (() => { let count = 0; for (const key in $claims) count++; return count === 14; })() }}',
			'{{ $claims !== $oidc.idToken && $claims !== $oidc.userInfo }}',
		];
		for (const expression of keyProbes) {
			await Container.get(RoleMappingRuleRepository).delete({});
			await addRule({ expression, role: 'global:admin', type: 'instance' });
			await Container.get(UserRepository).update(proberUser.id, {
				role: { slug: GLOBAL_MEMBER_ROLE.slug },
			});
			outcomes[`expression | ${expression}`] = await signInCase(
				prober,
				idTokenClaims,
				userInfoClaims,
			);
		}
		// A rule changes the values that the sign-in uses afterwards.
		const liveProbes: Record<string, string> = {
			'the email of userinfo':
				"{{ ($oidc.userInfo.email = 'changed-by-a-rule@example.com') && false }}",
			'the subject of the id token': "{{ ($oidc.idToken.sub = 'changed-by-a-rule-sub') && false }}",
			'the names of userinfo': "{{ ($oidc.userInfo.given_name = 'Changed') && false }}",
		};
		for (const [name, expression] of Object.entries(liveProbes)) {
			await Container.get(RoleMappingRuleRepository).delete({});
			await addRule({ expression, role: 'global:admin', type: 'instance' });
			outcomes[`a rule changes ${name} | a new user`] = await signInCase(newPerson(), {
				given_name: 'Original',
			});
		}

		// An instance rule changes a claim that a project rule reads.
		await Container.get(RoleMappingRuleRepository).delete({});
		await addRule({
			expression: "{{ ($claims.team = 'alpha') && false }}",
			role: 'global:chatUser',
			type: 'instance',
		});
		await addRule({
			expression: "{{ $claims.team === 'alpha' }}",
			role: 'project:editor',
			type: 'project',
			projectIds: [alpha.id],
		});
		outcomes['expression | an instance rule changes a claim that a project rule reads'] =
			await signInCase(await existingPerson(), {});

		// The instance rules after the first match.
		await Container.get(RoleMappingRuleRepository).delete({});
		await addRule({ expression: '{{ true }}', role: 'global:admin', type: 'instance' });
		await addRule({
			expression: "{{ ($claims.team = 'alpha') && false }}",
			role: 'global:chatUser',
			type: 'instance',
		});
		await addRule({
			expression: "{{ $claims.team === 'alpha' }}",
			role: 'project:editor',
			type: 'project',
			projectIds: [alpha.id],
		});
		outcomes['expression | the instance rules after the first match'] = await signInCase(
			await existingPerson(),
			{},
		);

		// Expression mapping: a default role without instance rules.
		await resetProvisioning();
		await setConfig({ scopesUseExpressionMapping: true, defaultInstanceRole: 'global:admin' });
		outcomes['expressions without rules, default global:admin | a member'] = await signInCase(
			await existingPerson(),
			{},
		);
		await setConfig({ scopesUseExpressionMapping: true, defaultInstanceRole: 'block:access' });
		outcomes['expressions without rules, default block:access | a member'] = await signInCase(
			await existingPerson(),
			{},
		);
		outcomes['expressions without rules, default block:access | a new user'] = await signInCase(
			newPerson(),
			{},
		);
		await addRule({
			expression: '{{ true }}',
			role: 'project:viewer',
			type: 'project',
			projectIds: [alpha.id],
		});
		outcomes['project rules only, default block:access | a member in beta'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[beta, 'project:editor']]),
			{},
		);
		await setConfig({ scopesUseExpressionMapping: true });
		outcomes['project rules only | a member in alpha as an editor'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[alpha, 'project:editor']]),
			{},
		);
		outcomes['project rules only | a member in alpha as a viewer'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[alpha, 'project:viewer']]),
			{},
		);

		// Claims: chat users, the only admin of a project, and a custom role without its licence.
		await resetProvisioning();
		await setConfig({ scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true });
		outcomes['claims | a member in beta | chatUser and alpha editor'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[beta, 'project:viewer']]),
			{ n8n_instance_role: 'global:chatUser', n8n_projects: [`${alpha.id}:editor`] },
		);
		outcomes['claims | a chat user | chatUser and alpha editor'] = await signInCase(
			await existingPerson(GLOBAL_CHAT_USER_ROLE),
			{ n8n_instance_role: 'global:chatUser', n8n_projects: [`${alpha.id}:editor`] },
		);
		outcomes['claims | a chat user | member and alpha editor'] = await signInCase(
			await existingPerson(GLOBAL_CHAT_USER_ROLE),
			{ n8n_instance_role: 'global:member', n8n_projects: [`${alpha.id}:editor`] },
		);
		const delta = await createFixtureProject('delta');
		outcomes['claims | the only admin of delta | chatUser and delta admin'] = await signInCase(
			await existingPerson(GLOBAL_MEMBER_ROLE, [[delta, 'project:admin']]),
			{ n8n_instance_role: 'global:chatUser', n8n_projects: [`${delta.id}:admin`] },
		);
		testServer.license.disable('feat:projectRole:editor');
		outcomes['claims, no project editor licence | a member | alpha editor'] = await signInCase(
			await existingPerson(),
			{ n8n_instance_role: 'global:member', n8n_projects: [`${alpha.id}:editor`] },
		);
		testServer.license.enable('feat:projectRole:editor');
		testServer.license.disable('feat:customRoles');
		outcomes['claims, no custom roles licence | a member | a custom global role'] =
			await signInCase(await existingPerson(), { n8n_instance_role: 'global:auditor' });
		testServer.license.enable('feat:customRoles');

		// A project claim with entries that n8n can use and entries that it cannot use.
		const mixedProjectClaims: Record<string, unknown[]> = {
			'alpha editor, then nonsense': [`${alpha.id}:editor`, 'nonsense'],
			'nonsense, then alpha editor': ['nonsense', `${alpha.id}:editor`],
			'alpha editor, then an unknown project': [`${alpha.id}:editor`, 'unknownproject1:editor'],
			'alpha editor, then a personal project': [
				`${alpha.id}:editor`,
				`${memberPersonalProject.id}:editor`,
			],
			'alpha editor, then a number': [`${alpha.id}:editor`, 5],
			'an unknown project, then nonsense': ['unknownproject1:editor', 'nonsense'],
		};
		for (const [name, value] of Object.entries(mixedProjectClaims)) {
			outcomes[`project claim | a member in beta and gamma | ${name}`] = await signInCase(
				await existingPerson(GLOBAL_MEMBER_ROLE, [
					[beta, 'project:viewer'],
					[gamma, 'project:admin'],
				]),
				{ n8n_instance_role: 'global:member', n8n_projects: value },
			);
		}
		expect(outcomes).toMatchSnapshot();
	});
});
