// Fork test (not in upstream n8n): LDAP as a black box. A fake of the `ldapts` client plays an LDAP
// directory: it answers binds and searches from a fixed list of entries, and records each call that
// n8n makes. The test drives the REST routes of LDAP, the sign-in route, the scheduled
// synchronization and the module, and records the answers, the calls to the directory, the users
// and their LDAP identities, the synchronization history, the stored configuration, the events, the
// warnings and the timers. The snapshot was recorded against the enterprise module, and the fork
// module gives the same snapshot. See `packages/cli/src/modules/ldap/README.md`.
import { Logger } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import type { LdapConfig } from '@n8n/constants';
import { LDAP_DEFAULT_CONFIGURATION, LDAP_FEATURE_NAME } from '@n8n/constants';
import type { User } from '@n8n/db';
import {
	AuthIdentityRepository,
	AuthProviderSyncHistoryRepository,
	GLOBAL_OWNER_ROLE,
	ProjectRelationRepository,
	SettingsRepository,
	UserRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { Not } from '@n8n/typeorm';
import { Cipher, InstanceSettings } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

import { createLdapUser, createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import {
	LdapModule,
	LdapService,
	getCurrentAuthenticationMethod,
	setCurrentAuthenticationMethod,
} from './subject';

// #region The fake directory

type Entry = Record<string, string | string[] | Buffer>;

/** The directory, the failures to play, and the calls of the client. */
const ldap = vi.hoisted(() => ({
	entries: [] as Array<Record<string, string | string[] | Buffer>>,
	passwords: new Map<string, string>(),
	allowAnonymous: false,
	/** A failure for the next calls of one method: `unreachable` or `refused`. */
	failures: new Map<string, string>(),
	calls: [] as unknown[][],
}));

vi.mock('ldapts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ldapts')>();

	/** A value as plain data for the record. */
	const describe = (value: unknown): unknown => {
		if (value === undefined) return '<undefined>';
		if (value === null || typeof value !== 'object') {
			return typeof value === 'function' ? '<function>' : value;
		}
		if (Buffer.isBuffer(value)) return '<buffer>';
		if (value instanceof actual.Filter) return `<${value.constructor.name} ${value.toString()}>`;
		if (Array.isArray(value)) return value.map(describe);
		const prototype: unknown = Object.getPrototypeOf(value);
		const fields = Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, describe(entry)]),
		);
		if (prototype === Object.prototype || prototype === null) return fields;
		return { '<class>': (value as object).constructor.name, ...fields };
	};

	const attributeValues = (entry: Entry, attribute: string): Array<string | Buffer> => {
		const key = Object.keys(entry).find((name) => name.toLowerCase() === attribute.toLowerCase());
		if (key === undefined) return [];
		const value = entry[key];
		return Array.isArray(value) ? value : [value];
	};

	const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	const matches = (filter: InstanceType<typeof actual.Filter>, entry: Entry): boolean => {
		if (filter instanceof actual.AndFilter) return filter.filters.every((f) => matches(f, entry));
		if (filter instanceof actual.OrFilter) return filter.filters.some((f) => matches(f, entry));
		if (filter instanceof actual.NotFilter) return !matches(filter.filter, entry);
		if (filter instanceof actual.PresenceFilter) {
			return attributeValues(entry, filter.attribute).length > 0;
		}
		if (filter instanceof actual.EqualityFilter) {
			const expected = String(filter.value).toLowerCase();
			return attributeValues(entry, filter.attribute).some(
				(v) => typeof v === 'string' && v.toLowerCase() === expected,
			);
		}
		if (filter instanceof actual.SubstringFilter) {
			const pattern = new RegExp(
				`^${escapeRegex(filter.initial ?? '')}.*${(filter.any ?? []).map(escapeRegex).join('.*')}${
					(filter.any ?? []).length ? '.*' : ''
				}${escapeRegex(filter.final ?? '')}$`,
				'i',
			);
			return attributeValues(entry, filter.attribute).some(
				(v) => typeof v === 'string' && pattern.test(v),
			);
		}
		throw new Error(`The fake directory does not support ${filter.constructor.name}`);
	};

	const failure = (method: string) => {
		const kind = ldap.failures.get(method);
		if (kind === 'unreachable') {
			throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:389'), {
				code: 'ECONNREFUSED',
				syscall: 'connect',
			});
		}
		if (kind === 'refused') throw new actual.UnwillingToPerformError('Unwilling to perform');
	};

	class FakeClient {
		constructor(options: unknown) {
			ldap.calls.push(['new Client', describe(options)]);
			return new Proxy(this, {
				get(target, property, receiver) {
					if (typeof property === 'symbol' || property === 'then' || property in target) {
						return Reflect.get(target, property, receiver) as unknown;
					}
					return async (...args: unknown[]) => {
						ldap.calls.push([String(property), ...args.map(describe)]);
					};
				},
			});
		}

		get isConnected() {
			ldap.calls.push(['isConnected']);
			return false;
		}

		async startTLS(...args: unknown[]) {
			ldap.calls.push(['startTLS', ...args.map(describe)]);
			failure('startTLS');
		}

		async bind(dn: unknown, password?: unknown, ...rest: unknown[]) {
			ldap.calls.push(['bind', describe(dn), describe(password), ...rest.map(describe)]);
			failure('bind');
			const name = typeof dn === 'string' ? dn : String(dn);
			if (name === '' && (password === undefined || password === '') && ldap.allowAnonymous) {
				return;
			}
			const expected = [...ldap.passwords].find(
				([entryDn]) => entryDn.toLowerCase() === name.toLowerCase(),
			)?.[1];
			if (expected === undefined || expected !== password) {
				throw new actual.InvalidCredentialsError('Invalid Credentials');
			}
		}

		async search(base: unknown, options: Record<string, unknown> = {}, ...rest: unknown[]) {
			ldap.calls.push(['search', describe(base), describe(options), ...rest.map(describe)]);
			failure('search');
			const baseDn = String(base).toLowerCase();
			const filterOption = options.filter ?? '(objectClass=*)';
			const filter =
				typeof filterOption === 'string'
					? actual.FilterParser.parseString(filterOption)
					: (filterOption as InstanceType<typeof actual.Filter>);
			const scope = (options.scope as string | undefined) ?? 'sub';
			const attributes = Array.isArray(options.attributes) ? (options.attributes as string[]) : [];
			const searchEntries = ldap.entries
				.filter((entry) => {
					const dn = String(entry.dn).toLowerCase();
					if (scope === 'base') return dn === baseDn;
					return dn === baseDn || dn.endsWith(`,${baseDn}`);
				})
				.filter((entry) => matches(filter, entry))
				.map((entry) => {
					if (attributes.length === 0 || attributes.includes('*')) return { ...entry };
					const picked: Entry = { dn: entry.dn };
					for (const attribute of attributes) {
						const key = Object.keys(entry).find(
							(name) => name.toLowerCase() === attribute.toLowerCase(),
						);
						if (key !== undefined && key !== 'dn') picked[key] = entry[key];
					}
					return picked;
				});
			return { searchEntries, searchReferences: [] };
		}

		async unbind() {
			ldap.calls.push(['unbind']);
		}
	}

	return { ...actual, Client: FakeClient };
});

const BASE_DN = 'dc=example,dc=com';
const ADMIN_DN = 'cn=admin,dc=example,dc=com';

const person = (uid: string, attributes: Entry): Entry => ({
	dn: `uid=${uid},ou=people,${BASE_DN}`,
	uid,
	objectClass: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'],
	...attributes,
});

