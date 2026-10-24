// The behaviour of the SAML sign-in: the metadata of n8n as a service provider, the config
// endpoints, the signing keys, the login, the connection test, the assertion consumer service (ACS)
// with the role provisioning, and the service methods that ordinary code calls. A fake identity
// provider (samlify, with the signing fixtures) makes the login responses. For each case, the
// snapshot records the response, the cookies, the events, the pub/sub commands, the sign-in state,
// and the rows that the case changed. The snapshot records what n8n does, so a change in behaviour
// shows up as a snapshot diff.
// packages/cli/src/modules/sso-saml/FORK.md tells how the fork made the snapshot.
//
// The ACS renders handlebars templates from the disk.
vi.unmock('node:fs');

import type { SamlPreferences } from '@n8n/api-types';
import { EventService, JwtService } from '@n8n/backend-services';
import { mockInstance, testDb } from '@n8n/backend-test-utils';
import { GlobalConfig, InstanceSettingsLoaderConfig } from '@n8n/config';
import { createTeamProject } from '@n8n/backend-test-utils';
import {
	AuthIdentity,
	AuthIdentityRepository,
	GLOBAL_ADMIN_ROLE,
	GLOBAL_CHAT_USER_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRelationRepository,
	ProjectRepository,
	RoleMappingRuleRepository,
	RoleRepository,
	SettingsRepository,
	UserRepository,
	type Project,
	type User,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { Cipher, InstanceSettings } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';
import { generateKeyPairSync } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import * as samlify from 'samlify';
import request from 'supertest';
import type { MockInstance } from 'vitest';

import config from '@/config';
import { TEMPLATES_DIR } from '@/constants';
import {
	EC_TEST_CERTIFICATE,
	EC_TEST_PRIVATE_KEY,
	RSA_MISMATCHED_CERTIFICATE,
	RSA_TEST_CERTIFICATE,
	RSA_TEST_PRIVATE_KEY,
} from '@/modules/sso-saml/__tests__/saml-signing-test-fixtures';
import { startServer } from '@n8n/backend-network/testing';
import { SAML_PREFERENCES_DB_KEY } from '@/modules/sso-saml/constants';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import { PubSubEventBus } from '@/scaling/pubsub/pubsub.eventbus';
import { PubSubRegistry } from '@/scaling/pubsub/pubsub.registry';
import { setCurrentAuthenticationMethod } from '@/sso/sso-helpers';
import { createHandlebarsEngine } from '@/utils/handlebars.util';

import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import { setupTestServer } from '@test-integration/utils';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at `@/modules/provisioning.ee/provisioning.service.ee`,
// `@/modules/sso-saml/saml.service.ee` and `@/modules/sso-saml/saml.controller.ee`.
import { PROVISIONING_PREFERENCES_DB_KEY } from '@/modules/provisioning/constants';
import { ProvisioningService } from '@/modules/provisioning/provisioning.service';
import { SamlService } from '@/modules/sso-saml/saml.service';
import '@/modules/sso-saml/saml.controller';

/** The pub/sub commands that n8n sends. The mock keeps them instead of sending them. */
const published: unknown[] = [];
mockInstance(Publisher).publishCommand.mockImplementation(async (message) => {
	published.push(message);
});

const testServer = setupTestServer({ endpointGroups: ['auth'], enabledFeatures: ['feat:saml'] });
const recorder = new GoldenRecorder();
const { label, labelString, normalize, describeError, dumpDb, diffDumps } = recorder;

// ----------------------------------------------------------------------------------------------
// The fake identity provider
// ----------------------------------------------------------------------------------------------

// The fake IdP only makes messages. It sets no schema validator: samlify is shared with the code
// under test.

const { binding, format } = samlify.Constants.namespace;

const IDP_ENTITY_ID = 'https://idp.example.test/metadata';
const IDP_SSO_URL = 'https://idp.example.test/sso';
const BASE_URL = 'http://localhost:5678';
const SP_ENTITY_ID = `${BASE_URL}/rest/sso/saml/metadata`;
const ACS_URL = `${BASE_URL}/rest/sso/saml/acs`;

const claim = (name: string) => `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/${name}`;

/** The attribute names of the public n8n documentation. */
const DEFAULT_MAPPING = {
	email: claim('emailaddress'),
	firstName: claim('firstname'),
	lastName: claim('lastname'),
	userPrincipalName: claim('upn'),
};

type IdpSettings = {
	/** The SSO bindings in the metadata of the IdP. */
	ssoBindings: Array<'redirect' | 'post'>;
	/**
	 * The key that signs the response: the key of the metadata, or another key. The signature
	 * carries the certificate of the metadata, except with 'other key and certificate'.
	 */
	signingKey: 'idp key' | 'other key' | 'other key and certificate';
	signMessage: boolean;
	signAssertion: boolean;
	status: string;
	issuer: string;
	audience: string;
	destination: string;
	recipient: string;
	/** The ID of the request that the response answers. Without it, the IdP started the sign-in. */
	inResponseTo?: string;
	/** Seconds from now. */
	notBefore: number;
	notOnOrAfter: number;
	nameId: string;
	attributes: Record<string, string | string[]>;
	/** `WantAuthnRequestsSigned` in the metadata of the IdP. */
	wantAuthnRequestsSigned: boolean;
};

function defaultIdpSettings(): IdpSettings {
	return {
		ssoBindings: ['redirect', 'post'],
		signingKey: 'idp key',
		signMessage: true,
		signAssertion: true,
		status: 'urn:oasis:names:tc:SAML:2.0:status:Success',
		issuer: IDP_ENTITY_ID,
		audience: SP_ENTITY_ID,
		destination: ACS_URL,
		recipient: ACS_URL,
		notBefore: -60,
		notOnOrAfter: 300,
		nameId: 'alice@example.com',
		attributes: {
			[claim('emailaddress')]: 'alice@example.com',
			[claim('firstname')]: 'Alice',
			[claim('lastname')]: 'Example',
			[claim('upn')]: 'alice-upn',
		},
		wantAuthnRequestsSigned: false,
	};
}

/** A key that the metadata does not know. */
const OTHER_PRIVATE_KEY = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

function makeIdp(settings: IdpSettings) {
	return samlify.IdentityProvider({
		entityID: IDP_ENTITY_ID,
		privateKey: settings.signingKey === 'idp key' ? RSA_TEST_PRIVATE_KEY : OTHER_PRIVATE_KEY,
		signingCert:
			settings.signingKey === 'other key and certificate'
				? RSA_MISMATCHED_CERTIFICATE
				: RSA_TEST_CERTIFICATE,
		isAssertionEncrypted: false,
		wantAuthnRequestsSigned: settings.wantAuthnRequestsSigned,
		singleSignOnService: settings.ssoBindings.map((name) => ({
			Binding: binding[name],
			Location: IDP_SSO_URL,
		})),
		loginResponseTemplate: { context: samlify.SamlLib.defaultLoginResponseTemplate.context },
	});
}

/** The metadata that n8n gets as the IdP config. It always has the certificate of the IdP key. */
function idpMetadata(settings: Partial<IdpSettings> = {}) {
	return makeIdp({ ...defaultIdpSettings(), ...settings, signingKey: 'idp key' }).getMetadata();
}

/** The base64 body of a PEM certificate, as metadata has it. */
const certificateBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

const escapeXml = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function attributeStatement(attributes: IdpSettings['attributes']) {
	const entries = Object.entries(attributes);
	if (entries.length === 0) return '';
	const items = entries.map(
		([name, value]) =>
			`<saml:Attribute Name="${escapeXml(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri">` +
			([] as string[])
				.concat(value)
				.map(
					(v) => `<saml:AttributeValue xsi:type="xs:string">${escapeXml(v)}</saml:AttributeValue>`,
				)
				.join('') +
			'</saml:Attribute>',
	);
	return `<saml:AttributeStatement>${items.join('')}</saml:AttributeStatement>`;
}

let responseCounter = 0;

/** The view of the fake IdP on n8n. It decides what samlify signs. */
function spView(settings: IdpSettings) {
	return samlify.ServiceProvider({
		entityID: SP_ENTITY_ID,
		assertionConsumerService: [
			{ Binding: binding.post, Location: ACS_URL },
			{ Binding: binding.redirect, Location: ACS_URL },
		],
		wantAssertionsSigned: settings.signAssertion,
		wantMessageSigned: settings.signMessage,
	});
}

/** The function that fills the response template of samlify with the values of the settings. */
function responseValues(settings: IdpSettings) {
	responseCounter++;
	const id = `_response${responseCounter}`;
	const now = Date.now();
	const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
	const replace = (template: string) => {
		let withAttributes = template.replace(
			'{AttributeStatement}',
			attributeStatement(settings.attributes),
		);
		if (settings.inResponseTo === undefined) {
			withAttributes = withAttributes.replace(/ InResponseTo="\{InResponseTo\}"/g, '');
		}
		const context = samlify.SamlLib.replaceTagsByValue(withAttributes, {
			ID: id,
			AssertionID: `_assertion${responseCounter}`,
			Destination: settings.destination,
			Audience: settings.audience,
			SubjectRecipient: settings.recipient,
			Issuer: settings.issuer,
			IssueInstant: at(0),
			StatusCode: settings.status,
			ConditionsNotBefore: at(settings.notBefore),
			ConditionsNotOnOrAfter: at(settings.notOnOrAfter),
			SubjectConfirmationDataNotOnOrAfter: at(settings.notOnOrAfter),
			NameIDFormat: format.emailAddress,
			NameID: settings.nameId,
			InResponseTo: settings.inResponseTo ?? '',
			AuthnStatement: '',
		});
		return { id, context };
	};
	return replace;
}

/** A login response of the fake IdP, as the base64 value of the `SAMLResponse` form field. */
async function loginResponse(settings: IdpSettings, relayState?: string) {
	const replace = responseValues(settings);
	// samlify signs the message whenever the SP does not want signed assertions, so a response
	// without any signature is made by hand.
	if (!settings.signMessage && !settings.signAssertion) {
		const { context } = replace(samlify.SamlLib.defaultLoginResponseTemplate.context);
		return Buffer.from(context).toString('base64');
	}
	const response = await makeIdp(settings).createLoginResponse(
		spView(settings),
		null as never,
		'post',
		{},
		replace,
		false,
		relayState,
	);
	return response.context;
}

/** A login response of the redirect binding, as the query of the ACS URL. */
async function redirectLoginResponse(settings: IdpSettings, relayState?: string) {
	const response = await makeIdp(settings).createLoginResponse(
		spView(settings),
		null as never,
		'redirect',
		{},
		responseValues(settings),
		false,
		relayState,
	);
	return new URL(response.context).search;
}

/** The response of the login endpoint, with the AuthnRequest of the redirect URL. */
async function describeLogin(path = '/rest/sso/saml/initsso') {
	const response = await request(testServer.app).get(path);
	const described = await describeResponse(response);
	const data = (response.body as { data?: unknown } | undefined)?.data;
	return typeof data === 'string' && data.startsWith('https://')
		? { ...described, request: describeRedirectRequest(data) }
		: described;
}

/** The AuthnRequest of a redirect URL, with its parameters. */
function describeRedirectRequest(url: string) {
	const parsed = new URL(url);
	const encoded = parsed.searchParams.get('SAMLRequest');
	return {
		origin: parsed.origin,
		path: parsed.pathname,
		parameters: [...parsed.searchParams.keys()],
		relayState: mapStrings(parsed.searchParams.get('RelayState'), withoutRunValues),
		request: encoded
			? describeXml(inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8'))
			: null,
	};
}

// ----------------------------------------------------------------------------------------------
// Describing what a case did
// ----------------------------------------------------------------------------------------------

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

async function describeEncrypted(value: string) {
	const format = /^[A-Za-z0-9_-]{1,36}:/.test(value) ? 'key id prefix' : 'no key id';
	try {
		const plaintext = await Container.get(Cipher).decryptV2(value);
		return { encrypted: labelString(plaintext), format };
	} catch (error) {
		return { notDecryptable: describeError(error) };
	}
}

async function describeSessionToken(token: string) {
	const payload = Container.get(JwtService).decodeUnverified<Record<string, unknown> | null>(token);
	return {
		session: labelString(String(payload?.id)),
		usedMfa: payload?.usedMfa,
		browserId: payload?.browserId === undefined ? '<none>' : '<hash>',
	};
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
			value:
				value === ''
					? '<empty>'
					: name === 'n8n-auth'
						? await describeSessionToken(value)
						: labelString(value),
			attributes: attributes.map((attribute) =>
				/^Expires=/i.test(attribute) && !attribute.includes('1970') ? 'Expires=<date>' : attribute,
			),
		});
	}
	return cookies;
}

