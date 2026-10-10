// The behaviour of the repositories of the secrets provider connections: the queries that ordinary
// code uses. They give the ID of a connection by its provider key, the IDs of several connections,
// the enabled global connections, the enabled connections of a project, and the provider keys that
// a credential can use. The fixture has global and project connections, enabled and disabled
// ones, connections of several projects, owner and user access, and credentials with owner and
// user sharing. The snapshot records each result, so a change in behaviour shows up as a snapshot
// diff. The original queries give no defined order (it depends on the query plan of the database),
// so the test sorts each list. packages/cli/src/modules/external-secrets/FORK.md tells how the fork
// made the snapshot.
import { LicenseState } from '@n8n/backend-common';
import { createTeamProject, testDb } from '@n8n/backend-test-utils';
import type { Project } from '@n8n/db';
import { CredentialsRepository, ProjectRepository, SharedCredentialsRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { mock } from 'vitest-mock-extended';

// The code under test. To record the snapshot against the original files, import
// `SecretsProviderConnectionRepository` and `ProjectSecretsProviderAccessRepository` here.
import {
	ExternalSecretsConnectionRepository as ConnectionRepository,
	ExternalSecretsProjectAccessRepository as AccessRepository,
} from '@n8n/db';

import { createMember } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';

const recorder = new GoldenRecorder();

let connections: ConnectionRepository;
let access: AccessRepository;

/** The numeric IDs of the connections, by provider key. */
const connectionIds = new Map<string, number>();
const credentialIds = new Map<string, string>();
const projects: Record<string, Project> = {};

async function createConnection(
	providerKey: string,
	isEnabled: boolean,
	accessRows: Array<{ project: string; role?: 'owner' | 'user' }> = [],
) {
	const connection = await connections.save(
		connections.create({
			providerKey,
			type: 'awsSecretsManager',
			encryptedSettings: `settings of ${providerKey}`,
			isEnabled,
		}),
	);
	connectionIds.set(providerKey, connection.id);
	recorder.connectionLabels.set(connection.id, providerKey);
	for (const row of accessRows) {
		await access.save(
			access.create({
				secretsProviderConnectionId: connection.id,
				projectId: projects[row.project].id,
				...(row.role ? { role: `secretsProviderConnection:${row.role}` as const } : {}),
			}),
		);
	}
}

async function createCredential(
	name: string,
	sharing: Array<{ project: string; role: 'credential:owner' | 'credential:user' }>,
) {
	const credential = await Container.get(CredentialsRepository).save(
		Container.get(CredentialsRepository).create({ name, type: 'githubApi', data: 'data' }),
	);
	recorder.label(credential.id, `credential ${name}`);
	credentialIds.set(name, credential.id);
	for (const share of sharing) {
		await Container.get(SharedCredentialsRepository).save(
			Container.get(SharedCredentialsRepository).create({
				credentialsId: credential.id,
				projectId: projects[share.project].id,
				role: share.role,
			}),
		);
	}
}

/** The label of a connection ID, as a number or as text. */
function connectionLabel(id: unknown) {
	for (const [key, value] of connectionIds) {
		if (id === value) return `<id of ${key}>`;
		if (id === String(value)) return `<id of ${key} as text>`;
	}
	return id;
}

/** The text by which a list sorts an entry: its provider key, or its JSON. */
const sortKey = (entry: unknown) =>
	entry !== null && typeof entry === 'object' && 'providerKey' in entry
		? String(entry.providerKey)
		: JSON.stringify(entry);

/**
 * A result with labels for the IDs of the connections, projects and credentials, and with each
 * list sorted.
 */
function labelled(value: unknown): unknown {
	const walk = (entry: unknown, key?: string): unknown => {
		if (Array.isArray(entry)) {
			return entry.map((item) => walk(item)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
		}
		if (entry !== null && typeof entry === 'object') {
			return Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, walk(v, k)]));
		}
		if (key === 'id' || key === 'secretsProviderConnectionId' || key === undefined) {
			const label = connectionLabel(entry);
			if (label !== entry) return label;
		}
		return entry;
	};
	return walk(recorder.normalize(value));
}

async function attempt(fn: () => Promise<unknown>) {
	try {
		return labelled(await fn());
	} catch (error) {
		return `throws ${recorder.describeError(error)}`;
	}
}