const guid = (hex: string) => Buffer.from(hex, 'hex');

/** The entries of the directory. Each person has the password `<uid>-pass`. */
const DIRECTORY: Entry[] = [
	person('alice', {
		mail: 'alice@example.com',
		givenName: 'Alice',
		sn: 'Archer',
		objectGUID: guid('0011223344556677889900aabbccddee'),
		objectSid: guid('010500000000000515000000a1b2c3d4'),
	}),
	person('bob', {
		mail: 'bob@example.com',
		givenName: 'Bob',
		sn: 'Baker',
		objectGUID: guid('ffeeddccbbaa00998877665544332211'),
	}),
	person('carol', { mail: 'carol@example.com', givenName: 'Carol', sn: 'Cook' }),
	person('boss', { mail: 'owner@example.com', givenName: 'Olivia', sn: 'Owner' }),
	person('dave', { mail: 'not-an-email', givenName: 'Dave', sn: 'Dunn' }),
	person('erin', { givenName: 'Erin', sn: 'Eames' }),
	person('frank', { mail: 'frank@example.com', givenName: 'Frank', sn: 'Fields' }),
	person('frank2', { mail: 'frank@example.com', givenName: 'Frank', sn: 'Fields' }),
	person('gina', {
		mail: ['gina@example.com', 'gina.alt@example.com'],
		givenName: ['Gina', 'Georgina'],
		sn: 'Gray',
	}),
	{
		...person('hank', { mail: 'hank@example.com', givenName: 'Hank', sn: 'Hill' }),
		objectClass: ['top', 'person'],
	},
	person('ivan', { mail: 'IVAN@Example.COM', givenName: 'Ivan', sn: 'Ivanov' }),
	person('jill', { mail: 'jill@example.com' }),
	person('kate', { mail: 'kate@example.com', givenName: 'Kate', sn: 'King' }),
	person('lena', { mail: 'lena@example.com', givenName: 'Lena', sn: 'Lang' }),
	person('olga', { mail: 'olga@example.com', givenName: 'Olga', sn: 'Olsen' }),
	person('tri1', { mail: 'tri@example.com', givenName: 'Tri', sn: 'One' }),
	person('tri2', { mail: 'tri@example.com', givenName: 'Tri', sn: 'Two' }),
	person('tri3', { mail: 'tri@example.com', givenName: 'Tri', sn: 'Three' }),
	person('uma', { mail: 'uma@example.com', givenName: 'Uma', sn: 'Urban' }),
	{
		dn: 'uid=mike,ou=people,dc=other,dc=com',
		uid: 'mike',
		objectClass: ['top', 'person', 'inetOrgPerson'],
		mail: 'mike@example.com',
		givenName: 'Mike',
		sn: 'Moss',
	},
];

function resetDirectory(entries: Entry[] = DIRECTORY) {
	ldap.entries = entries.map((entry) => ({ ...entry }));
	ldap.passwords = new Map([[ADMIN_DN, 'admin-secret']]);
	for (const entry of ldap.entries) {
		ldap.passwords.set(String(entry.dn), `${String(entry.uid)}-pass`);
	}
	ldap.allowAnonymous = false;
	ldap.failures.clear();
	ldap.calls = [];
}

// #endregion

const testServer = utils.setupTestServer({
	endpointGroups: ['auth', 'ldap'],
	enabledFeatures: ['feat:ldap'],
	modules: ['ldap'],
});

const rec = new GoldenRecorder();
let owner: User;
let ownerAgent: SuperAgentTest;

/** The configuration of the tests. Each test changes some fields. */
const CONFIG: LdapConfig = {
	loginEnabled: true,
	loginLabel: 'Directory login',
	connectionUrl: 'ldap.example.com',
	allowUnauthorizedCerts: false,
	connectionSecurity: 'none',
	connectionPort: 389,
	baseDn: BASE_DN,
	bindingAdminDn: ADMIN_DN,
	bindingAdminPassword: 'admin-secret',
	firstNameAttribute: 'givenName',
	lastNameAttribute: 'sn',
	emailAttribute: 'mail',
	loginIdAttribute: 'mail',
	ldapIdAttribute: 'uid',
	userFilter: '(objectClass=inetOrgPerson)',
	synchronizationEnabled: false,
	synchronizationInterval: 60,
	searchPageSize: 0,
	searchTimeout: 60,
	enforceEmailUniqueness: true,
};

// #region Recording

const events: unknown[][] = [];
// The audit events of the fork (`ForkGovernanceEventRelay`). The original module does not send
// them, so the record leaves them out.
const FORK_AUDIT_EVENTS = new Set<string>(['ldap-settings-saved', 'ldap-synchronized']);
const timers: unknown[][] = [];
const timerHandlers = new Map<unknown, { delay: number; handler: () => unknown }>();

/** A user as its email, for payloads and responses. */
function brief(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(brief);
	if (value !== null && typeof value === 'object') {
		if (value instanceof Date) return value;
		const record = value as Record<string, unknown>;
		if (typeof record.email === 'string' && 'id' in record && 'role' in record) {
			return `<user ${record.email}>`;
		}
		return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, brief(entry)]));
	}
	return value;
}

const service = () => Container.get(LdapService);

type MockedLogger = Record<string, { mock?: { calls: unknown[][] }; mockClear?: () => void }>;

/** The warnings and errors of the logger of the service. */
function takeLogs() {
	const logger = (service() as unknown as { logger: MockedLogger }).logger;
	const result: unknown[] = [];
	for (const level of ['error', 'warn']) {
		const method = logger?.[level];
		if (!method?.mock) continue;
		for (const call of method.mock.calls) {
			// Only the first line: a message can hold a stack trace with the paths of the code.
			result.push([level, rec.labelString(String(call[0]).split('\n')[0])]);
		}
		method.mockClear?.();
	}
	return result;
}

const KNOWN_SECRETS = ['admin-secret', 'new-secret', 'wrong-secret', 'not-encrypted'];

/** A stored secret as its plain value and its format, without the random ciphertext. */
async function describeSecret(value: unknown) {
	if (typeof value !== 'string') return value;
	if (value === '') return '<empty>';
	if (value === CREDENTIAL_BLANKING_VALUE) return '<blanking value>';
	if (KNOWN_SECRETS.includes(value)) return `<plain ${value}>`;
	const cipher = Container.get(Cipher);
	try {
		const plain = await cipher.decryptV2(value);
		const instanceKey = (() => {
			try {
				return cipher.decryptWithInstanceKey(value) === plain;
			} catch {
				return false;
			}
		})();
		return `<encrypted ${plain}${instanceKey ? ', readable with the instance key' : ''}>`;
	} catch {
		return '<unreadable>';
	}
}

