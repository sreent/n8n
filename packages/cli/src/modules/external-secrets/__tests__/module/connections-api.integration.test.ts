// The behaviour of the connections API of the external secrets module
// (`/rest/secret-providers/connections`) in the mode with project connections. The test runs the
// steps in order on one server. Each step records the answer, the calls to the providers, the
// events and the commands to other instances, and the stored connections. Some steps also record
// what expressions see through the secrets proxy of the core. Then the test records the access of
// each role, the answers without the licence, and the answers in the other modes.
// The snapshot records what n8n does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
import { createTeamProject, mockInstance } from '@n8n/backend-test-utils';
import type { Project } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

// The code under test. To record the snapshot against the original files, point these imports at
// the files of `@/modules/external-secrets.ee` (FORK.md lists the paths).
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
	proxyView,
	recorder,
	request,
	resetLogs,
	settle,
	setStep,
	storedState,
	takeLogs,
	testProviders,
} from './harness';

// The API accepts only the six provider types of n8n. The test registers them with providers that
// log each call.
testProviders.setProviders({
	vault: providerType('vault', 'Vault'),
	awsSecretsManager: providerType('awsSecretsManager', 'AWS Secrets Manager'),
	infisical: providerType('infisical', 'Infisical'),
	onePassword: providerType('onePassword', '1Password'),
	gcpSecretsManager: providerType('gcpSecretsManager', 'GCP Secrets Manager'),
	azureKeyVault: providerType('azureKeyVault', 'Azure Key Vault'),
});
behaviours.get('awsSecretsManager')!.secrets = { awsSecret: 'aws value' };
behaviours.get('infisical')!.connectError = 'The connect failed';
behaviours.get('onePassword')!.testResult = [false, 'The test failed'];
behaviours.get('gcpSecretsManager')!.initError = 'The init failed';
behaviours.get('azureKeyVault')!.connectDelayMs = 1500;
mockInstance(ExternalSecretsProviders, testProviders);

const config = Container.get(ExternalSecretsConfig);
config.externalSecretsForProjects = true;
config.externalSecretsMultipleConnections = false;

const testServer = setupTestServer({
	endpointGroups: ['externalSecrets'],
	enabledFeatures: ['feat:externalSecrets'],
	modules: ['external-secrets'],
});

let agents: Record<'owner' | 'admin' | 'member', SuperAgentTest>;
const projects: Record<string, Project> = {};

const call = async (
	label: string,
	method: Method,
	url: string,
	body?: unknown,
	agent: SuperAgentTest = agents.owner,
) => await request(agent, label, method, url, body);

const BASE = '/secret-providers/connections';

beforeAll(async () => {
	const owner = await createOwner();
	const [admin, member] = await Promise.all([createAdmin(), createMember()]);
	recorder.label(owner.id, 'owner');
	recorder.label(admin.id, 'admin');
	recorder.label(member.id, 'member');
	agents = {
		owner: testServer.authAgentFor(owner),
		admin: testServer.authAgentFor(admin),
		member: testServer.authAgentFor(member),
	};
	projects.P1 = await createTeamProject('Project One');
	projects.P2 = await createTeamProject('Project Two');
	projects.personal = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
		member.id,
	);
	// The name of a personal project comes from the random name of its user.
	await Container.get(ProjectRepository).update(projects.personal.id, { name: 'Personal' });
	for (const [label, project] of Object.entries(projects)) recorder.label(project.id, label);
	captureEventsAndCommands();
	await settle();
	setStep('startup');
});

