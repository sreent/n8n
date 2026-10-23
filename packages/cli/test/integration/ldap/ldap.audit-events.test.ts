// Fork test (not in upstream n8n): the audit events of LDAP (`ForkGovernanceEventRelay`). A change
// of the configuration and a synchronization that a user starts send an audit event with the user,
// from the REST API and from the public API. See `packages/cli/src/modules/ldap/README.md`.
import { EventService } from '@n8n/backend-services';
import type { LdapConfig } from '@n8n/constants';
import { LDAP_DEFAULT_CONFIGURATION, LDAP_FEATURE_NAME } from '@n8n/constants';
import type { User } from '@n8n/db';
import { SettingsRepository } from '@n8n/db';
import { Container } from '@n8n/di';

import { createOwnerWithApiKey } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

// A directory without users: the synchronization reads no entries.
vi.mock('ldapts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ldapts')>();
	class Client {
		async bind() {}
		async unbind() {}
		async startTLS() {}
		async search() {
			return { searchEntries: [], searchReferences: [] };
		}
	}
	return { ...actual, Client };
});

const testServer = utils.setupTestServer({
	endpointGroups: ['auth', 'ldap', 'publicApi'],
	enabledFeatures: ['feat:ldap'],
	modules: ['ldap'],
});

const CONFIG: LdapConfig = {
	...LDAP_DEFAULT_CONFIGURATION,
	loginEnabled: true,
	loginLabel: 'Directory login',
	connectionUrl: 'ldap.example.com',
	baseDn: 'dc=example,dc=com',
	bindingAdminDn: 'cn=admin,dc=example,dc=com',
	bindingAdminPassword: 'admin-secret',
	loginIdAttribute: 'mail',
	ldapIdAttribute: 'uid',
	emailAttribute: 'mail',
	firstNameAttribute: 'givenName',
	lastNameAttribute: 'sn',
	synchronizationEnabled: false,
	synchronizationInterval: 60,
};

const AUDIT_EVENTS = new Set(['ldap-settings-saved', 'ldap-synchronized']);

let events: Array<{ name: string; payload: unknown }> = [];
let owner: User;
let agent: SuperAgentTest;

/** The payloads of one audit event, with the id of the user. */
const audit = (name: string) =>
	events
		.filter((event) => event.name === name)
		.map(({ payload }) => {
			const { user, ...rest } = payload as { user: User } & Record<string, unknown>;
			return { userId: user.id, ...rest };
		});

beforeAll(async () => {
	owner = await createOwnerWithApiKey();
	agent = testServer.authAgentFor(owner);
	await Container.get(SettingsRepository).save({
		key: LDAP_FEATURE_NAME,
		value: JSON.stringify(LDAP_DEFAULT_CONFIGURATION),
		loadOnStartup: true,
	});
});

// The test config restores all spies before each test, so each test sets the spy again.
beforeEach(() => {
	events = [];
	const eventService = Container.get(EventService);
	const emit = eventService.emit.bind(eventService);
	vi.spyOn(eventService, 'emit').mockImplementation((name, ...payload) => {
		if (AUDIT_EVENTS.has(name)) events.push({ name, payload: payload[0] });
		return emit(name, ...payload);
	});
});

test('a change of the configuration sends an audit event with the user', async () => {
	await agent.put('/ldap/config').send(CONFIG).expect(200);

	expect(audit('ldap-settings-saved')).toEqual([
		{
			userId: owner.id,
			loginEnabled: true,
			connectionUrl: 'ldap.example.com',
			synchronizationEnabled: false,
			synchronizationInterval: 60,
		},
	]);
});

test('a synchronization that a user starts sends an audit event with the user', async () => {
	await agent.put('/ldap/config').send(CONFIG).expect(200);
	await agent.post('/ldap/sync').send({ type: 'dry' }).expect(200);

	expect(audit('ldap-synchronized')).toEqual([
		{
			userId: owner.id,
			mode: 'dry',
			status: 'success',
			created: 0,
			updated: 0,
			disabled: 0,
			scanned: 0,
		},
	]);
});

test('the public API sends the same audit events with the user of the API key', async () => {
	const publicApi = testServer.publicApiAgentFor(owner);
	await publicApi.put('/settings/ldap').send(CONFIG).expect(200);
	await publicApi.post('/settings/ldap/sync').send({ type: 'dry' }).expect(200);

	expect(audit('ldap-settings-saved')).toEqual([
		expect.objectContaining({ userId: owner.id, connectionUrl: 'ldap.example.com' }),
	]);
	expect(audit('ldap-synchronized')).toEqual([
		expect.objectContaining({ userId: owner.id, mode: 'dry', status: 'success' }),
	]);
});