/** The users, their LDAP identities and personal projects, the history and the settings. */
async function state() {
	const users = await Container.get(UserRepository).find({ relations: ['authIdentities', 'role'] });
	const personalOwners = await Container.get(ProjectRelationRepository).find({
		where: { role: { slug: 'project:personalOwner' } },
		relations: ['user'],
	});
	const withProject = new Set(personalOwners.map((relation) => relation.user.email));
	const history = await Container.get(AuthProviderSyncHistoryRepository).find({
		order: { id: 'ASC' },
	});
	const stored = await Container.get(SettingsRepository).findOneBy({ key: LDAP_FEATURE_NAME });
	let ldapSetting: unknown = '<none>';
	if (stored) {
		const parsed = JSON.parse(stored.value) as Record<string, unknown>;
		ldapSetting = {
			loadOnStartup: stored.loadOnStartup,
			...parsed,
			bindingAdminPassword: await describeSecret(parsed.bindingAdminPassword),
		};
	}
	const identities = await Container.get(AuthIdentityRepository).find({ relations: ['user'] });
	return {
		users: users
			.map((user) =>
				JSON.stringify({
					email: user.email,
					firstName: user.firstName,
					lastName: user.lastName,
					role: user.role.slug,
					disabled: user.disabled,
					password: user.password ? '<set>' : null,
					personalProject: withProject.has(user.email),
				}),
			)
			.sort(),
		identities: identities
			.map((identity) =>
				JSON.stringify({
					providerType: identity.providerType,
					providerId: identity.providerId,
					user: identity.user?.email ?? null,
				}),
			)
			.sort(),
		history: history.map((row) => JSON.stringify(rec.normalize(row))),
		setting: [JSON.stringify(ldapSetting)],
		authenticationMethod: [String(getCurrentAuthenticationMethod())],
		globalConfig: [JSON.stringify(Container.get(GlobalConfig).sso.ldap)],
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

type Response = { status: number; body: unknown; headers: Record<string, unknown> };

/** The fields of a signed-in user that the test records, besides the names of all fields. */
const USER_FIELDS = [
	'email',
	'firstName',
	'lastName',
	'role',
	'signInType',
	'isPending',
	'disabled',
	'mfaEnabled',
	'settings',
];

function answer(response: Response) {
	const cookie = response.headers['set-cookie'];
	let body = response.body as Record<string, unknown> | undefined;
	const data = body?.data as Record<string, unknown> | undefined;
	if (data && typeof data === 'object' && typeof data.email === 'string' && 'role' in data) {
		body = {
			...body,
			data: {
				'<fields>': Object.keys(data).sort().join(','),
				...Object.fromEntries(
					USER_FIELDS.filter((key) => key in data).map((key) => [key, data[key]]),
				),
			},
		};
	}
	return {
		status: response.status,
		...(cookie ? { cookie: '<set>' } : {}),
		body: rec.normalize(body),
	};
}

let transcript: unknown[] = [];

/** Runs one step and records what it did. */
async function step(name: string, action: () => Promise<unknown>) {
	const before = await state();
	ldap.calls = [];
	events.length = 0;
	timers.length = 0;
	takeLogs();
	let outcome: unknown;
	try {
		const value = await action();
		if (value !== null && typeof value === 'object' && 'status' in value && 'headers' in value) {
			outcome = answer(value as Response);
		} else {
			outcome = value === undefined ? 'done' : { value: rec.normalize(brief(value)) };
		}
	} catch (error) {
		outcome = { threw: rec.describeError(error) };
	}
	const after = await state();
	const entry: Record<string, unknown> = { step: name, outcome };
	if (ldap.calls.length) entry.directory = ldap.calls;
	if (events.length) entry.events = [...events];
	const logs = takeLogs();
	if (logs.length) entry.logs = logs;
	if (timers.length) entry.timers = [...timers];
	const changes = diff(before, after);
	if (Object.keys(changes).length) entry.changes = changes;
	transcript.push(entry);
}

// #endregion

// #region Setup

const put = async (config: object) => await ownerAgent.put('/ldap/config').send(config);

const login = async (emailOrLdapLoginId: string, password: string) =>
	await testServer.authlessAgent.post('/login').send({ emailOrLdapLoginId, password });

/** The users of the instance besides the owner. */
async function resetUsers() {
	await Container.get(AuthIdentityRepository).delete({});
	await Container.get(AuthProviderSyncHistoryRepository).delete({});
	await Container.get(UserRepository).delete({ id: Not(owner.id) });
	await createUser({
		email: 'carol@example.com',
		firstName: 'Carla',
		lastName: 'Cook',
		role: { slug: 'global:member' },
	});
	await createUser({
		email: 'lena@example.com',
		firstName: 'Lena',
		lastName: 'Lang',
		role: { slug: 'global:admin' },
	});
	await createUser({
		email: 'nina@example.com',
		firstName: 'Nina',
		lastName: 'Nash',
		role: { slug: 'global:member' },
	});
	await createLdapUser(
		{
			email: 'bob@example.com',
			firstName: 'Robert',
			lastName: 'Old',
			role: { slug: 'global:member' },
		},
		'bob',
	);
	await createLdapUser(
		{
			email: 'zed@example.com',
			firstName: 'Zed',
			lastName: 'Zane',
			role: { slug: 'global:member' },
		},
		'zed',
	);
	await createLdapUser(
		{
			email: 'kate@example.com',
			firstName: 'Katie',
			lastName: 'Old',
			role: { slug: 'global:member' },
			disabled: true,
		},
		'kate',
	);
	await createLdapUser(
		{
			email: 'frank@example.com',
			firstName: 'Frank',
			lastName: 'Old',
			role: { slug: 'global:member' },
		},
		'frank',
	);
	await createLdapUser(
		{
			email: 'dave@example.com',
			firstName: 'Dave',
			lastName: 'Old',
			role: { slug: 'global:member' },
		},
		'dave',
	);
	await createUser({
		email: 'uma@example.com',
		firstName: 'Uma',
		lastName: 'Old',
		role: { slug: 'global:member' },
		disabled: true,
	});
	await createLdapUser(
		{
			email: 'olga.old@example.com',
			firstName: 'Olga',
			lastName: 'Old',
			role: { slug: 'global:member' },
		},
		'olga',
	);
}

/**
 * A clean instance: the fixture users, the default LDAP configuration (as the migration stores
 * it), email sign-in and the directory.
 */
async function reset() {
	service().stopSync();
	await setCurrentAuthenticationMethod('email');
	await Container.get(SettingsRepository).save({
		key: LDAP_FEATURE_NAME,
		value: JSON.stringify(LDAP_DEFAULT_CONFIGURATION),
		loadOnStartup: true,
	});
	await resetUsers();
	resetDirectory();
	timerHandlers.clear();
	transcript = [];
}

beforeAll(async () => {
	owner = await createUser({
		email: 'owner@example.com',
		firstName: 'Olivia',
		lastName: 'Owner',
		role: GLOBAL_OWNER_ROLE,
	});
	rec.label(owner.id, 'owner');
	ownerAgent = testServer.authAgentFor(owner);
});

// The test config restores all spies before each test, so each test sets them again.
beforeEach(() => {
	const eventService = Container.get(EventService);
	const emit = eventService.emit.bind(eventService);
	vi.spyOn(eventService, 'emit').mockImplementation((name, ...payload) => {
		if (!FORK_AUDIT_EVENTS.has(name)) {
			events.push([name, ...payload.map((entry) => rec.normalize(brief(entry)))]);
		}
		return emit(name, ...payload);
	});

	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, 'setInterval').mockImplementation(((
		handler: () => unknown,
		delay?: number,
		...args: unknown[]
	) => {
		const handle = realSetInterval(handler, delay, ...args);
		if (typeof delay === 'number' && delay >= 60_000) {
			timers.push(['setInterval', delay]);
			timerHandlers.set(handle, { delay, handler });
		}
		return handle;
	}) as typeof setInterval);
	vi.spyOn(globalThis, 'clearInterval').mockImplementation(((handle?: NodeJS.Timeout) => {
		const known = timerHandlers.get(handle);
		if (known) {
			timers.push(['clearInterval', known.delay]);
			timerHandlers.delete(handle);
		}
		realClearInterval(handle);
	}) as typeof clearInterval);
	vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		handler: () => unknown,
		delay?: number,
		...args: unknown[]
	) => {
		// Other code (the database and the HTTP server) sets many timeouts of one minute.
		if (typeof delay === 'number' && delay > 60_000) timers.push(['setTimeout', delay]);
		return realSetTimeout(handler, delay, ...args);
	}) as typeof setTimeout);
});