describe('Connections API of external secrets', () => {
	test('startup', async () => {
		expect({ ...takeLogs(), stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
		resetLogs();
	});

	test('the list before any connection', async () => {
		expect([
			await call('list', 'get', BASE),
			await call('one', 'get', `${BASE}/missing`),
		]).toMatchSnapshot();
	});

	test('create a global connection', async () => {
		const create = await call('create', 'post', BASE, {
			providerKey: 'vaultOne',
			type: 'vault',
			projectIds: [],
			settings: { username: 'user one', password: 'password one', other: 'other one' },
		});
		expect({ create, stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('the connection after the create', async () => {
		expect([
			await call('list', 'get', BASE),
			await call('one', 'get', `${BASE}/vaultOne`),
			await call('old API secrets', 'get', '/external-secrets/secrets'),
			await call('old API providers', 'get', '/external-secrets/providers'),
		]).toMatchSnapshot();
	});

	test('create a connection of two projects', async () => {
		const create = await call('create', 'post', BASE, {
			providerKey: 'awsTwo',
			type: 'awsSecretsManager',
			projectIds: [projects.P1.id, projects.P2.id],
			settings: { username: 'aws user', password: 'aws password' },
		});
		expect({
			create,
			stored: await storedState(),
			proxy: proxyView(),
			list: await call('list', 'get', BASE),
		}).toMatchSnapshot();
	});

	test('a connection whose connect fails', async () => {
		// The module tries a failed connect again after 5 to 10 seconds. The steps take less time,
		// so that the snapshot does not depend on the time of the retry.
		expect([
			await call('create', 'post', BASE, {
				providerKey: 'infisicalBad',
				type: 'infisical',
				projectIds: [],
				settings: { username: 'u' },
			}),
			await call('one', 'get', `${BASE}/infisicalBad`),
			await call('test', 'post', `${BASE}/infisicalBad/test`),
			await call('reload', 'post', `${BASE}/infisicalBad/reload`),
			await call('delete', 'delete', `${BASE}/infisicalBad`),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('a connection whose connect takes too long', async () => {
		config.connectTimeout = 1;
		try {
			expect([
				await call('create', 'post', BASE, {
					providerKey: 'azureSlow',
					type: 'azureKeyVault',
					projectIds: [],
					settings: { username: 'u' },
				}),
				await call('one', 'get', `${BASE}/azureSlow`),
				await call('test', 'post', `${BASE}/azureSlow/test`),
				await call('delete', 'delete', `${BASE}/azureSlow`),
			]).toMatchSnapshot();
		} finally {
			config.connectTimeout = 20;
		}
	});

	test('create connections whose provider fails', async () => {
		expect([
			await call('init fails', 'post', BASE, {
				providerKey: 'gcpBad',
				type: 'gcpSecretsManager',
				projectIds: [projects.P1.id],
				settings: { username: 'u' },
			}),
			await call('test fails', 'post', BASE, {
				providerKey: 'onePassBad',
				type: 'onePassword',
				projectIds: [],
				settings: { username: 'u', password: 'p' },
			}),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('invalid input of a create', async () => {
		const valid = { type: 'vault', projectIds: [], settings: { username: 'u' } };
		expect([
			await call('a key that exists', 'post', BASE, { ...valid, providerKey: 'vaultOne' }),
			await call('a key that exists in other case', 'post', BASE, {
				...valid,
				providerKey: 'VAULTONE',
			}),
			await call('a key with a digit first', 'post', BASE, { ...valid, providerKey: '1vault' }),
			await call('a key with a dash', 'post', BASE, { ...valid, providerKey: 'with-dash' }),
			await call('an empty key', 'post', BASE, { ...valid, providerKey: '' }),
			await call('a key of 129 characters', 'post', BASE, {
				...valid,
				providerKey: `k${'x'.repeat(128)}`,
			}),
			await call('a key of 128 characters', 'post', BASE, {
				...valid,
				providerKey: `k${'x'.repeat(127)}`,
			}),
			await call('an unknown type', 'post', BASE, {
				...valid,
				providerKey: 'unknownType',
				type: 'other',
			}),
			await call('no project IDs', 'post', BASE, {
				providerKey: 'noProjects',
				type: 'vault',
				settings: {},
			}),
			await call('a project that does not exist', 'post', BASE, {
				...valid,
				providerKey: 'missingProject',
				projectIds: ['missing-project'],
			}),
			await call('the same project twice', 'post', BASE, {
				...valid,
				providerKey: 'sameProjectTwice',
				projectIds: [projects.P2.id, projects.P2.id],
			}),
			await call('a personal project', 'post', BASE, {
				...valid,
				providerKey: 'personalProject',
				projectIds: [projects.personal.id],
			}),
			await call('no settings', 'post', BASE, {
				providerKey: 'noSettings',
				type: 'vault',
				projectIds: [],
			}),
			await call('settings as a list', 'post', BASE, {
				...valid,
				providerKey: 'settingsList',
				settings: ['a'],
			}),
			await call('more fields', 'post', BASE, {
				...valid,
				providerKey: 'moreFields',
				isEnabled: false,
				id: 'my id',
			}),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('update the settings', async () => {
		expect([
			await call('blanked password and a new user', 'patch', `${BASE}/vaultOne`, {
				settings: { username: 'user two', password: CREDENTIAL_BLANKING_VALUE },
			}),
			await call('one', 'get', `${BASE}/vaultOne`),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
		expect([
			await call('new settings', 'patch', `${BASE}/vaultOne`, {
				settings: { username: 'user three', password: 'password three' },
			}),
			await call('no change', 'patch', `${BASE}/vaultOne`, {}),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
		expect([
			await call('an empty password', 'patch', `${BASE}/vaultOne`, {
				settings: { username: 'empty', password: '' },
			}),
			await call('the blanked empty password', 'patch', `${BASE}/vaultOne`, {
				settings: { username: 'empty', password: CREDENTIAL_BLANKING_VALUE },
			}),
		]).toMatchSnapshot();
		expect({ stored: await storedState() }).toMatchSnapshot();
		await call('back', 'patch', `${BASE}/vaultOne`, {
			settings: { username: 'user three', password: 'password three' },
		});
	});

	test('update the projects', async () => {
		expect([
			await call('to one project', 'patch', `${BASE}/vaultOne`, { projectIds: [projects.P1.id] }),
			await call('to two projects', 'patch', `${BASE}/vaultOne`, {
				projectIds: [projects.P2.id, projects.P1.id],
			}),
			await call('to global', 'patch', `${BASE}/vaultOne`, { projectIds: [] }),
			await call('to a project that does not exist', 'patch', `${BASE}/vaultOne`, {
				projectIds: ['missing-project'],
			}),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('disable and enable a connection', async () => {
		expect([
			await call('disable', 'patch', `${BASE}/awsTwo`, { isEnabled: false }),
			await call('one', 'get', `${BASE}/awsTwo`),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
		expect([
			await call('disable again', 'patch', `${BASE}/awsTwo`, { isEnabled: false }),
			await call('change a disabled connection', 'patch', `${BASE}/awsTwo`, {
				settings: { username: 'aws user two' },
			}),
			await call('enable', 'patch', `${BASE}/awsTwo`, { isEnabled: true }),
			await call('one', 'get', `${BASE}/awsTwo`),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('change the type', async () => {
		expect([
			await call('without settings', 'patch', `${BASE}/vaultOne`, { type: 'onePassword' }),
			await call('to the same type without settings', 'patch', `${BASE}/vaultOne`, {
				type: 'vault',
			}),
			await call('to an unknown type', 'patch', `${BASE}/vaultOne`, { type: 'other' }),
			await call('with settings and the blanked password', 'patch', `${BASE}/vaultOne`, {
				type: 'onePassword',
				settings: { username: 'one user', password: CREDENTIAL_BLANKING_VALUE },
			}),
			await call('one', 'get', `${BASE}/vaultOne`),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
		expect([
			await call('back with settings', 'patch', `${BASE}/vaultOne`, {
				type: 'vault',
				settings: { username: 'user three', password: 'password three' },
			}),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('invalid input of an update', async () => {
		expect([
			await call('a missing connection', 'patch', `${BASE}/missing`, { isEnabled: true }),
			await call('enabled as text', 'patch', `${BASE}/vaultOne`, { isEnabled: 'yes' }),
			await call('settings as text', 'patch', `${BASE}/vaultOne`, { settings: 'text' }),
			await call('a new key', 'patch', `${BASE}/vaultOne`, { providerKey: 'renamed' }),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('test a connection', async () => {
		expect([
			await call('with no body', 'post', `${BASE}/vaultOne/test`),
			await call('with settings', 'post', `${BASE}/vaultOne/test`, {
				username: 'tested user',
				password: 'tested password',
			}),
			await call('with the blanked password', 'post', `${BASE}/vaultOne/test`, {
				username: 'tested user',
				password: CREDENTIAL_BLANKING_VALUE,
			}),
			await call('whose test fails', 'post', `${BASE}/onePassBad/test`),
			await call('whose init fails', 'post', `${BASE}/gcpBad/test`),
			await call('a disabled connection', 'post', `${BASE}/awsTwo/test`),
			await call('a missing connection', 'post', `${BASE}/missing/test`),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('reload a connection', async () => {
		behaviours.get('vault')!.secrets = { changed: 'changed value' };
		expect([
			await call('reload', 'post', `${BASE}/vaultOne/reload`),
			await call('one', 'get', `${BASE}/vaultOne`),
		]).toMatchSnapshot();
		expect({ proxy: proxyView() }).toMatchSnapshot();
		behaviours.get('vault')!.updateError = 'The update failed';
		try {
			expect([
				await call('whose update fails', 'post', `${BASE}/vaultOne/reload`),
				await call('whose init fails', 'post', `${BASE}/gcpBad/reload`),
				await call('a missing connection', 'post', `${BASE}/missing/reload`),
			]).toMatchSnapshot();
		} finally {
			delete behaviours.get('vault')!.updateError;
		}
		expect({ proxy: proxyView() }).toMatchSnapshot();
		await call('disable', 'patch', `${BASE}/awsTwo`, { isEnabled: false });
		expect([
			await call('a disabled connection', 'post', `${BASE}/awsTwo/reload`),
		]).toMatchSnapshot();
		await call('enable', 'patch', `${BASE}/awsTwo`, { isEnabled: true });
	});

	test('the access of each role', async () => {
		const routes: Array<[Method, string, unknown?]> = [
			['get', BASE],
			['get', `${BASE}/vaultOne`],
			[
				'post',
				BASE,
				{ providerKey: 'byRole', type: 'vault', projectIds: [], settings: { username: 'r' } },
			],
			['patch', `${BASE}/byRole`, { settings: { username: 'r2' } }],
			['post', `${BASE}/byRole/test`],
			['post', `${BASE}/byRole/reload`],
			['delete', `${BASE}/byRole`],
		];
		const result: Record<string, unknown> = {};
		for (const role of ['member', 'admin'] as const) {
			for (const [method, url, body] of routes) {
				const answer = await call(`${role}`, method, url, body, agents[role]);
				result[`${role} ${answer.request}`] =
					answer.status === 200 || answer.status === 204
						? { status: answer.status, events: answer.events }
						: { status: answer.status, response: answer.response };
			}
		}
		expect(result).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('delete connections', async () => {
		expect([
			await call('a project connection', 'delete', `${BASE}/awsTwo`),
			await call('a global connection', 'delete', `${BASE}/onePassBad`),
			await call('a connection whose init failed', 'delete', `${BASE}/gcpBad`),
			await call('a missing connection', 'delete', `${BASE}/awsTwo`),
			await call('list', 'get', BASE),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('in the multi-main mode', async () => {
		const instanceSettings = Container.get(InstanceSettings);
		instanceSettings.setMultiMainEnabled(true);
		instanceSettings.setMultiMainLicensed(true);
		try {
			expect([
				await call('create', 'post', BASE, {
					providerKey: 'multiMain',
					type: 'vault',
					projectIds: [projects.P1.id],
					settings: { username: 'multi' },
				}),
				await call('update', 'patch', `${BASE}/multiMain`, { settings: { username: 'multi 2' } }),
				await call('disable', 'patch', `${BASE}/multiMain`, { isEnabled: false }),
				await call('enable', 'patch', `${BASE}/multiMain`, { isEnabled: true }),
				await call('test', 'post', `${BASE}/multiMain/test`),
				await call('reload', 'post', `${BASE}/multiMain/reload`),
				await call('delete', 'delete', `${BASE}/multiMain`),
			]).toMatchSnapshot();
		} finally {
			instanceSettings.setMultiMainEnabled(false);
			instanceSettings.setMultiMainLicensed(false);
		}
	});

	test('without the licence', async () => {
		testServer.license.disable('feat:externalSecrets');
		try {
			expect([
				await call('list', 'get', BASE),
				await call('create', 'post', BASE, {
					providerKey: 'noLicence',
					type: 'vault',
					projectIds: [],
					settings: {},
				}),
				await call('test', 'post', `${BASE}/vaultOne/test`),
			]).toMatchSnapshot();
		} finally {
			testServer.license.enable('feat:externalSecrets');
		}
		expect(await storedState()).toMatchSnapshot();
	});

	test('in the mode with multiple connections only', async () => {
		config.externalSecretsForProjects = false;
		config.externalSecretsMultipleConnections = true;
		try {
			expect([
				await call('list', 'get', BASE),
				await call('create a project connection', 'post', BASE, {
					providerKey: 'multipleMode',
					type: 'vault',
					projectIds: [projects.P1.id],
					settings: { username: 'm' },
				}),
				await call('one', 'get', `${BASE}/multipleMode`),
				await call('delete', 'delete', `${BASE}/multipleMode`),
				await call(
					'project list',
					'get',
					`/secret-providers/projects/${projects.P1.id}/connections`,
				),
				await call(
					'project create',
					'post',
					`/secret-providers/projects/${projects.P1.id}/connections`,
					{
						providerKey: 'multipleProject',
						type: 'vault',
						projectIds: [],
						settings: { username: 'm' },
					},
				),
				await call('types', 'get', '/secret-providers/types'),
				await call('global completions', 'get', '/secret-providers/completions/secrets/global'),
				await call(
					'project completions',
					'get',
					`/secret-providers/completions/secrets/project/${projects.P1.id}`,
				),
			]).toMatchSnapshot();
		} finally {
			config.externalSecretsForProjects = true;
			config.externalSecretsMultipleConnections = false;
		}
	});

	test('in the mode without connections', async () => {
		config.externalSecretsForProjects = false;
		try {
			expect([
				await call('list', 'get', BASE),
				await call('one', 'get', `${BASE}/vaultOne`),
				await call('create', 'post', BASE, {
					providerKey: 'settingsMode',
					type: 'vault',
					projectIds: [],
					settings: { username: 's' },
				}),
				await call('test', 'post', `${BASE}/vaultOne/test`),
				await call('reload', 'post', `${BASE}/vaultOne/reload`),
				await call('delete', 'delete', `${BASE}/settingsMode`),
				await call(
					'project list',
					'get',
					`/secret-providers/projects/${projects.P1.id}/connections`,
				),
				await call('types', 'get', '/secret-providers/types'),
				await call('global completions', 'get', '/secret-providers/completions/secrets/global'),
				await call(
					'project completions',
					'get',
					`/secret-providers/completions/secrets/project/${projects.P1.id}`,
				),
			]).toMatchSnapshot();
		} finally {
			config.externalSecretsForProjects = true;
		}
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});
});