beforeAll(async () => {
	const licenseMock = mock<LicenseState>();
	licenseMock.isLicensed.mockReturnValue(true);
	Container.set(LicenseState, licenseMock);

	await testDb.init();
	connections = Container.get(ConnectionRepository);
	access = Container.get(AccessRepository);

	projects.P1 = await createTeamProject('Project One');
	projects.P2 = await createTeamProject('Project Two');
	projects.P3 = await createTeamProject('Project Three');
	const member = await createMember();
	projects.personal = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
		member.id,
	);
	// The name of a personal project comes from the random name of its user.
	await Container.get(ProjectRepository).update(projects.personal.id, { name: 'Personal' });
	for (const [label, project] of Object.entries(projects)) recorder.label(project.id, label);

	// Not in the order of the keys, so that a sorted result shows up.
	await createConnection('p1-on', true, [{ project: 'P1' }]);
	await createConnection('g-on', true);
	await createConnection('shared-p2-p1', true, [{ project: 'P2' }, { project: 'P1' }]);
	await createConnection('g-off', false);
	await createConnection('p1-off', false, [{ project: 'P1' }]);
	await createConnection('p1-owner', true, [{ project: 'P1', role: 'owner' }]);
	await createConnection('p2-on', true, [{ project: 'P2', role: 'user' }]);
	await createConnection('personal-on', true, [{ project: 'personal' }]);
	await createConnection('a-global', true);

	await createCredential('of P1, shared with P2', [
		{ project: 'P1', role: 'credential:owner' },
		{ project: 'P2', role: 'credential:user' },
	]);
	await createCredential('of P3', [{ project: 'P3', role: 'credential:owner' }]);
	await createCredential('of the personal project', [
		{ project: 'personal', role: 'credential:owner' },
	]);
	await createCredential('only shared with P2', [{ project: 'P2', role: 'credential:user' }]);
	await createCredential('without sharing', []);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('Repositories of the secrets provider connections', () => {
	test('findIdByProviderKey', async () => {
		const result: Record<string, unknown> = {};
		for (const key of ['g-on', 'g-off', 'p1-on', 'p1-off', 'shared-p2-p1', 'missing', 'G-ON', '']) {
			result[key] = await attempt(async () => await connections.findIdByProviderKey(key));
		}
		expect(result).toMatchSnapshot();
	});

	test('findIdsByProviderKeys', async () => {
		const lists: Record<string, string[]> = {
			'no keys': [],
			'one key': ['p2-on'],
			'keys in another order': ['p2-on', 'g-on', 'p1-on'],
			'missing and disabled keys': ['missing', 'g-off', 'p1-off', 'g-on'],
			'the same key twice': ['g-on', 'g-on'],
			'only missing keys': ['missing', 'other'],
		};
		const result: Record<string, unknown> = {};
		for (const [label, keys] of Object.entries(lists)) {
			result[label] = await attempt(async () => await connections.findIdsByProviderKeys(keys));
		}
		expect(result).toMatchSnapshot();
	});

	test('findEnabledGlobalConnections', async () => {
		const result: Record<string, unknown> = {
			'without options': await attempt(
				async () => await connections.findEnabledGlobalConnections(),
			),
			'with empty options': await attempt(
				async () => await connections.findEnabledGlobalConnections({}),
			),
			'with provider keys': await attempt(
				async () =>
					await connections.findEnabledGlobalConnections({
						providerKeys: ['a-global', 'g-off', 'p1-on', 'missing'],
					}),
			),
			'with no provider keys': await attempt(
				async () => await connections.findEnabledGlobalConnections({ providerKeys: [] }),
			),
		};
		expect(result).toMatchSnapshot();
	});

	test('findEnabledByProjectId', async () => {
		const result: Record<string, unknown> = {};
		for (const project of ['P1', 'P2', 'P3', 'personal']) {
			result[project] = await attempt(
				async () => await connections.findEnabledByProjectId(projects[project].id),
			);
		}
		result['P1 with provider keys'] = await attempt(
			async () =>
				await connections.findEnabledByProjectId(projects.P1.id, {
					providerKeys: ['p1-owner', 'p1-off', 'g-on', 'shared-p2-p1'],
				}),
		);
		result['P1 with no provider keys'] = await attempt(
			async () => await connections.findEnabledByProjectId(projects.P1.id, { providerKeys: [] }),
		);
		result['a project that does not exist'] = await attempt(
			async () => await connections.findEnabledByProjectId('00000000-0000-0000-0000-000000000000'),
		);
		expect(result).toMatchSnapshot();
	});

	test('findAllAccessibleProviderKeysByCredentialId', async () => {
		const result: Record<string, unknown> = {};
		for (const [name, id] of credentialIds) {
			result[name] = await attempt(
				async () => await connections.findAllAccessibleProviderKeysByCredentialId(id),
			);
		}
		result['a credential that does not exist'] = await attempt(
			async () => await connections.findAllAccessibleProviderKeysByCredentialId('missing'),
		);
		expect(result).toMatchSnapshot();
	});

	test('the access rows', async () => {
		const rows = await access.find({
			order: { secretsProviderConnectionId: 'ASC', projectId: 'ASC' },
		});
		expect(
			labelled(
				rows.map(({ secretsProviderConnectionId, projectId, role }) => ({
					secretsProviderConnectionId,
					projectId,
					role,
				})),
			),
		).toMatchSnapshot();
	});
});