afterAll(() => {
	service().stopSync();
	vi.restoreAllMocks();
});

/** Waits until the history has more rows than before, or one second passed. */
async function waitForHistory(count: number) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await Container.get(AuthProviderSyncHistoryRepository).count()) > count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Stores a configuration in the settings row, without the service. */
async function store(config: object) {
	await Container.get(SettingsRepository).update(
		{ key: LDAP_FEATURE_NAME },
		{ value: JSON.stringify(config) },
	);
}

/** Runs the newest timer with the delay, and waits for the synchronization that it starts. */
async function fireTimer(delay: number) {
	const scheduled = [...timerHandlers.values()].filter((timer) => timer.delay === delay);
	const count = await Container.get(AuthProviderSyncHistoryRepository).count();
	const result: unknown = await scheduled.at(-1)?.handler();
	if (scheduled.length) await waitForHistory(count);
	return { timers: scheduled.length, result: result === undefined ? '<undefined>' : 'value' };
}

// #endregion

describe('LDAP', () => {
	test('the configuration', async () => {
		await reset();
		await step('the logger of the service', async () => ({
			root: (service() as unknown as { logger: unknown }).logger === Container.get(Logger),
		}));
		await step('init with the default configuration', async () => await service().init());
		await step('GET /ldap/config', async () => await ownerAgent.get('/ldap/config'));
		await step('PUT a configuration', async () => await put(CONFIG));
		await step('GET /ldap/config', async () => await ownerAgent.get('/ldap/config'));
		await step(
			'PUT the blanking value as the password',
			async () => await put({ ...CONFIG, bindingAdminPassword: CREDENTIAL_BLANKING_VALUE }),
		);
		await step(
			'PUT the answer of GET',
			async () => await put((await ownerAgent.get('/ldap/config')).body.data),
		);
		await step(
			'PUT an empty password',
			async () => await put({ ...CONFIG, bindingAdminPassword: '' }),
		);
		await step(
			'GET /ldap/config with an empty password',
			async () => await ownerAgent.get('/ldap/config'),
		);
		await step(
			'PUT a new password and label',
			async () =>
				await put({ ...CONFIG, bindingAdminPassword: 'new-secret', loginLabel: 'Other label' }),
		);
		await step(
			'PUT with the synchronization on',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 15 }),
		);
		await step(
			'PUT the same again',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 15 }),
		);
		await step(
			'PUT another interval',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 30 }),
		);
		await step('PUT with the synchronization off', async () => await put(CONFIG));
		await step(
			'PUT with the login off while LDAP users exist',
			async () => await put({ ...CONFIG, loginEnabled: false }),
		);
		await step(
			'PUT with the login off again',
			async () => await put({ ...CONFIG, loginEnabled: false }),
		);
		await step('PUT with the login on again', async () => await put(CONFIG));
		await step('PUT with the login on again, same values', async () => await put(CONFIG));
		await step('init with the stored configuration', async () => await service().init());
		await step('init while email is the sign-in method', async () => {
			await setCurrentAuthenticationMethod('email');
			Container.get(GlobalConfig).sso.ldap.loginEnabled = false;
			Container.get(GlobalConfig).sso.ldap.loginLabel = '';
			return await service().init();
		});
		await step('PUT with the login on while SAML is the sign-in method', async () => {
			await setCurrentAuthenticationMethod('saml');
			return await put(CONFIG);
		});
		await step('init while SAML is the sign-in method', async () => await service().init());
		await step('init while SAML is the sign-in method, other global values', async () => {
			Container.get(GlobalConfig).sso.ldap.loginEnabled = false;
			Container.get(GlobalConfig).sso.ldap.loginLabel = 'stale';
			return await service().init();
		});
		await step(
			'PUT with the login off while SAML is the sign-in method',
			async () => await put({ ...CONFIG, loginEnabled: false }),
		);
		await step(
			'PUT with the login off while SAML is the sign-in method and LDAP users exist',
			async () => {
				const nina = await Container.get(UserRepository).findOneByOrFail({
					email: 'nina@example.com',
				});
				await Container.get(AuthIdentityRepository).save(
					Container.get(AuthIdentityRepository).create({
						providerId: 'nina',
						providerType: 'ldap',
						userId: nina.id,
					}),
				);
				return await put({ ...CONFIG, loginEnabled: false });
			},
		);
		await step('init with the login off while LDAP is the sign-in method', async () => {
			await setCurrentAuthenticationMethod('ldap');
			Container.get(GlobalConfig).sso.ldap.loginEnabled = true;
			return await service().init();
		});
		await step('PUT with the login on while OIDC is the sign-in method', async () => {
			await setCurrentAuthenticationMethod('oidc');
			return await put(CONFIG);
		});
		await setCurrentAuthenticationMethod('ldap');
		await step('loadConfig', async () => {
			const config = await service().loadConfig();
			return { ...config, bindingAdminPassword: await describeSecret(config.bindingAdminPassword) };
		});
		await step('updateConfig with a valid configuration', async () => {
			await service().updateConfig({ ...CONFIG, loginLabel: 'Direct' });
			const config = await service().loadConfig();
			return { ...config, bindingAdminPassword: await describeSecret(config.bindingAdminPassword) };
		});
		await step(
			'updateConfig with an extra property',
			async () => await service().updateConfig({ ...CONFIG, extra: true } as LdapConfig),
		);
		await step('updateConfig with a missing property', async () => {
			const { searchTimeout: _, ...rest } = CONFIG;
			return await service().updateConfig(rest as LdapConfig);
		});
		await step(
			'updateConfig with a wrong type',
			async () =>
				await service().updateConfig({ ...CONFIG, connectionPort: '389' } as unknown as LdapConfig),
		);
		await step('a stored password that is not encrypted', async () => {
			await store({ ...CONFIG, bindingAdminPassword: 'not-encrypted' });
			const config = await service().loadConfig();
			return { ...config, bindingAdminPassword: await describeSecret(config.bindingAdminPassword) };
		});
		await step(
			'GET /ldap/config with that password',
			async () => await ownerAgent.get('/ldap/config'),
		);
		await step('a stored password that is long and not encrypted', async () => {
			await store({ ...CONFIG, bindingAdminPassword: 'a-much-longer-plain-text-password-value' });
			const config = await service().loadConfig();
			return { ...config, bindingAdminPassword: await describeSecret(config.bindingAdminPassword) };
		});
		await step('updateConfig with the login on while SAML is the sign-in method', async () => {
			await setCurrentAuthenticationMethod('saml');
			try {
				return await service().updateConfig({ ...CONFIG });
			} finally {
				await setCurrentAuthenticationMethod('ldap');
			}
		});
		await step('a stored configuration with a missing field', async () => {
			const { userFilter: _, ...rest } = CONFIG;
			await store({ ...rest, bindingAdminPassword: '' });
			const config = await service().loadConfig();
			return { ...config, bindingAdminPassword: await describeSecret(config.bindingAdminPassword) };
		});
		expect(transcript).toMatchSnapshot();
	});

	// About 170 requests, which take close to the default timeout of 10 seconds.
	test('the validation of the configuration', async () => {
		await reset();
		await put(CONFIG);
		transcript = [];
		const invalid: Array<[string, unknown]> = [
			['an extra property', { ...CONFIG, extra: true }],
			['loginEnabled as a string', { ...CONFIG, loginEnabled: 'yes' }],
			['loginLabel as a number', { ...CONFIG, loginLabel: 5 }],
			['connectionPort as a string', { ...CONFIG, connectionPort: '389' }],
			['connectionPort with a fraction', { ...CONFIG, connectionPort: 389.5 }],
			['connectionPort 0', { ...CONFIG, connectionPort: 0 }],
			['connectionPort 70000', { ...CONFIG, connectionPort: 70000 }],
			['an unknown connectionSecurity', { ...CONFIG, connectionSecurity: 'ssl' }],
			['synchronizationInterval 0', { ...CONFIG, synchronizationInterval: 0 }],
			['synchronizationInterval with a fraction', { ...CONFIG, synchronizationInterval: 1.5 }],
			['searchPageSize -1', { ...CONFIG, searchPageSize: -1 }],
			['searchTimeout 0', { ...CONFIG, searchTimeout: 0 }],
			['a long loginLabel', { ...CONFIG, loginLabel: 'x'.repeat(300) }],
			['an empty connectionUrl', { ...CONFIG, connectionUrl: '' }],
			['a connectionUrl with a protocol', { ...CONFIG, connectionUrl: 'ldap://ldap.example.com' }],
			['an empty baseDn', { ...CONFIG, baseDn: '' }],
			['a userFilter without parentheses', { ...CONFIG, userFilter: 'objectClass=person' }],
			['an invalid userFilter', { ...CONFIG, userFilter: '(&(objectClass=person)' }],
			['two wrong types', { ...CONFIG, loginEnabled: 1, searchTimeout: '60' }],
			[
				'a wrong type and a missing property',
				(({ baseDn: _, ...rest }) => ({ ...rest, loginEnabled: 1 }))(CONFIG),
			],
			['an array', [CONFIG]],
			['a string', '"config"'],
			['an empty object', {}],
		];
		for (const key of Object.keys(CONFIG) as Array<keyof LdapConfig>) {
			invalid.push([`without ${key}`, (({ [key]: _, ...rest }) => rest)(CONFIG)]);
			invalid.push([`${key} as null`, { ...CONFIG, [key]: null }]);
			invalid.push([`${key} as an object`, { ...CONFIG, [key]: {} }]);
		}
		for (const [name, body] of invalid) {
			await put(CONFIG);
			await step(`PUT ${name}`, async () =>
				typeof body === 'string'
					? await ownerAgent.put('/ldap/config').set('Content-Type', 'application/json').send(body)
					: await ownerAgent.put('/ldap/config').send(body as object),
			);
		}
		expect(transcript).toMatchSnapshot();
	}, 60_000);

	test('the access to the routes', async () => {
		await reset();
		await put(CONFIG);
		transcript = [];
		const admin = await Container.get(UserRepository).findOneByOrFail({
			email: 'lena@example.com',
		});
		const member = await Container.get(UserRepository).findOneByOrFail({
			email: 'nina@example.com',
		});
		const chatUser = await createUser({
			email: 'chat@example.com',
			role: { slug: 'global:chatUser' },
		});
		const agents: Array<[string, SuperAgentTest]> = [
			['admin', testServer.authAgentFor(admin)],
			['member', testServer.authAgentFor(member)],
			['chat user', testServer.authAgentFor(chatUser)],
		];
		for (const [name, agent] of agents) {
			await step(`${name}: GET /ldap/config`, async () => await agent.get('/ldap/config'));
			await step(
				`${name}: PUT /ldap/config`,
				async () => await agent.put('/ldap/config').send(CONFIG),
			);
			await step(
				`${name}: POST /ldap/test-connection`,
				async () => await agent.post('/ldap/test-connection'),
			);
			await step(
				`${name}: POST /ldap/sync`,
				async () => await agent.post('/ldap/sync').send({ type: 'dry' }),
			);
			await step(`${name}: GET /ldap/sync`, async () => await agent.get('/ldap/sync'));
		}
		await step(
			'no session: GET /ldap/config',
			async () => await testServer.authlessAgent.get('/ldap/config'),
		);
		testServer.license.disable('feat:ldap');
		await step(
			'without the licence: GET /ldap/config',
			async () => await ownerAgent.get('/ldap/config'),
		);
		await step('without the licence: PUT /ldap/config', async () => await put(CONFIG));
		await step(
			'without the licence: POST /ldap/test-connection',
			async () => await ownerAgent.post('/ldap/test-connection'),
		);
		await step(
			'without the licence: POST /ldap/sync',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }),
		);
		await step(
			'without the licence: GET /ldap/sync',
			async () => await ownerAgent.get('/ldap/sync'),
		);
		testServer.license.enable('feat:ldap');
		expect(transcript).toMatchSnapshot();
	});

	test('the test of the connection', async () => {
		await reset();
		const cases: Array<[string, Partial<LdapConfig>, (() => void)?]> = [
			['no security', {}],
			['TLS', { connectionSecurity: 'tls', connectionPort: 636 }],
			[
				'TLS without a check of the certificate',
				{ connectionSecurity: 'tls', connectionPort: 636, allowUnauthorizedCerts: true },
			],
			['STARTTLS', { connectionSecurity: 'startTls' }],
			[
				'STARTTLS without a check of the certificate',
				{ connectionSecurity: 'startTls', allowUnauthorizedCerts: true },
			],
			['an unknown security', { connectionSecurity: 'ssl' as LdapConfig['connectionSecurity'] }],
			['a custom port and timeout', { connectionPort: 10389, searchTimeout: 7 }],
			['a host with a protocol', { connectionUrl: 'ldaps://ldap.example.com' }],
			[
				'an anonymous binding',
				{ bindingAdminDn: '', bindingAdminPassword: '' },
				() => {
					ldap.allowAnonymous = true;
				},
			],
			[
				'an anonymous binding that the server refuses',
				{ bindingAdminDn: '', bindingAdminPassword: '' },
			],
			['a binding DN without a password', { bindingAdminPassword: '' }],
			['a wrong password', { bindingAdminPassword: 'wrong-secret' }],
			['a server that does not answer', {}, () => ldap.failures.set('bind', 'unreachable')],
			[
				'a failed STARTTLS',
				{ connectionSecurity: 'startTls' },
				() => ldap.failures.set('startTLS', 'unreachable'),
			],
			['a server that refuses the binding', {}, () => ldap.failures.set('bind', 'refused')],
			['the login off', { loginEnabled: false }],
		];
		for (const [name, change, prepare] of cases) {
			resetDirectory();
			await put({ ...CONFIG, ...change });
			prepare?.();
			await step(name, async () => await ownerAgent.post('/ldap/test-connection'));
		}
		resetDirectory();
		await put({ ...CONFIG, connectionSecurity: 'startTls' });
		ldap.failures.set('startTLS', 'unreachable');
		await step(
			'a failed STARTTLS, then',
			async () => await ownerAgent.post('/ldap/test-connection'),
		);
		ldap.failures.clear();
		await step(
			'a test without the failure',
			async () => await ownerAgent.post('/ldap/test-connection'),
		);
		resetDirectory();
		await put(CONFIG);
		ldap.failures.set('bind', 'unreachable');
		await step(
			'a server that does not answer, then',
			async () => await ownerAgent.post('/ldap/test-connection'),
		);
		ldap.failures.clear();
		await step(
			'a test when the server answers again',
			async () => await ownerAgent.post('/ldap/test-connection'),
		);
		resetDirectory();
		await put(CONFIG);
		await step(
			'two tests in a row: the first',
			async () => await ownerAgent.post('/ldap/test-connection'),
		);
		await step(
			'two tests in a row: the second',
			async () => await ownerAgent.post('/ldap/test-connection'),
		);
		await step(
			'a sign-in after the tests',
			async () => await login('alice@example.com', 'alice-pass'),
		);
		await step('testConnection', async () => await service().testConnection());
		expect(transcript).toMatchSnapshot();
	});

	test('the synchronization', async () => {
		await reset();
		await put(CONFIG);
		transcript = [];
		await step('a dry run', async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }));
		await step(
			'a live run',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'live' }),
		);
		await step(
			'a second live run',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'live' }),
		);
		await step('changes in the directory, then a live run', async () => {
			ldap.entries = ldap.entries
				.filter((entry) => entry.uid !== 'gina' && entry.uid !== 'bob')
				.map((entry) =>
					entry.uid === 'alice'
						? { ...entry, sn: 'Allen', mail: 'alice.allen@example.com' }
						: entry.uid === 'carol'
							? { ...entry, givenName: 'Caroline' }
							: entry,
				);
			return await ownerAgent.post('/ldap/sync').send({ type: 'live' });
		});
		await step('bob and gina come back, then a live run', async () => {
			resetDirectory();
			return await ownerAgent.post('/ldap/sync').send({ type: 'live' });
		});
		await step('a run without a type', async () => await ownerAgent.post('/ldap/sync').send({}));
		await step(
			'a run with an unknown type',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'full' }),
		);
		await step('a server that does not answer', async () => {
			ldap.failures.set('bind', 'unreachable');
			return await ownerAgent.post('/ldap/sync').send({ type: 'live' });
		});
		await step('a failed search', async () => {
			ldap.failures.clear();
			ldap.failures.set('search', 'refused');
			return await ownerAgent.post('/ldap/sync').send({ type: 'live' });
		});
		ldap.failures.clear();
		await put({ ...CONFIG, bindingAdminPassword: 'wrong-secret' });
		await step(
			'a wrong password',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'live' }),
		);
		await put({ ...CONFIG, userFilter: '', searchPageSize: 2, searchTimeout: 9 });
		await step(
			'no user filter, paged',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }),
		);
		await put({ ...CONFIG, loginIdAttribute: 'uid' });
		await step(
			'the login ID uid',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }),
		);
		await put({ ...CONFIG, connectionSecurity: 'startTls' });
		await step('STARTTLS', async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }));
		await put({ ...CONFIG, enforceEmailUniqueness: false });
		await step(
			'the uniqueness off, a dry run',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }),
		);
		await step('the uniqueness off, a live run', async () => {
			// Three new users with one email would race for it, so one of them stays.
			ldap.entries = ldap.entries.filter((entry) => entry.uid !== 'tri2' && entry.uid !== 'tri3');
			return await ownerAgent.post('/ldap/sync').send({ type: 'live' });
		});
		resetDirectory();
		await put(CONFIG);
		// Without the identities of the duplicates, the failed write is the only change of the run.
		// The original writes in parallel, so other writes could end after the answer.
		for (const ldapId of ['frank', 'frank2', 'tri1']) {
			await Container.get(AuthIdentityRepository).delete({
				providerId: ldapId,
				providerType: 'ldap',
			});
		}
		await step('alice takes the email of an email user, then a live run', async () => {
			ldap.entries = ldap.entries.map((entry) =>
				entry.uid === 'alice' ? { ...entry, mail: 'nina@example.com' } : entry,
			);
			return await ownerAgent.post('/ldap/sync').send({ type: 'live' });
		});
		resetDirectory();
		await put({ ...CONFIG, loginEnabled: false });
		await step(
			'the login off',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }),
		);
		await step('GET /ldap/sync', async () => await ownerAgent.get('/ldap/sync'));
		await step(
			'GET /ldap/sync, page 0 of 2',
			async () => await ownerAgent.get('/ldap/sync?page=0&perPage=2'),
		);
		await step(
			'GET /ldap/sync, page 1 of 2',
			async () => await ownerAgent.get('/ldap/sync?page=1&perPage=2'),
		);
		await step(
			'GET /ldap/sync, page 9 of 2',
			async () => await ownerAgent.get('/ldap/sync?page=9&perPage=2'),
		);
		await step('GET /ldap/sync, page 1', async () => await ownerAgent.get('/ldap/sync?page=1'));
		await step(
			'GET /ldap/sync, perPage 3',
			async () => await ownerAgent.get('/ldap/sync?perPage=3'),
		);
		await step(
			'GET /ldap/sync, page -1',
			async () => await ownerAgent.get('/ldap/sync?page=-1&perPage=2'),
		);
		await step(
			'GET /ldap/sync, perPage 0',
			async () => await ownerAgent.get('/ldap/sync?perPage=0'),
		);
		await step(
			'GET /ldap/sync, perPage abc',
			async () => await ownerAgent.get('/ldap/sync?perPage=abc'),
		);
		await step(
			'GET /ldap/sync, page abc',
			async () => await ownerAgent.get('/ldap/sync?page=abc&perPage=2'),
		);
		await step(
			'GET /ldap/sync, page 1.5',
			async () => await ownerAgent.get('/ldap/sync?page=1.5&perPage=2'),
		);
		await step(
			'GET /ldap/sync, perPage 2abc',
			async () => await ownerAgent.get('/ldap/sync?perPage=2abc'),
		);
		await step(
			'GET /ldap/sync, perPage empty',
			async () => await ownerAgent.get('/ldap/sync?perPage='),
		);
		await step(
			'GET /ldap/sync, perPage -2',
			async () => await ownerAgent.get('/ldap/sync?perPage=-2'),
		);
		await step(
			'GET /ldap/sync, page 1 of -2',
			async () => await ownerAgent.get('/ldap/sync?page=1&perPage=-2'),
		);
		await step('GET /ldap/sync with 30 rows', async () => {
			const repository = Container.get(AuthProviderSyncHistoryRepository);
			for (let index = 0; index < 30; index++) {
				await repository.save(
					repository.create({
						providerType: 'ldap',
						runMode: 'dry',
						status: 'success',
						startedAt: new Date('2026-01-01T00:00:00.000Z'),
						endedAt: new Date('2026-01-01T00:00:01.000Z'),
						scanned: index,
						created: 0,
						updated: 0,
						disabled: 0,
						error: '',
					}),
				);
			}
			const response = await ownerAgent.get('/ldap/sync');
			const rows = (response.body as { data: Array<{ scanned: number }> }).data;
			return {
				status: response.status,
				count: rows.length,
				scanned: rows.map((row) => row.scanned),
			};
		});
		await step('runSync live', async () => {
			await put(CONFIG);
			return await service().runSync('live');
		});
		await step('runSync with a failed search', async () => {
			ldap.failures.set('search', 'refused');
			return await service().runSync('live');
		});
		await step('runSync with a server that does not answer', async () => {
			ldap.failures.clear();
			ldap.failures.set('bind', 'unreachable');
			return await service().runSync('dry');
		});
		await step('runSync with a wrong password', async () => {
			ldap.failures.clear();
			await put({ ...CONFIG, bindingAdminPassword: 'wrong-secret' });
			return await service().runSync('dry');
		});
		expect(transcript).toMatchSnapshot();
	});

	test('the binary attributes', async () => {
		await reset();
		// Only the entries with an objectGUID, and no LDAP users, so that each run does one known thing.
		await Container.get(AuthIdentityRepository).delete({});
		const withGuid = DIRECTORY.filter((entry) => entry.objectGUID !== undefined);
		resetDirectory(withGuid);
		await put({ ...CONFIG, ldapIdAttribute: 'objectGUID' });
		transcript = [];
		await step('a dry run', async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }));
		await step(
			'a live run',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'live' }),
		);
		await step('a sign-in', async () => await login('alice@example.com', 'alice-pass'));
		// A synchronization with an entry without the LDAP ID differs on purpose: the original fails
		// the run, and the fork skips the entry (see README.md). Only the sign-in is recorded.
		resetDirectory([
			...withGuid,
			person('nora', { mail: 'nora@example.com', givenName: 'Nora', sn: 'North' }),
		]);
		await step(
			'a sign-in without the attribute',
			async () => await login('nora@example.com', 'nora-pass'),
		);
		resetDirectory(withGuid);
		await put({ ...CONFIG, ldapIdAttribute: 'objectSid' });
		await step(
			'a sign-in with objectSid',
			async () => await login('alice@example.com', 'alice-pass'),
		);
		await put({ ...CONFIG, loginIdAttribute: 'objectGUID' });
		await step(
			'a sign-in with objectGUID as the login ID',
			async () => await login('0011223344556677889900aabbccddee', 'alice-pass'),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the email checks', async () => {
		await reset();
		// A directory with emails that the checks may treat in different ways. Only dry runs and
		// single sign-ins, so that a failed write cannot leave a partial state.
		resetDirectory([
			...DIRECTORY,
			person('pat', { mail: 'Pat@example.com', givenName: 'Pat', sn: 'Park' }),
			person('pat2', { mail: 'pat@EXAMPLE.com', givenName: 'Patricia', sn: 'Park' }),
			person('quinn', { mail: 'quinn@localhost', givenName: 'Quinn', sn: 'Quill' }),
			person('ross', { mail: 'ross+tag@example.co.uk', givenName: 'Ross', sn: 'Reed' }),
			person('sam', { mail: 'sam@example', givenName: 'Sam', sn: 'Stone' }),
			person('tom', { mail: 'tom!x@example.com', givenName: 'Tom', sn: 'Tate' }),
			person('jose', { mail: 'jos\u00e9@example.com', givenName: 'Jose', sn: 'Jara' }),
			person('vic', { mail: 'vic@example.c', givenName: 'Vic', sn: 'Vale' }),
			person('wes', { mail: ' wes@example.com', givenName: 'Wes', sn: 'West' }),
			person('nina', { mail: 'NINA@example.com', givenName: 'Nina', sn: 'Noble' }),
		]);
		await put(CONFIG);
		transcript = [];
		await step('a dry run', async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }));
		await put({ ...CONFIG, enforceEmailUniqueness: false });
		await step(
			'a dry run without the uniqueness',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }),
		);
		await put(CONFIG);
		const attempts: Array<[string, string, string]> = [
			['two entries with one email in other cases', 'Pat@example.com', 'pat2-pass'],
			['an email without a top-level domain', 'quinn@localhost', 'quinn-pass'],
			['an email with a tag', 'ross+tag@example.co.uk', 'ross-pass'],
			['an email without a dot in the domain', 'sam@example', 'sam-pass'],
			['an email with a special character', 'tom!x@example.com', 'tom-pass'],
			['an email with an accent', 'jos\u00e9@example.com', 'jose-pass'],
			['a top-level domain of one letter', 'vic@example.c', 'vic-pass'],
			['an email with a space', ' wes@example.com', 'wes-pass'],
			['an email user in another case', 'NINA@example.com', 'nina-pass'],
		];
		for (const [name, loginId, password] of attempts) {
			await step(name, async () => await login(loginId, password));
		}
		await put({ ...CONFIG, loginIdAttribute: 'uid' });
		await step(
			'a sign-in by uid with an email with a space',
			async () => await login('wes', 'wes-pass'),
		);
		await put({ ...CONFIG, emailAttribute: 'description' });
		await step(
			'another email attribute',
			async () => await login('alice@example.com', 'alice-pass'),
		);
		expect(transcript).toMatchSnapshot();
	});

	// More than 50 sign-ins, which take close to the default timeout of 10 seconds.
	test('the sign-in', async () => {
		await reset();
		await put(CONFIG);
		transcript = [];
		const attempts: Array<[string, string, string, (() => Promise<unknown>)?]> = [
			['a new user', 'alice@example.com', 'alice-pass'],
			['the same user again', 'alice@example.com', 'alice-pass'],
			['a wrong password', 'alice@example.com', 'wrong'],
			['an unknown user', 'unknown@example.com', 'unknown-pass'],
			['an email user', 'carol@example.com', 'carol-pass'],
			['an email user with the n8n password', 'nina@example.com', 'password'],
			['the owner with the n8n password', 'owner@example.com', 'password'],
			['the owner with the directory password', 'owner@example.com', 'boss-pass'],
			['the owner with the directory password again', 'owner@example.com', 'boss-pass'],
			['an LDAP user with new names', 'bob@example.com', 'bob-pass'],
			['an LDAP user with the n8n password', 'bob@example.com', 'password'],
			['a disabled LDAP user who is back', 'kate@example.com', 'kate-pass'],
			['an LDAP user who is not in the directory', 'zed@example.com', 'zed-pass'],
			['an LDAP user with a new email', 'olga@example.com', 'olga-pass'],
			['an admin', 'lena@example.com', 'lena-pass'],
			['a disabled user without an identity', 'uma@example.com', 'uma-pass'],
			['an invalid email', 'not-an-email', 'dave-pass'],
			['two entries with one email', 'frank@example.com', 'frank-pass'],
			[
				'two entries with one email, the password of the second',
				'frank@example.com',
				'frank2-pass',
			],
			['three entries with one email, the first password', 'tri@example.com', 'tri1-pass'],
			['three entries with one email, the last password', 'tri@example.com', 'tri3-pass'],
			['several values', 'gina@example.com', 'gina-pass'],
			['the second value', 'gina.alt@example.com', 'gina-pass'],
			['another case', 'ivan@example.com', 'ivan-pass'],
			['the login ID in another case', 'ALICE@example.com', 'alice-pass'],
			['no names', 'jill@example.com', 'jill-pass'],
			['outside the user filter', 'hank@example.com', 'hank-pass'],
			['outside the base', 'mike@example.com', 'mike-pass'],
			['a filter in the login', 'alice@example.com)(uid=*', 'alice-pass'],
			['a wildcard', '*', 'alice-pass'],
			['special characters', 'a\\b(c)*d\u0000e@example.com', 'x'],
			['an empty password', 'alice@example.com', ''],
			[
				'a server that does not answer',
				'alice@example.com',
				'alice-pass',
				async () => ldap.failures.set('bind', 'unreachable'),
			],
			[
				'a failed search',
				'alice@example.com',
				'alice-pass',
				async () => {
					ldap.failures.clear();
					ldap.failures.set('search', 'refused');
				},
			],
			[
				'the uniqueness off',
				'frank@example.com',
				'frank-pass',
				async () => {
					ldap.failures.clear();
					await put({ ...CONFIG, enforceEmailUniqueness: false });
				},
			],
			['the uniqueness off, the password of the second', 'frank@example.com', 'frank2-pass'],
			[
				'STARTTLS',
				'alice@example.com',
				'alice-pass',
				async () => await put({ ...CONFIG, connectionSecurity: 'startTls' }),
			],
			[
				'STARTTLS for a new user',
				'ivan@example.com',
				'ivan-pass',
				async () => {
					const ivan = await Container.get(UserRepository).findOneByOrFail({
						email: 'ivan@example.com',
					});
					await Container.get(AuthIdentityRepository).delete({ userId: ivan.id });
					await Container.get(UserRepository).delete({ id: ivan.id });
				},
			],
			[
				'no user filter',
				'hank@example.com',
				'hank-pass',
				async () => await put({ ...CONFIG, userFilter: '' }),
			],
			[
				'a login by uid',
				'erin',
				'erin-pass',
				async () => await put({ ...CONFIG, loginIdAttribute: 'uid' }),
			],
			['a login by uid with an email', 'alice', 'alice-pass'],
			['a login by uid for a new user', 'lena', 'lena-pass'],
			[
				'an LDAP user with an invalid new email',
				'bob',
				'bob-pass',
				async () => {
					ldap.entries = ldap.entries.map((entry) =>
						entry.uid === 'bob' ? { ...entry, mail: 'bob-at-example' } : entry,
					);
				},
			],
			[
				'an LDAP user without an email',
				'olga',
				'olga-pass',
				async () => {
					resetDirectory();
					ldap.entries = ldap.entries.map((entry) => {
						if (entry.uid !== 'olga') return entry;
						const { mail: _, ...rest } = entry;
						return rest;
					});
				},
			],
			['an email as the login by uid', 'alice@example.com', 'alice-pass'],
			[
				'other attribute names',
				'carol@example.com',
				'carol-pass',
				async () => {
					resetDirectory();
					await put({ ...CONFIG, firstNameAttribute: 'sn', lastNameAttribute: 'givenName' });
				},
			],
			[
				'without the licence',
				'alice@example.com',
				'alice-pass',
				async () => {
					await put(CONFIG);
					testServer.license.disable('feat:ldap');
				},
			],
			[
				'the login off',
				'alice@example.com',
				'alice-pass',
				async () => {
					testServer.license.enable('feat:ldap');
					await put({ ...CONFIG, loginEnabled: false });
				},
			],
			['the owner with the login off', 'owner@example.com', 'password'],
			['a former LDAP user with the n8n password', 'bob@example.com', 'password'],
		];
		for (const [name, loginId, password, prepare] of attempts) {
			await prepare?.();
			await step(name, async () => await login(loginId, password));
		}
		await step('handleLogin', async () => {
			await put(CONFIG);
			return await service().handleLogin('alice@example.com', 'alice-pass');
		});
		await step('handleLogin with the login off', async () => {
			await put({ ...CONFIG, loginEnabled: false });
			return await service().handleLogin('alice@example.com', 'alice-pass');
		});
		expect(transcript).toMatchSnapshot();
	}, 60_000);

	test('the scheduled synchronization', async () => {
		await reset();
		const instanceSettings = Container.get(InstanceSettings);
		await step('the role of the instance', async () => ({ role: instanceSettings.instanceRole }));
		await step(
			'PUT with the synchronization on',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 5 }),
		);
		await step('the timer fires', async () => await fireTimer(300_000));
		await step('init', async () => await service().init());
		await step('stopSync', async () => service().stopSync());
		instanceSettings.markAsLeader();
		await step(
			'as the leader: PUT with the synchronization on',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 6 }),
		);
		await step('as the leader: the timer fires', async () => await fireTimer(360_000));
		await step(
			'as the leader: PUT the same again',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 6 }),
		);
		await step('as the leader: init', async () => await service().init());
		await step('as the leader: stopSync', async () => service().stopSync());
		await step('as the leader: stopSync again', async () => service().stopSync());
		await step('as the leader: init again', async () => await service().init());
		await step('as the leader: PUT with the synchronization off', async () => await put(CONFIG));
		await step(
			'as the leader: PUT with the synchronization on and the login off',
			async () =>
				await put({
					...CONFIG,
					loginEnabled: false,
					synchronizationEnabled: true,
					synchronizationInterval: 7,
				}),
		);
		await step(
			'as the leader: the timer fires with the login off',
			async () => await fireTimer(420_000),
		);
		await step('as the leader: init without the licence', async () => {
			service().stopSync();
			testServer.license.disable('feat:ldap');
			try {
				return await service().init();
			} finally {
				testServer.license.enable('feat:ldap');
			}
		});
		await step(
			'as the leader: PUT with the synchronization on again',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 10 }),
		);
		await step(
			'as the leader: a manual dry run while the timer runs',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'dry' }),
		);
		await step(
			'as the leader: a manual live run while the timer runs',
			async () => await ownerAgent.post('/ldap/sync').send({ type: 'live' }),
		);
		await step('as the leader: init without the licence, with the synchronization on', async () => {
			testServer.license.disable('feat:ldap');
			try {
				return await service().init();
			} finally {
				testServer.license.enable('feat:ldap');
			}
		});
		await step('as the leader: init with the licence again', async () => await service().init());
		await step('as the leader: PUT while SAML is the sign-in method', async () => {
			await setCurrentAuthenticationMethod('saml');
			try {
				return await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 11 });
			} finally {
				await setCurrentAuthenticationMethod('ldap');
			}
		});
		await step(
			'as the leader: PUT with the login off while the timer runs',
			async () =>
				await put({
					...CONFIG,
					loginEnabled: false,
					synchronizationEnabled: true,
					synchronizationInterval: 12,
				}),
		);
		await step(
			'as the leader: PUT with the login off and the synchronization off',
			async () => await put({ ...CONFIG, loginEnabled: false }),
		);
		// Fork: the timer logs a failed run, where the original lets the error escape. See
		// "Differences from the original" in the README of the module.
		await step('as the leader: the timer fires with a failed search', async () => {
			await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 8 });
			ldap.failures.set('search', 'refused');
			const count = await Container.get(AuthProviderSyncHistoryRepository).count();
			const scheduled = [...timerHandlers.values()].filter((timer) => timer.delay === 480_000);
			await scheduled.at(-1)?.handler();
			await waitForHistory(count);
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { timers: scheduled.length };
		});
		ldap.failures.clear();
		await step('as the leader: stopSync', async () => service().stopSync());
		// Fork: a follower starts the timer, as the original does, but skips the run when the timer
		// fires. See "Differences from the original" in the README of the module.
		instanceSettings.markAsFollower();
		await step(
			'as a follower: PUT with the synchronization on',
			async () =>
				await put({ ...CONFIG, synchronizationEnabled: true, synchronizationInterval: 9 }),
		);
		await step('as a follower: the timer fires', async () => await fireTimer(540_000));
		await step('as a follower: init', async () => await service().init());
		await step('as a follower: stopSync', async () => service().stopSync());
		expect(transcript).toMatchSnapshot();
	});

	test('the module', async () => {
		await reset();
		const init = vi.spyOn(service(), 'init');
		await step('init of the module', async () => {
			const result: unknown = await Container.get(LdapModule).init();
			return {
				result: result === undefined ? '<undefined>' : 'value',
				serviceInit: init.mock.calls.length,
			};
		});
		await step('the auth handler', async () => {
			const handler = service() as unknown as {
				metadata: unknown;
				userClass: { name: string };
			};
			return { metadata: handler.metadata, userClass: handler.userClass.name };
		});
		expect(transcript).toMatchSnapshot();
	});
});