/** Values in messages that change on each run. */
const RUN_VALUES: Array<[RegExp, string]> = [
	[/the signature value \S+ is incorrect/g, 'the signature value <signature> is incorrect'],
	[/\/config\/test\/return\?t=[0-9a-f]+/g, '/config/test/return?t=<test token>'],
];

function withoutRunValues(text: string) {
	return RUN_VALUES.reduce((result, [pattern, value]) => result.replace(pattern, value), text);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
	if (typeof value === 'string') return map(value);
	if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
		);
	}
	return value;
}

/** The XML of a SAML message, with its generated values replaced. */
function describeXml(xml: string) {
	return labelString(
		xml
			.replace(/\b(ID|InResponseTo)="_[0-9a-f-]{8,}"/g, '$1="<generated id>"')
			.replace(/\b(IssueInstant|NotBefore|NotOnOrAfter)="[^"]*"/g, '$1="<time>"')
			.replace(/<(ds:)?SignatureValue>[^<]*</g, '<$1SignatureValue><signature><')
			.replace(/<(ds:)?DigestValue>[^<]*</g, '<$1DigestValue><digest><'),
	);
}

function describeHtml(html: string) {
	const withMessages = html.replace(
		/name="(SAMLRequest|SAMLResponse)" value="([^"]+)"/g,
		(_match, name: string, value: string) =>
			`name="${name}" value="<base64 of ${describeXml(Buffer.from(value, 'base64').toString('utf8'))}>"`,
	);
	return labelString(
		withoutRunValues(withMessages.replace(/nonce="[^"]*"/g, 'nonce="<csp nonce>"')),
	).split('\n');
}

function describeBody(response: request.Response): unknown {
	const contentType = String(response.headers['content-type'] ?? '');
	const text = response.text ?? '';
	if (contentType.includes('json')) {
		return mapStrings(normalize(response.body), (value) =>
			value.startsWith(IDP_SSO_URL)
				? '<a URL of the IdP, see the request>'
				: withoutRunValues(value),
		);
	}
	const location = response.headers.location as string | undefined;
	if (location !== undefined && text === `Found. Redirecting to ${location}`) {
		return '<the text of a redirect>';
	}
	if (contentType.includes('xml')) return describeXml(text);
	if (contentType.includes('html')) return describeHtml(text);
	return labelString(withoutRunValues(text));
}

