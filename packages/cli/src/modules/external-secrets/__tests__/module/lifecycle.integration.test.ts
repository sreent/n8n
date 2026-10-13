// The behaviour of the external secrets module around its start and stop: the start with stored
// settings (the mode without connections) and with stored connections, the reload by a command
// from another instance, the update interval, the connect and refresh timeouts, the stop, the
// settings for the editor, the start without the licence, and the access check of the providers of
// a project. Each step records the calls to the providers, the events, the commands to other
// instances, and what expressions see through the secrets proxy of the core.
// The snapshot records what n8n does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
import { LicenseState } from '@n8n/backend-common';
import { createTeamProject, mockInstance, testDb, testModules } from '@n8n/backend-test-utils';
import type { Project } from '@n8n/db';
import {
	ExternalSecretsConnectionRepository,
	ExternalSecretsProjectAccessRepository,
	SettingsRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { sleep } from '@n8n/utils/sleep';
import { Cipher } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { License } from '@/license';
import { PubSubEventBus } from '@/scaling/pubsub/pubsub.eventbus';
import { PubSubRegistry } from '@/scaling/pubsub/pubsub.registry';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at the files of `@/modules/external-secrets.ee` (FORK.md lists the
// paths).
import { ExternalSecretsConfig } from '@/modules/external-secrets/external-secrets.config';
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';
import { ExternalSecretsModule } from '@/modules/external-secrets/external-secrets.module';
import { ExternalSecretsProviderRegistry } from '@/modules/external-secrets/provider-registry.service';
import { SecretsProviderAccessCheckService } from '@/modules/external-secrets/secret-provider-access-check.service';

import {
	behaviours,
	byInstance,
	captureEventsAndCommands,
	providerLog,
	providerType,
	proxyView,
	recorder,
	resetLogs,
	setStep,
	takeLogs,
	testProviders,
} from './harness';

testProviders.setProviders({
	dummy: providerType('dummy', 'Dummy'),
	another: providerType('another', 'Another'),
	initFails: providerType('initFails'),
	slowConnect: providerType('slowConnect'),
	slowUpdate: providerType('slowUpdate'),
	updateFails: providerType('updateFails'),
	retrying: providerType('retrying'),
});
behaviours.get('another')!.secrets = { anotherSecret: 'another value' };
behaviours.get('initFails')!.initError = 'The init failed';
behaviours.get('slowConnect')!.connectDelayMs = 2500;
behaviours.get('slowUpdate')!.updateDelayMs = 2500;
behaviours.get('slowUpdate')!.secrets = { slowSecret: 'slow value' };
behaviours.get('updateFails')!.updateError = 'The update failed';
behaviours.get('retrying')!.connectError = 'The connect failed';
mockInstance(ExternalSecretsProviders, testProviders);

let licensed = true;
const licenseState = mock<LicenseState>();
licenseState.isLicensed.mockImplementation(() => licensed);
licenseState.isExternalSecretsLicensed.mockImplementation(() => licensed);
Container.set(LicenseState, licenseState);
mockInstance(License, {
	isLicensed: vi.fn(() => licensed),
	isExternalSecretsEnabled: vi.fn(() => licensed),
});

const config = Container.get(ExternalSecretsConfig);

let module: ExternalSecretsModule;
const projects: Record<string, Project> = {};

/** What a step did: the calls, the events, the commands, and the secrets that expressions see. */
async function step(label: string, action: () => Promise<unknown> | unknown, waitMs = 100) {
	setStep(label);
	let result: unknown;
	try {
		result = recorder.normalize(await action());
	} catch (error) {
		result = `throws ${recorder.describeError(error)}`;
	}
	await sleep(waitMs);
	const logs = takeLogs();
	return {
		result,
		providers: byInstance(logs.providers as unknown[][]),
		events: logs.events,
		proxy: proxyView(),
	};
}

async function storeSettings(value: unknown) {
	await Container.get(SettingsRepository).save({
		key: 'feature.externalSecrets',
		value: Container.get(Cipher).encryptWithInstanceKey(JSON.stringify(value)),
		loadOnStartup: false,
	});
}

async function storeConnection(
	providerKey: string,
	type: string,
	settings: unknown,
	options: { isEnabled?: boolean; projects?: string[]; asObject?: boolean } = {},
) {
	const repository = Container.get(ExternalSecretsConnectionRepository);
	const cipher = Container.get(Cipher);
	const connection = await repository.save(
		repository.create({
			providerKey,
			type,
			encryptedSettings: options.asObject
				? cipher.encryptWithInstanceKey(settings as object)
				: cipher.encryptWithInstanceKey(JSON.stringify(settings)),
			isEnabled: options.isEnabled ?? true,
		}),
	);
	for (const project of options.projects ?? []) {
		const access = Container.get(ExternalSecretsProjectAccessRepository);
		await access.save(
			access.create({
				secretsProviderConnectionId: connection.id,
				projectId: projects[project].id,
			}),
		);
	}
}

async function clearStore() {
	await testDb.truncate(['SecretsProviderConnection', 'ProjectSecretsProviderAccess']);
	await Container.get(SettingsRepository).delete({ key: 'feature.externalSecrets' });
}

const setMode = (mode: 'settings' | 'projects' | 'multiple') => {
	config.externalSecretsForProjects = mode === 'projects';
	config.externalSecretsMultipleConnections = mode === 'multiple';
	config.externalSecretsRoleBasedAccess = true;
};

beforeAll(async () => {
	await testModules.loadModules(['external-secrets']);
	await testDb.init();
	module = Container.get(ExternalSecretsModule);
	projects.P1 = await createTeamProject('Project One');
	projects.P2 = await createTeamProject('Project Two');
	for (const [label, project] of Object.entries(projects)) recorder.label(project.id, label);
	captureEventsAndCommands();
	resetLogs();
});

afterAll(async () => {
	await module.shutdown();
	await testDb.terminate();
});

/** Stop the module and forget its providers, as a new process would. */
const stopAndForget = async () => {
	await module.shutdown();
	Container.get(ExternalSecretsProviderRegistry).clear();
	resetLogs();
};

const reloadCommand = async () => {
	Container.get(PubSubEventBus).emit('reload-external-secrets-providers');
	await sleep(200);
};

describe('Lifecycle of the external secrets module', () => {
	test('the editor settings before the start', async () => {
		setMode('settings');
		expect(await step('settings', async () => await module.settings?.())).toMatchSnapshot();
	});

	test('the start with stored settings', async () => {
		setMode('settings');
		await storeSettings({
			dummy: {
				connected: true,
				connectedAt: '2026-01-02T03:04:05.000Z',
				settings: { username: 'stored user', password: 'stored password' },
			},
			another: { connected: false, connectedAt: null, settings: { username: 'not connected' } },
			initFails: { connected: true, connectedAt: null, settings: {} },
			updateFails: { connected: true, connectedAt: null, settings: {} },
		});
		const init = await step('init', async () => await module.init());
		// The module loads the handlers of the commands in `init`.
		Container.get(PubSubRegistry).init();
		expect({
			init,
			settings: await step('settings', async () => await module.settings?.()),
		}).toMatchSnapshot();
	});

	test('a reload by a command from another instance', async () => {
		behaviours.get('dummy')!.secrets = { reloaded: 'reloaded value' };
		expect(await step('reload command', reloadCommand)).toMatchSnapshot();
	});

	test('the stop and a second start', async () => {
		expect({
			shutdown: await step('shutdown', async () => await module.shutdown()),
			secondShutdown: await step('second shutdown', async () => await module.shutdown()),
			init: await step('init again', async () => await module.init()),
			secondInit: await step('second init', async () => await module.init()),
		}).toMatchSnapshot();
		await stopAndForget();
	});

	test('the start with stored connections', async () => {
		await clearStore();
		setMode('projects');
		behaviours.get('dummy')!.secrets = { first: 'one', second: 'two' };
		await storeConnection('globalDummy', 'dummy', { username: 'global user', password: 'pw' });
		await storeConnection(
			'objectSettings',
			'another',
			{ username: 'stored as object' },
			{
				asObject: true,
			},
		);
		await storeConnection('disabledDummy', 'dummy', { username: 'disabled' }, { isEnabled: false });
		await storeConnection(
			'projectDummy',
			'dummy',
			{ username: 'project user' },
			{
				projects: ['P1'],
			},
		);
		await storeConnection('initFailsConn', 'initFails', {});
		await storeConnection('updateFailsConn', 'updateFails', {});
		await storeConnection('with-dash', 'dummy', { username: 'dash' });
		expect({
			init: await step('init', async () => await module.init()),
			settings: await step('settings', async () => await module.settings?.()),
		}).toMatchSnapshot();
	});

	test('a reload by a command with stored connections', async () => {
		await storeConnection('addedLater', 'another', { username: 'added later' });
		const repository = Container.get(ExternalSecretsConnectionRepository);
		await repository.update({ providerKey: 'globalDummy' }, { isEnabled: false });
		expect(await step('reload command', reloadCommand)).toMatchSnapshot();
	});

	test('the access check of the providers of a project', async () => {
		const service = Container.get(SecretsProviderAccessCheckService);
		const result: Record<string, unknown> = {};
		for (const key of [
			'globalDummy',
			'objectSettings',
			'disabledDummy',
			'projectDummy',
			'addedLater',
			'missing',
		]) {
			for (const project of ['P1', 'P2']) {
				result[`${key} in ${project}`] = await service
					.isProviderAvailableInProject(key, projects[project].id)
					.catch((error: unknown) => `throws ${recorder.describeError(error)}`);
			}
		}
		expect(result).toMatchSnapshot();
	});

	test('the editor settings in each mode', async () => {
		const result: Record<string, unknown> = {};
		for (const mode of ['settings', 'projects', 'multiple'] as const) {
			setMode(mode);
			result[mode] = await module.settings?.();
		}
		setMode('projects');
		config.externalSecretsRoleBasedAccess = false;
		result['projects without role-based access'] = await module.settings?.();
		config.externalSecretsRoleBasedAccess = true;
		await Container.get(SettingsRepository).save({
			key: 'externalSecrets.systemRolesEnabled',
			value: 'true',
			loadOnStartup: true,
		});
		setMode('projects');
		result['projects with the system roles on'] = await module.settings?.();
		await Container.get(SettingsRepository).delete({ key: 'externalSecrets.systemRolesEnabled' });
		setMode('settings');
		licensed = false;
		result['settings without the licence'] = await module.settings?.();
		licensed = true;
		expect(recorder.normalize(result)).toMatchSnapshot();
	});

	test('the stop with stored connections', async () => {
		setMode('projects');
		expect(await step('shutdown', async () => await module.shutdown())).toMatchSnapshot();
		await stopAndForget();
	});

	test('the update interval', async () => {
		await clearStore();
		setMode('projects');
		config.updateInterval = 1;
		await storeConnection('intervalDummy', 'dummy', {});
		await storeConnection('intervalFails', 'updateFails', {});
		try {
			setStep('init');
			await module.init();
			await sleep(2600);
			const lines = takeLogs().providers as unknown[][];
			const count = (instance: string, method: string) =>
				lines.filter((line) => line[1] === instance && line[2] === method).length;
			expect({
				'updates of intervalDummy, at least 3': count('dummy#1', 'update') >= 3,
				'updates of intervalDummy, at most 4': count('dummy#1', 'update') <= 4,
				'updates of intervalFails, at least 3': count('updateFails#1', 'update') >= 3,
				'other calls': lines.filter((line) => line[2] !== 'update'),
			}).toMatchSnapshot();
			await module.shutdown();
			takeLogs();
			await sleep(1500);
			expect(takeLogs()).toMatchSnapshot();
		} finally {
			config.updateInterval = 300;
			await stopAndForget();
		}
	});

	test('the connect timeout and the refresh timeout', async () => {
		await clearStore();
		setMode('projects');
		config.connectTimeout = 1;
		config.refreshTimeout = 1;
		await storeConnection('slowConnectConn', 'slowConnect', {});
		await storeConnection('slowUpdateConn', 'slowUpdate', {});
		try {
			setStep('init');
			const start = Date.now();
			await module.init();
			const seconds = (Date.now() - start) / 1000;
			const atStart = { ...takeLogs(), proxy: proxyView() };
			await sleep(2000);
			setStep('later');
			expect({
				'init took less than 2 seconds': seconds < 2,
				atStart,
				later: { ...takeLogs(), proxy: proxyView() },
			}).toMatchSnapshot();
		} finally {
			config.connectTimeout = 20;
			config.refreshTimeout = 20;
			await stopAndForget();
		}
	});

	test('the retries of a failed connect', async () => {
		await clearStore();
		setMode('projects');
		await storeConnection('retryConn', 'retrying', {});
		/** Wait for a call of the instance, and give its time in seconds since `since`. */
		const waitForCall = async (method: string, since: number, maxMs: number) => {
			const end = Date.now() + maxMs;
			while (Date.now() < end) {
				const index = providerLog.findIndex(
					(line) => line[1] === 'retrying#1' && line[2] === method,
				);
				if (index !== -1) {
					const seconds = (Date.now() - since) / 1000;
					providerLog.splice(0, index + 1);
					return seconds;
				}
				await sleep(50);
			}
			return null;
		};
		try {
			setStep('init');
			await module.init();
			const failedAt = Date.now();
			const atStart = byInstance(takeLogs().providers as unknown[][]);
			setStep('first retry');
			const first = await waitForCall('connect', failedAt, 12_000);
			const firstAt = Date.now();
			behaviours.get('retrying')!.connectError = undefined;
			setStep('second retry');
			const second = await waitForCall('connect', firstAt, 22_000);
			await sleep(100);
			expect({
				atStart,
				'the first retry comes 4.5 to 10.5 seconds after the failure':
					first !== null && first >= 4.5 && first <= 10.5,
				'the second retry comes 9.5 to 20.5 seconds after the first':
					second !== null && second >= 9.5 && second <= 20.5,
				'after the second retry': takeLogs(),
				proxy: proxyView(),
			}).toMatchSnapshot();
		} finally {
			behaviours.get('retrying')!.connectError = 'The connect failed';
			await stopAndForget();
		}
	}, 60_000);

	test('the start without the licence', async () => {
		await clearStore();
		setMode('projects');
		await storeConnection('noLicence', 'dummy', {});
		licensed = false;
		try {
			expect(await step('init', async () => await module.init())).toMatchSnapshot();
		} finally {
			licensed = true;
			await stopAndForget();
		}
	});
});
