// The behaviour of the settings API of the external secrets module (`/rest/external-secrets`) in
// the mode without connections: one stored setting for each provider type. The test runs the steps
// in order on one server. Each step records the answer, the calls to the providers, the events and
// the commands to other instances, and the stored settings. Then the test records the access of
// each role, the answers without the licence and in the mode with connections, and invalid input.
// The snapshot records what n8n does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
import { EventService } from '@n8n/backend-services';
import { mockInstance } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at the files of `@/modules/external-secrets.ee` (FORK.md lists the
// paths).
import { ExternalSecretsConfig } from '@/modules/external-secrets/external-secrets.config';
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';

import { createAdmin, createMember, createOwner } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import { setupTestServer } from '@test-integration/utils';

import {
	behaviours,
	captureEventsAndCommands,
	type Method,
	providerType,
	recorder,
	request,
	resetLogs,
	settle,
	setStep,
	storedState,
	takeLogs,
	testProviders,
} from './harness';

testProviders.setProviders({
	dummy: providerType('dummy', 'Dummy'),
	testFails: providerType('testFails'),
	connectFails: providerType('connectFails'),
	initFails: providerType('initFails'),
});
behaviours.get('testFails')!.testResult = [false, 'The test failed'];
behaviours.get('connectFails')!.connectError = 'The connect failed';
behaviours.get('initFails')!.initError = 'The init failed';
mockInstance(ExternalSecretsProviders, testProviders);

const config = Container.get(ExternalSecretsConfig);
config.externalSecretsForProjects = false;
config.externalSecretsMultipleConnections = false;

const testServer = setupTestServer({
	endpointGroups: ['externalSecrets'],
	enabledFeatures: ['feat:externalSecrets'],
	modules: ['external-secrets'],
});

let agents: Record<'owner' | 'admin' | 'member', SuperAgentTest>;
let owner: User;

const call = async (
	label: string,
	method: Method,
	url: string,
	body?: unknown,
	agent: SuperAgentTest = agents.owner,
) => await request(agent, label, method, url, body);

beforeAll(async () => {
	owner = await createOwner();
	const [admin, member] = await Promise.all([createAdmin(), createMember()]);
	recorder.label(owner.id, 'owner');
	recorder.label(admin.id, 'admin');
	recorder.label(member.id, 'member');
	agents = {
		owner: testServer.authAgentFor(owner),
		admin: testServer.authAgentFor(admin),
		member: testServer.authAgentFor(member),
	};
	captureEventsAndCommands();
	await settle();
	setStep('startup');
});

describe('Settings API of external secrets', () => {
	test('startup', async () => {
		expect({ ...takeLogs(), stored: await storedState() }).toMatchSnapshot();
		resetLogs();
	});

	test('the capture of events', async () => {
		setStep('capture check');
		Container.get(EventService).emit('external-secrets-provider-reloaded', { vaultType: 'check' });
		expect(takeLogs().events).toMatchSnapshot();
	});

	test('the providers before any settings', async () => {
		expect([
			await call('list', 'get', '/external-secrets/providers'),
			await call('one', 'get', '/external-secrets/providers/dummy'),
			await call('unknown', 'get', '/external-secrets/providers/unknown'),
			await call('secrets', 'get', '/external-secrets/secrets'),
		]).toMatchSnapshot();
	});

	test('save the settings of a provider', async () => {
		const save = await call('save', 'post', '/external-secrets/providers/dummy', {
			username: 'user one',
			password: 'password one',
			other: 'other one',
		});
		expect({ save, stored: await storedState() }).toMatchSnapshot();
	});

	test('the provider after the save', async () => {
		expect([
			await call('one', 'get', '/external-secrets/providers/dummy'),
			await call('list', 'get', '/external-secrets/providers'),
			await call('secrets', 'get', '/external-secrets/secrets'),
		]).toMatchSnapshot();
	});

	test('save again with the blanked password and a missing field', async () => {
		const save = await call('save again', 'post', '/external-secrets/providers/dummy', {
			username: 'user two',
			password: CREDENTIAL_BLANKING_VALUE,
		});
		expect({ save, stored: await storedState() }).toMatchSnapshot();
	});

	test('connect the provider', async () => {
		const connect = await call('connect', 'post', '/external-secrets/providers/dummy/connect', {
			connected: true,
		});
		expect({
			connect,
			stored: await storedState(),
			after: [
				await call('one', 'get', '/external-secrets/providers/dummy'),
				await call('secrets', 'get', '/external-secrets/secrets'),
			],
		}).toMatchSnapshot();
	});

	test('test the provider', async () => {
		expect([
			await call(
				'test with the blanked password',
				'post',
				'/external-secrets/providers/dummy/test',
				{
					username: 'user three',
					password: CREDENTIAL_BLANKING_VALUE,
				},
			),
			await call('test with new settings', 'post', '/external-secrets/providers/dummy/test', {
				username: 'user four',
				password: 'password four',
			}),
			await call('test with no body', 'post', '/external-secrets/providers/dummy/test'),
		]).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('update the secrets of the provider', async () => {
		behaviours.get('dummy')!.secrets = { changed: 'value' };
		expect([
			await call('update', 'post', '/external-secrets/providers/dummy/update'),
			await call('secrets', 'get', '/external-secrets/secrets'),
		]).toMatchSnapshot();
	});

	test('a provider whose test fails', async () => {
		expect([
			await call('save', 'post', '/external-secrets/providers/testFails', { username: 'u' }),
			await call('test', 'post', '/external-secrets/providers/testFails/test', { username: 'u' }),
			await call('connect', 'post', '/external-secrets/providers/testFails/connect', {
				connected: true,
			}),
			await call('one', 'get', '/external-secrets/providers/testFails'),
		]).toMatchSnapshot();
	});

	test('a provider whose connect fails', async () => {
		expect([
			await call('save', 'post', '/external-secrets/providers/connectFails', { username: 'u' }),
			await call('connect', 'post', '/external-secrets/providers/connectFails/connect', {
				connected: true,
			}),
			await call('one', 'get', '/external-secrets/providers/connectFails'),
			await call('update', 'post', '/external-secrets/providers/connectFails/update'),
			await call('test', 'post', '/external-secrets/providers/connectFails/test', {
				username: 'u',
			}),
			await call('secrets', 'get', '/external-secrets/secrets'),
			// The module tries a failed connect again after 5 to 10 seconds. A disconnect stops that,
			// so that the snapshot does not depend on the time of the retry.
			await call('disconnect', 'post', '/external-secrets/providers/connectFails/connect', {
				connected: false,
			}),
		]).toMatchSnapshot();
	});

	test('a provider whose init fails', async () => {
		expect([
			await call('save', 'post', '/external-secrets/providers/initFails', { username: 'u' }),
			await call('connect', 'post', '/external-secrets/providers/initFails/connect', {
				connected: true,
			}),
			await call('one', 'get', '/external-secrets/providers/initFails'),
			await call('test', 'post', '/external-secrets/providers/initFails/test', { username: 'u' }),
			await call('update', 'post', '/external-secrets/providers/initFails/update'),
		]).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('disconnect the provider', async () => {
		expect([
			await call('disconnect', 'post', '/external-secrets/providers/dummy/connect', {
				connected: false,
			}),
			await call('one', 'get', '/external-secrets/providers/dummy'),
			await call('secrets', 'get', '/external-secrets/secrets'),
			await call('update', 'post', '/external-secrets/providers/dummy/update'),
		]).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('the system roles setting', async () => {
		expect([
			await call('turn on', 'post', '/external-secrets/settings/', { systemRolesEnabled: true }),
			await call('turn on again', 'post', '/external-secrets/settings', {
				systemRolesEnabled: true,
			}),
			await call('turn off', 'post', '/external-secrets/settings', { systemRolesEnabled: false }),
			await call('no value', 'post', '/external-secrets/settings', {}),
			await call('text value', 'post', '/external-secrets/settings', { systemRolesEnabled: 'yes' }),
		]).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('invalid input', async () => {
		expect([
			await call('save an unknown provider', 'post', '/external-secrets/providers/unknown', {
				username: 'u',
			}),
			await call(
				'connect an unknown provider',
				'post',
				'/external-secrets/providers/unknown/connect',
				{
					connected: true,
				},
			),
			await call('test an unknown provider', 'post', '/external-secrets/providers/unknown/test', {
				username: 'u',
			}),
			await call(
				'update an unknown provider',
				'post',
				'/external-secrets/providers/unknown/update',
			),
			await call('connect with text', 'post', '/external-secrets/providers/dummy/connect', {
				connected: 'yes',
			}),
			await call(
				'connect without a value',
				'post',
				'/external-secrets/providers/dummy/connect',
				{},
			),
			await call('save a list', 'post', '/external-secrets/providers/dummy', ['a', 'b']),
			await call(
				'save a field that the form does not have',
				'post',
				'/external-secrets/providers/dummy',
				{
					username: 'u',
					unknownField: 'x',
				},
			),
		]).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('an empty password', async () => {
		expect([
			await call('save', 'post', '/external-secrets/providers/dummy', {
				username: 'empty',
				password: '',
			}),
			await call('one', 'get', '/external-secrets/providers/dummy'),
			await call('save the answer again', 'post', '/external-secrets/providers/dummy', {
				username: 'empty',
				password: CREDENTIAL_BLANKING_VALUE,
			}),
		]).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('the access of each role', async () => {
		const routes: Array<[Method, string, unknown?]> = [
			['get', '/external-secrets/providers'],
			['get', '/external-secrets/providers/dummy'],
			['get', '/external-secrets/secrets'],
			['post', '/external-secrets/providers/dummy', { username: 'by role' }],
			['post', '/external-secrets/providers/dummy/connect', { connected: true }],
			['post', '/external-secrets/providers/dummy/test', { username: 'by role' }],
			['post', '/external-secrets/providers/dummy/update'],
			['post', '/external-secrets/settings', { systemRolesEnabled: false }],
		];
		const result: Record<string, unknown> = {};
		for (const role of ['member', 'admin'] as const) {
			for (const [method, url, body] of routes) {
				const answer = await call(`${role}`, method, url, body, agents[role]);
				result[`${role} ${answer.request}`] =
					answer.status === 200
						? { status: 200, events: answer.events }
						: { status: answer.status, response: answer.response };
			}
		}
		expect(result).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('in the multi-main mode', async () => {
		const instanceSettings = Container.get(InstanceSettings);
		instanceSettings.setMultiMainEnabled(true);
		instanceSettings.setMultiMainLicensed(true);
		try {
			expect([
				await call('save', 'post', '/external-secrets/providers/dummy', { username: 'multi' }),
				await call('connect', 'post', '/external-secrets/providers/dummy/connect', {
					connected: true,
				}),
				await call('test', 'post', '/external-secrets/providers/dummy/test', { username: 'multi' }),
				await call('update', 'post', '/external-secrets/providers/dummy/update'),
				await call('disconnect', 'post', '/external-secrets/providers/dummy/connect', {
					connected: false,
				}),
				await call('system roles', 'post', '/external-secrets/settings', {
					systemRolesEnabled: false,
				}),
			]).toMatchSnapshot();
		} finally {
			instanceSettings.setMultiMainEnabled(false);
			instanceSettings.setMultiMainLicensed(false);
		}
		expect(await storedState()).toMatchSnapshot();
	});

	test('without the licence', async () => {
		testServer.license.disable('feat:externalSecrets');
		expect([
			await call('list', 'get', '/external-secrets/providers'),
			await call('secrets', 'get', '/external-secrets/secrets'),
			await call('save', 'post', '/external-secrets/providers/dummy', { username: 'no licence' }),
			await call('system roles', 'post', '/external-secrets/settings', {
				systemRolesEnabled: true,
			}),
		]).toMatchSnapshot();
	});

	test('in the mode with multiple connections', async () => {
		config.externalSecretsMultipleConnections = true;
		try {
			expect([
				await call('list', 'get', '/external-secrets/providers'),
				await call('save', 'post', '/external-secrets/providers/dummy', { username: 'multiple' }),
				await call('connections', 'get', '/secret-providers/connections'),
			]).toMatchSnapshot();
		} finally {
			config.externalSecretsMultipleConnections = false;
		}
	});

	test('in the mode with connections', async () => {
		config.externalSecretsForProjects = true;
		try {
			expect([
				await call('list', 'get', '/external-secrets/providers'),
				await call('one', 'get', '/external-secrets/providers/dummy'),
				await call('secrets', 'get', '/external-secrets/secrets'),
				await call('save', 'post', '/external-secrets/providers/dummy', { username: 'projects' }),
				await call('connections', 'get', '/secret-providers/connections'),
			]).toMatchSnapshot();
		} finally {
			config.externalSecretsForProjects = false;
		}
	});
});