async function describeResponse(response: request.Response) {
	const location = response.headers.location as string | undefined;
	const csp = response.headers['content-security-policy'] as string | undefined;
	return {
		status: response.status,
		...(location !== undefined ? { location: labelString(location) } : {}),
		cookies: await describeCookies(response),
		...(response.headers['content-type'] ? { contentType: response.headers['content-type'] } : {}),
		...(csp ? { csp: csp.replace(/'nonce-[^']*'/g, "'nonce-<csp nonce>'") } : {}),
		body: describeBody(response),
	};
}

/** The SAML row, with the signing key decrypted. */
async function describeSettingValue(key: string, value: string): Promise<unknown> {
	if (key !== SAML_PREFERENCES_DB_KEY) return labelString(value);
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return labelString(value);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return normalize(parsed);
	}
	// The order of the keys in the row has no meaning.
	const entries = [];
	for (const [entryKey, entry] of Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))) {
		entries.push([
			entryKey,
			entryKey === 'signingPrivateKey' && typeof entry === 'string' && entry !== ''
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

async function readPasswords() {
	const users = await Container.get(UserRepository).find({ select: ['id', 'password'] });
	return new Map(users.map(({ id, password }) => [id, password]));
}

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
	const { saml } = Container.get(GlobalConfig).sso;
	return {
		authenticationMethod: config.getEnv('userManagement.authenticationMethod'),
		samlLoginEnabled: saml.loginEnabled,
		samlLoginLabel: saml.loginLabel,
	};
}

let emit: MockInstance<EventService['emit']>;

function describeEvents() {
	return emit.mock.calls.map(([name, payload]) => [
		name,
		mapStrings(normalize(redact(payload)), withoutRunValues),
	]);
}

/** Run a case, and record what it did. */
async function runCase(action: () => Promise<unknown>) {
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
	await recorder.labelNewRows(['project', 'user']);
	const after = await dumpDatabase();
	return {
		result,
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

/** The preferences that the service has in memory. The ordinary SAML tests also write them. */
type PrivatePreferences = { _samlPreferences: SamlPreferences };

/** The preferences in memory and the login label before the first test. */
let initialPreferences: SamlPreferences;
let initialLoginLabel: string;

/**
 * Remove the SAML config, and make email the sign-in method. The service keeps its preferences in
 * memory when it resets and when it loads no row, so they go back to the values before the first
 * test.
 */
async function resetSaml() {
	const samlService = Container.get(SamlService);
	(samlService as unknown as PrivatePreferences)._samlPreferences =
		structuredClone(initialPreferences);
	await samlService.reset();
	await Container.get(SettingsRepository).delete({ key: SAML_PREFERENCES_DB_KEY });
	await setCurrentAuthenticationMethod('email');
	const { saml } = Container.get(GlobalConfig).sso;
	saml.loginEnabled = false;
	saml.loginLabel = initialLoginLabel;
	await samlService.init();
}

/** Give the user a SAML identity, as an earlier SAML sign-in does. */
async function attachSamlIdentity(user: User, providerId: string) {
	await Container.get(AuthIdentityRepository).save(AuthIdentity.create(user, providerId, 'saml'));
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
	(Container.get(PubSubEventBus).emit as (event: string) => boolean)('reload-saml-config');
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 50));
}

let alpha: Project;
let beta: Project;

async function createFixtureProject(name: string) {
	const project = await createTeamProject(name);
	label(project.id, `project ${name}`);
	return project;
}

/** A SAML response as the browser posts the form of the IdP to the ACS. */
async function postToAcs(samlResponse: string | undefined, relayState?: string) {
	const form: Record<string, string> = {};
	if (samlResponse !== undefined) form.SAMLResponse = samlResponse;
	if (relayState !== undefined) form.RelayState = relayState;
	return await request(testServer.app).post('/rest/sso/saml/acs').type('form').send(form);
}

/** The attributes of a person at the IdP, with extra attributes. */
function samlPerson(
	name: string,
	extra: Record<string, string | string[]> = {},
): Pick<IdpSettings, 'nameId' | 'attributes'> {
	return {
		nameId: `${name}@example.com`,
		attributes: {
			[claim('emailaddress')]: `${name}@example.com`,
			[claim('firstname')]: name[0].toUpperCase() + name.slice(1),
			[claim('lastname')]: 'Saml',
			[claim('upn')]: `${name}-upn`,
			...extra,
		},
	};
}

/** The global role and the team project roles of the user with the email, after a case. */
async function describePerson(email: string) {
	const user = await Container.get(UserRepository).findOne({
		where: { email },
		relations: ['role'],
	});
	if (!user) return '<no user>';
	const relations = await Container.get(ProjectRelationRepository).find({
		where: { userId: user.id },
		relations: ['project', 'role'],
	});
	return {
		role: user.role.slug,
		projects: relations
			.filter((relation) => relation.project.type === 'team')
			.map((relation) => `${labelString(relation.projectId)}: ${relation.role.slug}`)
			.sort(),
	};
}

const provisioningService = () => Container.get(ProvisioningService);

/** Store a provisioning config, and load it into the service that the code under test uses. */
async function setProvisioning(changes: Record<string, unknown> = {}) {
	const settings = Container.get(SettingsRepository);
	await settings.delete({ key: PROVISIONING_PREFERENCES_DB_KEY });
	await settings.insert({
		key: PROVISIONING_PREFERENCES_DB_KEY,
		value: JSON.stringify({ ...PROVISIONING_OFF, ...changes }),
		loadOnStartup: true,
	});
	await provisioningService().handleReloadSsoProvisioningConfiguration();
}

const PROVISIONING_OFF = {
	scopesProvisionInstanceRole: false,
	scopesProvisionProjectRoles: false,
	scopesName: 'n8n',
	scopesInstanceRoleClaimName: 'n8n_instance_role',
	scopesProjectsRolesClaimName: 'n8n_projects',
	scopesUseExpressionMapping: false,
};

let ruleCount = 0;

async function resetRules() {
	await Container.get(RoleMappingRuleRepository).delete({});
}

/** Add a rule outside of a case. */
async function addRule(rule: {
	expression: string;
	role: string;
	type: 'instance' | 'project';
	projects?: Project[];
}) {
	const repository = Container.get(RoleMappingRuleRepository);
	const role = await Container.get(RoleRepository).findOneByOrFail({ slug: rule.role });
	const order = await repository.count({ where: { type: rule.type } });
	const saved = await repository.save(
		repository.create({
			expression: rule.expression,
			role,
			type: rule.type,
			order,
			projects: rule.projects ?? [],
		}),
	);
	ruleCount += 1;
	label(saved.id, `rule ${ruleCount}`);
	return saved.id;
}

beforeAll(async () => {
	initialPreferences = structuredClone(
		(Container.get(SamlService) as unknown as PrivatePreferences)._samlPreferences,
	);
	initialLoginLabel = Container.get(GlobalConfig).sso.saml.loginLabel;
	label(RSA_TEST_PRIVATE_KEY, 'the RSA test key');
	label(RSA_TEST_CERTIFICATE, 'the RSA test certificate');
	label(certificateBody(RSA_TEST_CERTIFICATE), 'the body of the RSA test certificate');
	label(EC_TEST_PRIVATE_KEY, 'the EC test key');
	label(EC_TEST_CERTIFICATE, 'the EC test certificate');
	label(certificateBody(EC_TEST_CERTIFICATE), 'the body of the EC test certificate');
	label(RSA_MISMATCHED_CERTIFICATE, 'the mismatched RSA certificate');
	label(idpMetadata(), 'the IdP metadata');
	label(idpMetadata({ ssoBindings: ['post'] }), 'the IdP metadata with the post binding only');
	label(
		idpMetadata({ wantAuthnRequestsSigned: true }),
		'the IdP metadata that wants signed requests',
	);

	testServer.app.engine('handlebars', createHandlebarsEngine());
	testServer.app.set('view engine', 'handlebars');
	testServer.app.set('views', TEMPLATES_DIR);

	await testDb.truncate(['User']);
	owner = await createFixtureUser('owner', { role: GLOBAL_OWNER_ROLE });
	admin = await createFixtureUser('admin', { role: GLOBAL_ADMIN_ROLE });
	member = await createFixtureUser('member', { role: GLOBAL_MEMBER_ROLE });
	chatUser = await createFixtureUser('chat', { role: GLOBAL_CHAT_USER_ROLE });
	alpha = await createFixtureProject('alpha');
	beta = await createFixtureProject('beta');
	await recorder.labelNewRows(['project', 'user']);
});

beforeEach(async () => {
	emit = vi.spyOn(Container.get(EventService), 'emit');
	testServer.license.enable('feat:saml');
	await resetSaml();
});

// ----------------------------------------------------------------------------------------------
// Cases (draft)
// ----------------------------------------------------------------------------------------------

/** Each test runs many cases one after another, against a real database. */
const TEST_TIMEOUT = 10 * 60 * 1000;

const roles = () => ({ owner, admin, member, 'chat user': chatUser });

function setLicensed(licensed: boolean) {
	if (licensed) testServer.license.enable('feat:saml');
	else testServer.license.disable('feat:saml');
}

/** Save a SAML config through the API, outside of a case. */
async function configure(changes: Record<string, unknown> = {}) {
	const response = await testServer
		.authAgentFor(owner)
		.post('/sso/saml/config')
		.send({ metadata: idpMetadata(), ...changes });
	if (response.status !== 200) {
		throw new Error(`Cannot configure SAML: ${response.status} ${JSON.stringify(response.body)}`);
	}
}

describe('SAML', { timeout: TEST_TIMEOUT }, () => {
	// The first test: this process has not saved a SAML config yet.
	test('before the first config', async () => {
		const outcomes: Record<string, unknown> = {};
		const getMetadata = async () =>
			await runCase(
				async () =>
					await describeResponse(await request(testServer.app).get('/rest/sso/saml/metadata')),
			);
		outcomes['the metadata of the service provider'] = await getMetadata();
		outcomes['reading the config'] = await runCase(
			async () =>
				await describeResponse(await testServer.authAgentFor(owner).get('/sso/saml/config')),
		);
		outcomes['the login'] = await runCase(
			async () =>
				await describeResponse(await request(testServer.app).get('/rest/sso/saml/initsso')),
		);
		outcomes['a sign-in'] = await runCase(async () => ({
			response: await describeResponse(
				await postToAcs(await loginResponse({ ...defaultIdpSettings(), ...samlPerson('first') })),
			),
			after: await describePerson('first@example.com'),
		}));
		outcomes['a sign-in with a response that is not XML'] = await runCase(
			async () => await describeResponse(await postToAcs('not a response')),
		);
		outcomes['the connection test without metadata'] = await runCase(
			async () =>
				await describeResponse(
					await testServer.authAgentFor(owner).post('/sso/saml/config/test').send({}),
				),
		);
		outcomes['the login on without metadata'] = await runCase(
			async () =>
				await describeResponse(
					await testServer
						.authAgentFor(owner)
						.post('/sso/saml/config/toggle')
						.send({ loginEnabled: true }),
				),
		);
		outcomes['the metadata after the toggle'] = await getMetadata();
		await resetSaml();
		await configure();
		outcomes['the metadata after the first config'] = await getMetadata();
		expect(outcomes).toMatchSnapshot();
	});

	test('the metadata of the service provider', async () => {
		const outcomes: Record<string, unknown> = {};
		await configure();
		for (const licensed of [true, false]) {
			setLicensed(licensed);
			const licence = licensed ? 'licensed' : 'not licensed';
			outcomes[`${licence} | no session`] = await runCase(
				async () =>
					await describeResponse(await request(testServer.app).get('/rest/sso/saml/metadata')),
			);
			for (const [name, user] of Object.entries(roles())) {
				outcomes[`${licence} | ${name}`] = await runCase(
					async () =>
						await describeResponse(await testServer.authAgentFor(user).get('/sso/saml/metadata')),
				);
			}
		}
		setLicensed(true);
		const settings: Record<string, Record<string, unknown>> = {
			'login on': { loginEnabled: true },
			'the redirect ACS binding': { acsBinding: 'redirect' },
			'wantAssertionsSigned false': { wantAssertionsSigned: false },
			'wantMessageSigned false': { wantMessageSigned: false },
		};
		for (const [name, changes] of Object.entries(settings)) {
			await resetSaml();
			await configure(changes);
			outcomes[name] = await runCase(
				async () =>
					await describeResponse(await request(testServer.app).get('/rest/sso/saml/metadata')),
			);
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('reading the config', async () => {
		const outcomes: Record<string, unknown> = {};
		for (const licensed of [true, false]) {
			setLicensed(licensed);
			const licence = licensed ? 'licensed' : 'not licensed';
			for (const [name, user] of Object.entries(roles())) {
				outcomes[`${licence} | ${name}`] = await runCase(
					async () =>
						await describeResponse(await testServer.authAgentFor(user).get('/sso/saml/config')),
				);
			}
			outcomes[`${licence} | no session`] = await runCase(
				async () =>
					await describeResponse(await request(testServer.app).get('/rest/sso/saml/config')),
			);
		}
		setLicensed(true);
		await configure({ loginEnabled: true, loginLabel: 'Company SSO' });
		outcomes['a stored config | owner'] = await runCase(
			async () =>
				await describeResponse(await testServer.authAgentFor(owner).get('/sso/saml/config')),
		);
		expect(outcomes).toMatchSnapshot();
	});

	test('saving the config', async () => {
		const outcomes: Record<string, unknown> = {};
		const save = async (body: unknown, user: User = owner) =>
			await runCase(async () => ({
				response: await describeResponse(
					await testServer
						.authAgentFor(user)
						.post('/sso/saml/config')
						.send(body as object),
				),
				readBack: await describeResponse(
					await testServer.authAgentFor(owner).get('/sso/saml/config'),
				),
			}));

		// Who may save, with and without the licence.
		for (const licensed of [true, false]) {
			for (const [name, user] of Object.entries(roles())) {
				await resetSaml();
				setLicensed(licensed);
				outcomes[`${licensed ? 'licensed' : 'not licensed'} | ${name}`] = await save(
					{ metadata: idpMetadata() },
					user,
				);
			}
		}
		await resetSaml();
		setLicensed(true);
		outcomes['no session'] = await runCase(
			async () =>
				await describeResponse(
					await request(testServer.app)
						.post('/rest/sso/saml/config')
						.send({ metadata: idpMetadata() }),
				),
		);

		// Bodies.
		const bodies: Record<string, unknown> = {
			'no body': undefined,
			'an empty object': {},
			'the metadata': { metadata: idpMetadata() },
			'the metadata, login on': { metadata: idpMetadata(), loginEnabled: true },
			'login on without metadata': { loginEnabled: true },
			'metadata that is not XML': { metadata: '<not xml' },
			'metadata of another schema': { metadata: '<EntityDescriptor/>' },
			'metadata without a redirect binding': { metadata: idpMetadata({ ssoBindings: ['post'] }) },
			'an invalid login binding': { metadata: idpMetadata(), loginBinding: 'invalid' },
			'the post login binding': { metadata: idpMetadata(), loginBinding: 'post' },
			'a login label': { metadata: idpMetadata(), loginLabel: 'Company SSO' },
			'an unknown key': { metadata: idpMetadata(), unknown: 1 },
			'wantAssertionsSigned false': { metadata: idpMetadata(), wantAssertionsSigned: false },
			'wantMessageSigned false': { metadata: idpMetadata(), wantMessageSigned: false },
			'the redirect ACS binding': { metadata: idpMetadata(), acsBinding: 'redirect' },
			'a relay state': { metadata: idpMetadata(), relayState: '/workflows' },
			emailVerifiedRequired: { metadata: idpMetadata(), emailVerifiedRequired: true },
			'a signature config': {
				metadata: idpMetadata(),
				signatureConfig: {
					prefix: 'sig',
					location: { reference: '/samlp:Response/saml:Issuer', action: 'before' },
				},
			},
			'a mapping': {
				metadata: idpMetadata(),
				mapping: {
					email: 'mail',
					firstName: 'givenName',
					lastName: 'sn',
					userPrincipalName: 'uid',
				},
			},
			'a partial mapping': { metadata: idpMetadata(), mapping: { email: 'mail' } },
			'ignoreSSL true': { metadata: idpMetadata(), ignoreSSL: true },
		};
		for (const [name, body] of Object.entries(bodies)) {
			await resetSaml();
			outcomes[`body | ${name}`] = await save(body);
		}

		// A second save keeps what the first one set.
		await resetSaml();
		await configure({ loginLabel: 'Company SSO', relayState: '/workflows' });
		outcomes['a second save with the metadata only'] = await save({ metadata: idpMetadata() });

		// The other sign-in methods.
		for (const method of ['ldap', 'oidc'] as const) {
			for (const loginEnabled of [true, false]) {
				await resetSaml();
				await setCurrentAuthenticationMethod(method);
				outcomes[`sign-in method ${method} | loginEnabled ${loginEnabled}`] = await save({
					metadata: idpMetadata(),
					loginEnabled,
				});
			}
		}

		// SSO managed by the environment.
		const loaderConfig = Container.get(InstanceSettingsLoaderConfig);
		await resetSaml();
		loaderConfig.ssoManagedByEnv = true;
		try {
			outcomes['SSO managed by the environment | a save'] = await save({
				metadata: idpMetadata(),
				loginEnabled: true,
			});
			outcomes['SSO managed by the environment | the toggle'] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.post('/sso/saml/config/toggle')
							.send({ loginEnabled: false }),
					),
			);
		} finally {
			loaderConfig.ssoManagedByEnv = false;
		}

		// Multi-main: the other main instances get the reload command.
		await resetSaml();
		const instanceSettings = Container.get(InstanceSettings);
		instanceSettings.setMultiMainEnabled(true);
		instanceSettings.setMultiMainLicensed(true);
		try {
			outcomes['multi-main | a save'] = await save({ metadata: idpMetadata(), loginEnabled: true });
			outcomes['multi-main | the toggle'] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.post('/sso/saml/config/toggle')
							.send({ loginEnabled: false }),
					),
			);
			outcomes['multi-main | a save that fails'] = await save({ metadata: '<not xml' });
		} finally {
			instanceSettings.setMultiMainEnabled(false);
			instanceSettings.setMultiMainLicensed(false);
		}

		expect(outcomes).toMatchSnapshot();
	});

	test('the metadata URL', async () => {
		const outcomes: Record<string, unknown> = {};
		let status = 200;
		let body = idpMetadata();
		const server = await startServer((_req, res) => {
			res.writeHead(status, { 'content-type': 'application/xml' });
			res.end(body);
		});
		label(server.url, 'metadata server');
		try {
			const cases: Record<string, () => void> = {
				'it serves the metadata': () => {
					status = 200;
					body = idpMetadata();
				},
				'it answers 404': () => {
					status = 404;
					body = 'not found';
				},
				'it serves text that is not metadata': () => {
					status = 200;
					body = 'this is not SAML metadata';
				},
			};
			for (const [name, arrange] of Object.entries(cases)) {
				await resetSaml();
				arrange();
				server.clear();
				outcomes[name] = await runCase(async () => ({
					response: await describeResponse(
						await testServer
							.authAgentFor(owner)
							.post('/sso/saml/config')
							.send({ metadataUrl: `${server.url}/idp/metadata` }),
					),
					requests: [...server.captured],
				}));
			}
			await resetSaml();
			outcomes['a host that does not answer'] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.post('/sso/saml/config')
							.send({ metadataUrl: 'http://127.0.0.1:9/idp/metadata' }),
					),
			);
			await resetSaml();
			status = 200;
			body = idpMetadata();
			outcomes['metadata and a metadata URL'] = await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(owner)
							.post('/sso/saml/config')
							.send({ metadata: idpMetadata(), metadataUrl: `${server.url}/idp/metadata` }),
					),
			);
		} finally {
			await server.close();
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('signing keys', async () => {
		const outcomes: Record<string, unknown> = {};
		const FLAG = 'N8N_ENV_FEAT_SIGNED_SAML_REQUESTS';
		const flagBefore = process.env[FLAG];
		const save = async (body: Record<string, unknown>) =>
			await runCase(async () => ({
				response: await describeResponse(
					await testServer
						.authAgentFor(owner)
						.post('/sso/saml/config')
						.send({ metadata: idpMetadata(), ...body }),
				),
				readBack: await describeResponse(
					await testServer.authAgentFor(owner).get('/sso/saml/config'),
				),
			}));
		const rsaPair = {
			signingPrivateKey: RSA_TEST_PRIVATE_KEY,
			signingCertificate: RSA_TEST_CERTIFICATE,
		};
		try {
			delete process.env[FLAG];
			outcomes['flag off | a key and a certificate'] = await save(rsaPair);
			outcomes['flag off | authnRequestsSigned'] = await save({ authnRequestsSigned: true });

			process.env[FLAG] = 'true';
			const bodies: Record<string, Record<string, unknown>> = {
				'an RSA pair': rsaPair,
				'an EC pair': {
					signingPrivateKey: EC_TEST_PRIVATE_KEY,
					signingCertificate: EC_TEST_CERTIFICATE,
				},
				'an RSA pair, authnRequestsSigned': { ...rsaPair, authnRequestsSigned: true },
				'a mismatched pair': { ...rsaPair, signingCertificate: RSA_MISMATCHED_CERTIFICATE },
				'a mismatched pair, authnRequestsSigned': {
					...rsaPair,
					signingCertificate: RSA_MISMATCHED_CERTIFICATE,
					authnRequestsSigned: true,
				},
				'an invalid key': { ...rsaPair, signingPrivateKey: 'not a key' },
				'an invalid certificate': { ...rsaPair, signingCertificate: 'not a certificate' },
				'only a key': { signingPrivateKey: RSA_TEST_PRIVATE_KEY },
				'only a key, authnRequestsSigned': {
					signingPrivateKey: RSA_TEST_PRIVATE_KEY,
					authnRequestsSigned: true,
				},
				'only a certificate': { signingCertificate: RSA_TEST_CERTIFICATE },
				'authnRequestsSigned without keys': { authnRequestsSigned: true },
			};
			for (const [name, body] of Object.entries(bodies)) {
				await resetSaml();
				outcomes[`flag on | ${name}`] = await save(body);
			}

			// Changes to a stored pair.
			const changes: Record<string, Record<string, unknown>> = {
				'empty strings': { signingPrivateKey: '', signingCertificate: '' },
				'the redacted value': {
					signingPrivateKey: CREDENTIAL_BLANKING_VALUE,
					signingCertificate: RSA_TEST_CERTIFICATE,
				},
				'the metadata only': {},
				'an EC pair': {
					signingPrivateKey: EC_TEST_PRIVATE_KEY,
					signingCertificate: EC_TEST_CERTIFICATE,
				},
			};
			for (const [name, body] of Object.entries(changes)) {
				await resetSaml();
				await configure(rsaPair);
				outcomes[`a stored pair | ${name}`] = await save(body);
			}

			// Signed login requests.
			const signedLogin = async () => await runCase(describeLogin);
			for (const wantAuthnRequestsSigned of [false, true]) {
				const idp = `the IdP wants signed requests: ${wantAuthnRequestsSigned}`;
				for (const loginBinding of ['redirect', 'post']) {
					await resetSaml();
					await configure({
						...rsaPair,
						metadata: idpMetadata({ wantAuthnRequestsSigned }),
						authnRequestsSigned: true,
						loginEnabled: true,
						loginBinding,
					});
					outcomes[`${idp} | ${loginBinding} | the login`] = await signedLogin();
				}
				outcomes[`${idp} | the metadata of the service provider`] = await runCase(
					async () =>
						await describeResponse(await request(testServer.app).get('/rest/sso/saml/metadata')),
				);
				outcomes[`${idp} | the connection test`] = await runCase(async () => {
					const response = await testServer
						.authAgentFor(owner)
						.post('/sso/saml/config/test')
						.send({});
					const described = await describeResponse(response);
					const data = (response.body as { data?: unknown } | undefined)?.data;
					return typeof data === 'string' && data.startsWith('https://')
						? { ...described, request: describeRedirectRequest(data) }
						: described;
				});
			}
			// When the service provider takes a changed config: its metadata and the login request.
			const samlService = Container.get(SamlService);
			const serviceProvider = async () => ({
				metadata: await describeResponse(
					await request(testServer.app).get('/rest/sso/saml/metadata'),
				),
				login: await describeLogin(),
			});
			const signedConfig = {
				...rsaPair,
				metadata: idpMetadata({ wantAuthnRequestsSigned: true }),
				authnRequestsSigned: true,
				loginEnabled: true,
			};
			await resetSaml();
			await configure(signedConfig);
			outcomes['the service provider | after a save'] = await runCase(serviceProvider);
			outcomes['the service provider | after init'] = await runCase(async () => {
				await samlService.init();
				return await serviceProvider();
			});
			await resetSaml();
			await configure(signedConfig);
			outcomes['the service provider | after loadFromDbAndApplySamlPreferences(true)'] =
				await runCase(async () => {
					await samlService.loadFromDbAndApplySamlPreferences(true);
					return await serviceProvider();
				});
			await resetSaml();
			outcomes['the service provider | after a reset'] = await runCase(serviceProvider);

			await resetSaml();
			await configure(signedConfig);
			delete process.env[FLAG];
			outcomes['the flag off after the keys are stored | the login'] = await signedLogin();
			outcomes['the flag off after the keys are stored | a save'] = await save({
				metadata: idpMetadata({ wantAuthnRequestsSigned: true }),
			});
			outcomes['the flag off after the keys are stored | a sign-in'] = await runCase(
				async () =>
					await describeResponse(
						await postToAcs(
							await loginResponse({ ...defaultIdpSettings(), ...samlPerson('signed') }),
						),
					),
			);
		} finally {
			if (flagBefore === undefined) delete process.env[FLAG];
			else process.env[FLAG] = flagBefore;
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('toggling the login', async () => {
		const outcomes: Record<string, unknown> = {};
		const toggle = async (body: unknown, user: User = owner) =>
			await runCase(
				async () =>
					await describeResponse(
						await testServer
							.authAgentFor(user)
							.post('/sso/saml/config/toggle')
							.send(body as object),
					),
			);
		for (const [name, user] of Object.entries(roles())) {
			await resetSaml();
			await configure();
			outcomes[`role | ${name}`] = await toggle({ loginEnabled: true }, user);
		}
		const bodies: Record<string, unknown> = {
			'no body': undefined,
			'login on': { loginEnabled: true },
			'login off': { loginEnabled: false },
			'a string': { loginEnabled: 'true' },
		};
		for (const [name, body] of Object.entries(bodies)) {
			await resetSaml();
			await configure();
			outcomes[`body | ${name}`] = await toggle(body);
		}
		await resetSaml();
		outcomes['without a config'] = await toggle({ loginEnabled: true });
		for (const method of ['ldap', 'oidc'] as const) {
			await resetSaml();
			await configure();
			await setCurrentAuthenticationMethod(method);
			outcomes[`the sign-in method is ${method}`] = await toggle({ loginEnabled: true });
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('the login', async () => {
		const outcomes: Record<string, unknown> = {};
		const login = async (path?: string) => await runCase(async () => await describeLogin(path));
		outcomes['login off'] = await login();
		await configure({ loginEnabled: true });
		outcomes['login on'] = await login();
		outcomes['a redirect'] = await login('/rest/sso/saml/initsso?redirect=%2Fworkflows');
		outcomes['a redirect to another origin'] = await login(
			'/rest/sso/saml/initsso?redirect=https%3A%2F%2Fevil.example.test%2F',
		);
		outcomes['a redirect with spaces'] = await login(
			'/rest/sso/saml/initsso?redirect=%20%2Fworkflows%20',
		);
		outcomes['a redirect with a backslash'] = await login(
			'/rest/sso/saml/initsso?redirect=%2F%5Cevil.example.test%2F',
		);
		outcomes['two redirects'] = await login(
			'/rest/sso/saml/initsso?redirect=%2Fworkflows&redirect=%2Fhome',
		);
		await configure({ loginEnabled: true, loginBinding: 'post' });
		outcomes['the post binding'] = await login();
		await configure({ loginEnabled: true, loginBinding: 'redirect', relayState: '/home' });
		outcomes['a relay state in the config'] = await login();
		setLicensed(false);
		outcomes['not licensed'] = await login();
		setLicensed(true);
		expect(outcomes).toMatchSnapshot();
	});

	test('the connection test', async () => {
		const outcomes: Record<string, unknown> = {};
		const start = async (body: unknown, user: User = owner) =>
			await runCase(async () => {
				const response = await testServer
					.authAgentFor(user)
					.post('/sso/saml/config/test')
					.send(body as object);
				const described = await describeResponse(response);
				const data = (response.body as { data?: unknown } | undefined)?.data;
				return typeof data === 'string' && data.startsWith('https://')
					? { ...described, request: describeRedirectRequest(data) }
					: described;
			});
		for (const [name, user] of Object.entries(roles())) {
			outcomes[`role | ${name}`] = await start({ metadata: idpMetadata() }, user);
		}
		outcomes['no body'] = await start(undefined);
		outcomes['metadata that is not XML'] = await start({ metadata: '<not xml' });
		outcomes['the post binding'] = await start({ metadata: idpMetadata(), loginBinding: 'post' });
		await configure();
		outcomes['no body, with a stored config'] = await start(undefined);

		// The callback of a connection test: the relay state of the test request, then the ACS.
		const testRelayState = async (body: unknown) => {
			const response = await testServer
				.authAgentFor(owner)
				.post('/sso/saml/config/test')
				.send(body as object);
			const data = (response.body as { data?: unknown } | undefined)?.data;
			if (typeof data !== 'string') return undefined;
			return new URL(data).searchParams.get('RelayState') ?? undefined;
		};
		const callback = async (
			settings: Partial<IdpSettings>,
			body: unknown = { metadata: idpMetadata() },
		) =>
			await runCase(async () => {
				const relayState = await testRelayState(body);
				const samlResponse = await loginResponse(
					{ ...defaultIdpSettings(), ...settings },
					relayState,
				);
				const first = await postToAcs(samlResponse, relayState);
				const second = await postToAcs(samlResponse, relayState);
				return { first: await describeResponse(first), second: await describeResponse(second) };
			});
		outcomes['callback | a valid response'] = await callback(samlPerson('tester'));
		outcomes['callback | without the email'] = await callback({
			...samlPerson('tester'),
			attributes: { [claim('upn')]: 'tester-upn' },
		});
		outcomes['callback | an invalid email'] = await callback(
			samlPerson('tester', { [claim('emailaddress')]: 'not-an-email' }),
		);
		outcomes['callback | another key'] = await callback({
			...samlPerson('tester'),
			signingKey: 'other key',
		});
		outcomes['callback | an unknown test token'] = await runCase(
			async () =>
				await describeResponse(
					await postToAcs(
						await loginResponse({ ...defaultIdpSettings(), ...samlPerson('tester') }),
						'http://localhost:5678/config/test/return?t=0000',
					),
				),
		);
		expect(outcomes).toMatchSnapshot();
	});

	test('the assertion consumer service', async () => {
		const outcomes: Record<string, unknown> = {};
		const acsCase = async (samlResponse: string | undefined, relayState?: string) =>
			await runCase(async () => await describeResponse(await postToAcs(samlResponse, relayState)));
		const signInCase = async (
			person: Pick<IdpSettings, 'nameId' | 'attributes'>,
			settings: Partial<IdpSettings> = {},
			relayState?: string,
		) =>
			await runCase(async () => ({
				response: await describeResponse(
					await postToAcs(
						await loginResponse({ ...defaultIdpSettings(), ...person, ...settings }, relayState),
						relayState,
					),
				),
				after: await describePerson(person.nameId),
			}));
		const without = (name: string, attribute: string) => {
			const person = samlPerson(name);
			delete person.attributes[claim(attribute)];
			return person;
		};

		// Before the login is on.
		await configure();
		outcomes['login off'] = await signInCase(samlPerson('nobody'));
		await configure({ loginEnabled: true });
		outcomes['no SAML response'] = await acsCase(undefined);
		outcomes['a SAML response that is not base64 XML'] = await acsCase('not a response');

		// New users.
		outcomes['a new user'] = await signInCase(samlPerson('newone'));
		outcomes['the same user again'] = await signInCase(samlPerson('newone'));
		outcomes['an email in upper case'] = await signInCase(
			samlPerson('upper', { [claim('emailaddress')]: 'UPPER@EXAMPLE.COM' }),
		);
		outcomes['an invalid email'] = await signInCase(
			samlPerson('invalid', { [claim('emailaddress')]: 'not-an-email' }),
		);
		outcomes['two emails'] = await signInCase(
			samlPerson('twoemails', {
				[claim('emailaddress')]: ['twoemails@example.com', 'second@example.com'],
			}),
		);
		for (const attribute of ['emailaddress', 'upn', 'firstname', 'lastname']) {
			outcomes[`without ${attribute}`] = await signInCase(without(`no${attribute}`, attribute));
		}
		outcomes['no attributes'] = await signInCase({
			nameId: 'noattributes@example.com',
			attributes: {},
		});
		outcomes['empty names'] = await signInCase(
			samlPerson('emptynames', { [claim('firstname')]: '', [claim('lastname')]: '' }),
		);

		// Existing users: the identity wins, then the email with the rules of email verification.
		await createFixtureUser('existing');
		outcomes['an existing user by email'] = await signInCase(samlPerson('existing'));
		outcomes['the existing user again'] = await signInCase(samlPerson('existing'));
		const identityOwner = await createFixtureUser('identityowner');
		await attachSamlIdentity(identityOwner, 'identityowner-upn');
		await createFixtureUser('emailowner');
		outcomes['the identity of a user, with the email of another user'] = await signInCase(
			samlPerson('emailowner', { [claim('upn')]: 'identityowner-upn' }),
		);
		outcomes['the identity of a user, with a new email'] = await signInCase(
			samlPerson('changedemail', { [claim('upn')]: 'identityowner-upn' }),
		);
		const nameless = await createFixtureUser('nameless', { firstName: '', lastName: '' });
		await attachSamlIdentity(nameless, 'nameless-upn');
		outcomes['the identity of a user without names'] = await signInCase(samlPerson('nameless'));
		outcomes['the owner'] = await signInCase(samlPerson('owner'));
		await createFixtureUser('disabled', { disabled: true });
		outcomes['a disabled user'] = await signInCase(samlPerson('disabled'));

		// The mapping can name an attribute for the email verification.
		for (const required of [false, true]) {
			const rule = required ? 'required' : 'optional';
			await configure({
				loginEnabled: true,
				mapping: { ...DEFAULT_MAPPING, emailVerified: 'email_verified' },
				emailVerifiedRequired: required,
			});
			// Emails are stored in lower case, so each value gets its own name.
			for (const [index, value] of [undefined, 'true', 'false', 'TRUE', 'yes'].entries()) {
				const name = `verified${rule}${index}`;
				await createFixtureUser(name);
				outcomes[`email verified ${value ?? 'absent'}, ${rule} | an existing user`] =
					await signInCase(samlPerson(name, value === undefined ? {} : { email_verified: value }));
			}
			for (const value of [undefined, 'false']) {
				outcomes[`email verified ${value ?? 'absent'}, ${rule} | a new user`] = await signInCase(
					samlPerson(
						`new${rule}${value ?? 'absent'}`,
						value === undefined ? {} : { email_verified: value },
					),
				);
			}
		}
		await configure({ loginEnabled: true, emailVerifiedRequired: true, mapping: DEFAULT_MAPPING });
		await createFixtureUser('requirednomapping');
		outcomes['email verification required, no attribute in the mapping'] = await signInCase(
			samlPerson('requirednomapping'),
		);
		await resetSaml();
		await configure({ loginEnabled: true });

		// Signatures, times and values of the response.
		const variants: Record<string, Partial<IdpSettings>> = {
			'signed with another key': { signingKey: 'other key' },
			'signed with another key and its certificate': { signingKey: 'other key and certificate' },
			'an InResponseTo': { inResponseTo: '_request1' },
			'an empty InResponseTo': { inResponseTo: '' },
			'no message signature': { signMessage: false },
			'no assertion signature': { signAssertion: false },
			'no signature': { signMessage: false, signAssertion: false },
			expired: { notBefore: -600, notOnOrAfter: -300 },
			'expired 5 seconds ago': { notBefore: -600, notOnOrAfter: -5 },
			'not yet valid': { notBefore: 300, notOnOrAfter: 600 },
			'valid in 5 seconds': { notBefore: 5, notOnOrAfter: 600 },
			'another audience': { audience: 'https://other.example.test/metadata' },
			'another destination': { destination: 'https://other.example.test/acs' },
			'another recipient': { recipient: 'https://other.example.test/acs' },
			'another issuer': { issuer: 'https://other.example.test/idp' },
			'a failed status': { status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' },
		};
		for (const [name, settings] of Object.entries(variants)) {
			outcomes[`response | ${name}`] = await signInCase(
				samlPerson(`variant${Object.keys(outcomes).length}`),
				settings,
			);
		}
		for (const [name, changes] of Object.entries({
			'wantAssertionsSigned false': { wantAssertionsSigned: false },
			'wantMessageSigned false': { wantMessageSigned: false },
		})) {
			await configure({ loginEnabled: true, ...changes });
			for (const [variant, settings] of Object.entries({
				'no message signature': { signMessage: false },
				'no assertion signature': { signAssertion: false },
				'no signature': { signMessage: false, signAssertion: false },
			})) {
				outcomes[`${name} | ${variant}`] = await signInCase(
					samlPerson(`variant${Object.keys(outcomes).length}`),
					settings,
				);
			}
		}
		await resetSaml();
		await configure({ loginEnabled: true });

		// Where the browser goes after the sign-in.
		for (const relayState of [
			'',
			'/',
			'/workflows',
			'/workflows?a=1#b',
			' /workflows ',
			'/workflows/../signin',
			'//evil.example.test/',
			'/\\evil.example.test/',
			'/\t/evil.example.test/',
			'http://localhost:5678/workflows',
			'https://evil.example.test/',
			'not a url',
		]) {
			outcomes[`relay state ${JSON.stringify(relayState)}`] = await signInCase(
				samlPerson('relay'),
				{},
				relayState,
			);
		}
		await configure({ loginEnabled: true, relayState: '/workflows' });
		outcomes['a relay state in the config, none in the form'] = await signInCase(
			samlPerson('relay'),
		);
		outcomes['a relay state in the config and in the form'] = await signInCase(
			samlPerson('relay'),
			{},
			'/home',
		);
		await resetSaml();
		await configure({ loginEnabled: true });

		// The redirect binding: the response comes in the query.
		const getAcs = async (query: string) =>
			await runCase(
				async () =>
					await describeResponse(await request(testServer.app).get(`/rest/sso/saml/acs${query}`)),
			);
		outcomes['GET | no response'] = await getAcs('');
		outcomes['GET | a response of the redirect binding'] = await getAcs(
			await redirectLoginResponse(
				{ ...defaultIdpSettings(), ...samlPerson('redirect') },
				'/workflows',
			),
		);
		outcomes['GET | a response of the post binding'] = await getAcs(
			`?SAMLResponse=${encodeURIComponent(
				await loginResponse({ ...defaultIdpSettings(), ...samlPerson('redirect') }),
			)}`,
		);
		await configure({ loginEnabled: true, acsBinding: 'redirect' });
		outcomes['the redirect ACS binding | GET'] = await getAcs(
			await redirectLoginResponse({ ...defaultIdpSettings(), ...samlPerson('redirect') }),
		);
		outcomes['the redirect ACS binding | POST'] = await signInCase(samlPerson('redirect'));
		await resetSaml();
		await configure({ loginEnabled: true });

		setLicensed(false);
		outcomes['not licensed'] = await signInCase(samlPerson('nolicence'));
		setLicensed(true);
		expect(outcomes).toMatchSnapshot();
	});

	test('role provisioning', async () => {
		const outcomes: Record<string, unknown> = {};
		await configure({ loginEnabled: true });
		const signInCase = async (name: string, extra: Record<string, string | string[]>) =>
			await runCase(async () => ({
				response: await describeResponse(
					await postToAcs(
						await loginResponse({ ...defaultIdpSettings(), ...samlPerson(name, extra) }),
					),
				),
				after: await describePerson(`${name}@example.com`),
			}));

		// Direct claims: the attribute names come from the provisioning config.
		await setProvisioning({ scopesProvisionInstanceRole: true });
		for (const [name, value] of Object.entries({
			admin: 'global:admin',
			'chat user': 'global:chatUser',
			owner: 'global:owner',
			unknown: 'global:unknown',
			'a list': ['global:admin'],
		})) {
			outcomes[`instance claim | ${name}`] = await signInCase(`claim-${name.replace(/ /g, '-')}`, {
				n8n_instance_role: value,
			});
		}
		outcomes['instance claim | missing'] = await signInCase('claim-missing', {});
		await setProvisioning({
			scopesProvisionInstanceRole: true,
			defaultInstanceRole: 'block:access',
		});
		outcomes['instance claim | missing, default block:access'] = await signInCase(
			'claim-blocked',
			{},
		);

		await setProvisioning({ scopesProvisionProjectRoles: true });
		outcomes['project claim | a list'] = await signInCase('project-list', {
			n8n_projects: [`${alpha.id}:editor`, `${beta.id}:viewer`],
		});
		outcomes['project claim | one value'] = await signInCase('project-one', {
			n8n_projects: `${alpha.id}:editor`,
		});
		outcomes['project claim | an invalid entry'] = await signInCase('project-invalid', {
			n8n_projects: [`${alpha.id}:editor`, 'nonsense'],
		});
		// A valid entry with another entry: which entries n8n skips.
		const memberProject = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
			member.id,
		);
		const otherEntries: Record<string, string> = {
			'an unknown project': 'unknownproject1:editor',
			'an unknown role': `${beta.id}:reviewer`,
			'no role': `${beta.id}:`,
			'no project': ':editor',
			'a personal project': `${memberProject.id}:editor`,
			'a global role': `${beta.id}:member`,
			'the same project with another role': `${alpha.id}:viewer`,
		};
		for (const [index, [name, entry]] of Object.entries(otherEntries).entries()) {
			outcomes[`project claim | a valid entry, then ${name}`] = await signInCase(
				`project-mixed-${index}`,
				{ n8n_projects: [`${alpha.id}:editor`, entry] },
			);
		}
		outcomes['project claim | only invalid entries'] = await signInCase('project-only-invalid', {
			n8n_projects: ['nonsense', 'unknownproject1:editor'],
		});

		// Expression mapping: the context of a SAML sign-in.
		await setProvisioning({ scopesUseExpressionMapping: true });
		const probes: Record<string, string> = {
			$provider: "{{ $provider === 'saml' }}",
			'$claims is the raw attributes': "{{ $claims.groups.includes('n8n-admins') }}",
			'a single value is a string': "{{ typeof $claims.department === 'string' }}",
			'a multi value is an array': '{{ Array.isArray($claims.groups) }}',
			'$saml exists': "{{ typeof $saml === 'object' }}",
			'$saml.attributes is the attributes': "{{ $saml.attributes.department === 'it' }}",
			'$oidc is undefined': "{{ typeof $oidc === 'undefined' }}",
			'the mapped email is not a claim': '{{ $claims.email === undefined }}',
		};
		for (const [name, expression] of Object.entries(probes)) {
			await resetRules();
			await addRule({ expression, role: 'global:admin', type: 'instance' });
			outcomes[`probe | ${name}`] = await signInCase(`probe-${Object.keys(outcomes).length}`, {
				groups: ['n8n-admins', 'devops'],
				department: 'it',
			});
		}
		await resetRules();
		await setProvisioning({
			scopesUseExpressionMapping: true,
			defaultInstanceRole: 'block:access',
		});
		outcomes['no rule matches, default block:access'] = await signInCase('blocked', {});
		expect(outcomes).toMatchSnapshot();
	});

	test('the service', async () => {
		const outcomes: Record<string, unknown> = {};
		const samlService = Container.get(SamlService);
		const rows: Record<string, string | undefined> = {
			'no row': undefined,
			'the row of the loader, login off': JSON.stringify({ loginEnabled: false }),
			'the row of the loader, metadata': JSON.stringify({
				metadata: idpMetadata(),
				loginEnabled: true,
			}),
			'a row that is not JSON': 'not json',
			'a full row': JSON.stringify({
				metadata: idpMetadata(),
				loginEnabled: true,
				loginLabel: 'Company SSO',
			}),
			'a row with metadata that is not XML': JSON.stringify({
				metadata: '<not xml',
				loginEnabled: true,
			}),
			'a row with a metadata URL that does not answer': JSON.stringify({
				metadataUrl: 'http://127.0.0.1:9/idp/metadata',
				loginEnabled: true,
			}),
			'a row with metadata and a metadata URL that does not answer': JSON.stringify({
				metadata: idpMetadata(),
				metadataUrl: 'http://127.0.0.1:9/idp/metadata',
				loginEnabled: true,
			}),
		};
		for (const [name, value] of Object.entries(rows)) {
			await resetSaml();
			if (value !== undefined) {
				await Container.get(SettingsRepository).save({
					key: SAML_PREFERENCES_DB_KEY,
					value,
					loadOnStartup: true,
				});
			}
			outcomes[`init | ${name}`] = await runCase(async () => {
				await samlService.init();
				return normalize(samlService.samlPreferences);
			});
			outcomes[`loadFromDbAndApplySamlPreferences(false) | ${name}`] = await runCase(async () =>
				normalize(await samlService.loadFromDbAndApplySamlPreferences(false)),
			);
		}
		// A stored row with the login on, while another sign-in method is active.
		await resetSaml();
		await Container.get(SettingsRepository).save({
			key: SAML_PREFERENCES_DB_KEY,
			value: JSON.stringify({ metadata: idpMetadata(), loginEnabled: true }),
			loadOnStartup: true,
		});
		await setCurrentAuthenticationMethod('ldap');
		outcomes['init | the login on, sign-in method ldap'] = await runCase(async () => {
			await samlService.init();
			return normalize(samlService.samlPreferences);
		});
		await setCurrentAuthenticationMethod('email');
		await resetSaml();
		outcomes['setSamlPreferences'] = await runCase(async () => {
			await samlService.setSamlPreferences({ metadata: idpMetadata(), loginEnabled: true });
			return normalize(samlService.samlPreferences);
		});
		outcomes['reset'] = await runCase(async () => {
			await samlService.reset();
			return normalize(samlService.samlPreferences);
		});
		await resetSaml();
		await configure();
		outcomes['the getter, after the login flag changes'] = await runCase(async () => {
			Container.get(GlobalConfig).sso.saml.loginEnabled = true;
			return normalize(samlService.samlPreferences);
		});
		await resetSaml();
		await configure({ loginLabel: 'Company SSO' });
		outcomes['the getter, after the login label changes'] = await runCase(async () => {
			Container.get(GlobalConfig).sso.saml.loginLabel = 'Set elsewhere';
			return normalize(samlService.samlPreferences);
		});
		await resetSaml();
		await configure({ loginEnabled: true });
		outcomes['the getter, after the sign-in method changes'] = await runCase(async () => {
			await setCurrentAuthenticationMethod('email');
			return normalize(samlService.samlPreferences);
		});

		// Another main instance changes the row, and sends the reload command.
		Container.get(PubSubRegistry).init();
		const instanceSettings = Container.get(InstanceSettings);
		const otherRows: Record<string, string | undefined> = {
			'a changed row': JSON.stringify({
				metadata: idpMetadata(),
				loginLabel: 'Changed by another instance',
				loginEnabled: true,
			}),
			'a row with the login off': JSON.stringify({ metadata: idpMetadata(), loginEnabled: false }),
			'no row': undefined,
			'a row that is not JSON': 'not json',
		};
		for (const role of ['unset', 'leader', 'follower'] as const) {
			for (const [name, value] of Object.entries(otherRows)) {
				if (role !== 'follower' && name !== 'a changed row') continue;
				await resetSaml();
				await configure({ loginLabel: 'Company SSO', loginEnabled: true });
				const settings = Container.get(SettingsRepository);
				await settings.delete({ key: SAML_PREFERENCES_DB_KEY });
				if (value !== undefined) {
					await settings.insert({ key: SAML_PREFERENCES_DB_KEY, value, loadOnStartup: true });
				}
				instanceSettings.instanceRole = role;
				try {
					outcomes[`the reload command, instance role ${role} | ${name}`] = await runCase(
						async () => {
							await sendReloadCommand();
							return {
								preferences: normalize(samlService.samlPreferences),
								login: await describeResponse(
									await request(testServer.app).get('/rest/sso/saml/initsso'),
								),
							};
						},
					);
				} finally {
					instanceSettings.instanceRole = 'unset';
				}
			}
		}
		expect(outcomes).toMatchSnapshot();
	});
});
