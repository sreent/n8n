// The behaviour of the project API of the external secrets module
// (`/rest/secret-providers/projects/:projectId/connections`), the completions of the secrets and
// the provider types, for the users of a project. The fixture has two team projects, a personal
// project, global and project connections, and users with each project role and two custom roles.
// The test records the project API of the owner step by step, and then the access of each user
// with the setting of the system roles off and on.
// The snapshot records what n8n does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
import { createTeamProject, linkUserToProject, mockInstance } from '@n8n/backend-test-utils';
import type { Project, User } from '@n8n/db';
import { ProjectRelationRepository, ProjectRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type { AssignableProjectRole } from '@n8n/permissions';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at the files of `@/modules/external-secrets.ee` (FORK.md lists the
// paths).
import { ExternalSecretsConfig } from '@/modules/external-secrets/external-secrets.config';
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';

import { createCustomRoleWithScopeSlugs } from '@test-integration/db/roles';
import { createAdmin, createMember, createOwner } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import { setupTestServer } from '@test-integration/utils';

import {
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
	behaviours,
} from './harness';

testProviders.setProviders({
	vault: providerType('vault', 'Vault'),
	awsSecretsManager: providerType('awsSecretsManager', 'AWS Secrets Manager'),
});
behaviours.get('awsSecretsManager')!.secrets = { awsSecret: 'aws value' };
mockInstance(ExternalSecretsProviders, testProviders);

const config = Container.get(ExternalSecretsConfig);
config.externalSecretsForProjects = true;
config.externalSecretsMultipleConnections = false;
config.externalSecretsRoleBasedAccess = true;

const testServer = setupTestServer({
	endpointGroups: ['externalSecrets'],
	enabledFeatures: ['feat:externalSecrets'],
	modules: ['external-secrets'],
});

const USERS = [
	'owner',
	'admin',
	'member',
	'p1Admin',
	'p1Editor',
	'p1Viewer',
	'p1Reader',
	'p1Manager',
	'p2Admin',
] as const;
type UserName = (typeof USERS)[number];

const agents = {} as Record<UserName, SuperAgentTest>;
const users = {} as Record<UserName, User>;
const projects: Record<string, Project> = {};

const PROVIDER_SCOPES = [
	'externalSecretsProvider:create',
	'externalSecretsProvider:read',
	'externalSecretsProvider:update',
	'externalSecretsProvider:delete',
	'externalSecretsProvider:list',
	'externalSecretsProvider:sync',
	'externalSecret:list',
];

const call = async (
	label: string,
	method: Method,
	url: string,
	body?: unknown,
	agent: SuperAgentTest = agents.owner,
) => await request(agent, label, method, url, body);

const connection = (providerKey: string, type = 'vault') => ({
	providerKey,
	type,
	projectIds: [],
	settings: { username: `user of ${providerKey}`, password: 'secret' },
});

async function addToProject(user: User, project: Project, role: AssignableProjectRole | string) {
	await linkUserToProject(user, project, role as AssignableProjectRole);
}

beforeAll(async () => {
	users.owner = await createOwner();
	users.admin = await createAdmin();
	for (const name of USERS.slice(2)) users[name] = await createMember();
	for (const name of USERS) {
		recorder.label(users[name].id, name);
		agents[name] = testServer.authAgentFor(users[name]);
	}

	projects.P1 = await createTeamProject('Project One');
	projects.P2 = await createTeamProject('Project Two');
	projects.personal = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
		users.member.id,
	);
	// The name of a personal project comes from the random name of its user.
	await Container.get(ProjectRepository).update(projects.personal.id, { name: 'Personal' });
	for (const [label, project] of Object.entries(projects)) recorder.label(project.id, label);

	const reader = await createCustomRoleWithScopeSlugs(
		[
			'project:read',
			'externalSecretsProvider:read',
			'externalSecretsProvider:list',
			'externalSecret:list',
		],
		{ slug: 'custom:secrets-reader', displayName: 'Secrets reader', roleType: 'project' },
	);
	const manager = await createCustomRoleWithScopeSlugs(['project:read', ...PROVIDER_SCOPES], {
		slug: 'custom:secrets-manager',
		displayName: 'Secrets manager',
		roleType: 'project',
	});

	await addToProject(users.p1Admin, projects.P1, 'project:admin');
	await addToProject(users.p1Editor, projects.P1, 'project:editor');
	await addToProject(users.p1Viewer, projects.P1, 'project:viewer');
	await addToProject(users.p1Reader, projects.P1, reader.slug);
	await addToProject(users.p1Manager, projects.P1, manager.slug);
	await addToProject(users.p2Admin, projects.P2, 'project:admin');

	captureEventsAndCommands();
	await settle();
	setStep('fixture');
	await call(
		'global connection',
		'post',
		'/secret-providers/connections',
		connection('globalVault'),
	);
	await call('connection of P1', 'post', '/secret-providers/connections', {
		...connection('p1User', 'awsSecretsManager'),
		projectIds: [projects.P1.id],
	});
	await call('connection of P2', 'post', '/secret-providers/connections', {
		...connection('p2Conn'),
		projectIds: [projects.P2.id],
	});
	await call('disabled connection of P1', 'post', '/secret-providers/connections', {
		...connection('p1Disabled'),
		projectIds: [projects.P1.id],
	});
	await call('disable', 'patch', '/secret-providers/connections/p1Disabled', { isEnabled: false });
	resetLogs();
});

const P1 = () => `/secret-providers/projects/${projects.P1.id}/connections`;
const P2 = () => `/secret-providers/projects/${projects.P2.id}/connections`;

describe('Project API of external secrets', () => {
	test('the fixture', async () => {
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('the connections of a project', async () => {
		expect([
			await call('list of P1', 'get', P1()),
			await call('list of P2', 'get', P2()),
			await call(
				'list of the personal project',
				'get',
				`/secret-providers/projects/${projects.personal.id}/connections`,
			),
			await call(
				'list of a missing project',
				'get',
				'/secret-providers/projects/missing/connections',
			),
			await call('one of P1', 'get', `${P1()}/p1User`),
			await call('a disabled one of P1', 'get', `${P1()}/p1Disabled`),
			await call('a global one', 'get', `${P1()}/globalVault`),
			await call('one of P2', 'get', `${P1()}/p2Conn`),
			await call('a missing one', 'get', `${P1()}/missing`),
		]).toMatchSnapshot();
	});

	test('create a connection in a project', async () => {
		const create = await call('create', 'post', P1(), {
			...connection('p1Owned'),
			projectIds: [projects.P2.id],
		});
		expect({
			create,
			stored: await storedState(),
			proxy: proxyView(),
			after: [
				await call('list of P1', 'get', P1()),
				await call('list of P2', 'get', P2()),
				await call('global list', 'get', '/secret-providers/connections'),
				await call('global one', 'get', '/secret-providers/connections/p1Owned'),
			],
		}).toMatchSnapshot();
	});

	test('create errors in a project', async () => {
		expect([
			await call('a key that exists', 'post', P1(), connection('globalVault')),
			await call(
				'a missing project',
				'post',
				'/secret-providers/projects/missing/connections',
				connection('missingProject'),
			),
			await call(
				'the personal project',
				'post',
				`/secret-providers/projects/${projects.personal.id}/connections`,
				connection('personalOwned'),
			),
			await call('invalid key', 'post', P1(), connection('with-dash')),
			await call('no project IDs', 'post', P1(), {
				providerKey: 'noProjectIds',
				type: 'vault',
				settings: {},
			}),
		]).toMatchSnapshot();
		expect(await storedState()).toMatchSnapshot();
	});

	test('update connections in a project', async () => {
		expect([
			await call('an owned one', 'patch', `${P1()}/p1Owned`, {
				settings: { username: 'changed' },
				projectIds: [projects.P2.id],
			}),
			await call('an owned one, disable', 'patch', `${P1()}/p1Owned`, { isEnabled: false }),
			await call('an owned one, enable', 'patch', `${P1()}/p1Owned`, { isEnabled: true }),
			await call('a used one', 'patch', `${P1()}/p1User`, { settings: { username: 'changed' } }),
			await call('a global one', 'patch', `${P1()}/globalVault`, { settings: { username: 'x' } }),
			await call('one of P2', 'patch', `${P1()}/p2Conn`, { settings: { username: 'x' } }),
			await call('a missing one', 'patch', `${P1()}/missing`, { settings: { username: 'x' } }),
			await call('change the type without settings', 'patch', `${P1()}/p1Owned`, {
				type: 'awsSecretsManager',
			}),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('test connections in a project', async () => {
		expect([
			await call('an owned one', 'post', `${P1()}/p1Owned/test`),
			await call('a used one', 'post', `${P1()}/p1User/test`),
			await call('a global one', 'post', `${P1()}/globalVault/test`),
			await call('one of P2', 'post', `${P1()}/p2Conn/test`),
			await call('a missing one', 'post', `${P1()}/missing/test`),
			await call('reload is not a project route', 'post', `${P1()}/p1Owned/reload`),
		]).toMatchSnapshot();
	});

	test('delete connections in a project', async () => {
		await call('another owned one', 'post', P1(), connection('p1Owned2'));
		expect([
			await call('a global one', 'delete', `${P1()}/globalVault`),
			await call('one of P2', 'delete', `${P1()}/p2Conn`),
			await call('a used one', 'delete', `${P1()}/p1User`),
			await call('an owned one', 'delete', `${P1()}/p1Owned2`),
			await call('a missing one', 'delete', `${P1()}/missing`),
		]).toMatchSnapshot();
		expect({ stored: await storedState(), proxy: proxyView() }).toMatchSnapshot();
	});

	test('the completions and the types', async () => {
		expect([
			await call('global', 'get', '/secret-providers/completions/secrets/global'),
			await call(
				'global for P1',
				'get',
				`/secret-providers/completions/secrets/global/${projects.P1.id}`,
			),
			await call(
				'project P1',
				'get',
				`/secret-providers/completions/secrets/project/${projects.P1.id}`,
			),
			await call(
				'project P2',
				'get',
				`/secret-providers/completions/secrets/project/${projects.P2.id}`,
			),
			await call(
				'a missing project',
				'get',
				'/secret-providers/completions/secrets/project/missing',
			),
			await call('types', 'get', '/secret-providers/types'),
			await call('one type', 'get', '/secret-providers/types/vault'),
			await call('a type that is not registered', 'get', '/secret-providers/types/azureKeyVault'),
			await call('an unknown type', 'get', '/secret-providers/types/other'),
		]).toMatchSnapshot();
	});

	const runs: Array<[systemRoles: boolean, roleBasedAccess: boolean]> = [
		[false, true],
		[true, true],
		[true, false],
	];
	for (const [systemRoles, roleBasedAccess] of runs) {
		const label = `the system roles ${systemRoles ? 'on' : 'off'}${roleBasedAccess ? '' : ' and without role-based access'}`;
		test(`the access of each user with ${label}`, async () => {
			config.externalSecretsRoleBasedAccess = roleBasedAccess;
			const toggle = await call('toggle', 'post', '/external-secrets/settings', {
				systemRolesEnabled: systemRoles,
			});
			const result: Record<string, unknown> = {
				toggle: toggle.status === 200 ? 200 : { status: toggle.status, response: toggle.response },
				roles: ((await storedState()) as { roles: unknown }).roles,
			};
			for (const name of USERS) {
				const agent = agents[name];
				const key = `by${name}${systemRoles ? 'On' : 'Off'}${roleBasedAccess ? '' : 'NoRoles'}`;
				const short = async (step: string, method: Method, url: string, body?: unknown) => {
					const answer = await call(`${name} ${step}`, method, url, body, agent);
					const data = (answer.response as { data?: unknown }).data;
					return answer.status >= 400
						? answer.status
						: { status: answer.status, data: summary(data), events: answer.events.length };
				};
				const row: Record<string, unknown> = {
					'list of P1': await short('list', 'get', P1()),
					'one of P1': await short('get', 'get', `${P1()}/p1Owned`),
					'a global one in P1': await short('get global', 'get', `${P1()}/globalVault`),
					create: await short('create', 'post', P1(), connection(key)),
				};
				const created =
					(await call('check', 'get', `/secret-providers/connections/${key}`)).status === 200;
				if (!created) await call('create as owner', 'post', P1(), connection(key));
				row.update = await short('update', 'patch', `${P1()}/${key}`, {
					settings: { username: name },
				});
				row.test = await short('test', 'post', `${P1()}/${key}/test`);
				row.delete = await short('delete', 'delete', `${P1()}/${key}`);
				await call('clean up', 'delete', `/secret-providers/connections/${key}`);
				row['list of P2'] = await short('list of P2', 'get', P2());
				row['completions of P1'] = await short(
					'completions',
					'get',
					`/secret-providers/completions/secrets/project/${projects.P1.id}`,
				);
				row['global completions for P1'] = await short(
					'global completions for P1',
					'get',
					`/secret-providers/completions/secrets/global/${projects.P1.id}`,
				);
				row['global completions'] = await short(
					'global completions',
					'get',
					'/secret-providers/completions/secrets/global',
				);
				row.types = await short('types', 'get', '/secret-providers/types');
				row['global list'] = await short('global list', 'get', '/secret-providers/connections');
				row['old API secrets'] = await short('old API secrets', 'get', '/external-secrets/secrets');
				result[name] = row;
			}
			config.externalSecretsRoleBasedAccess = true;
			expect(result).toMatchSnapshot();
		}, 180_000);
	}

	test('the project roles after the toggles', async () => {
		expect(await storedState()).toMatchSnapshot();
		const relations = await Container.get(ProjectRelationRepository).find({
			where: { projectId: projects.P1.id },
			relations: { role: true },
		});
		expect(
			relations.map((relation) => recorder.normalize([relation.userId, relation.role.slug])).sort(),
		).toMatchSnapshot();
		expect(takeLogs()).toMatchSnapshot();
	});
});

/** A short form of an answer: the names of the connections and their scopes, or the data. */
function summary(data: unknown): unknown {
	if (Array.isArray(data)) {
		return data.map((entry: unknown) =>
			entry !== null && typeof entry === 'object' && 'name' in entry
				? [entry.name, (entry as { scopes?: unknown }).scopes ?? '<no scopes>']
				: entry !== null && typeof entry === 'object' && 'type' in entry
					? (entry as { type: unknown }).type
					: entry,
		);
	}
	if (data !== null && typeof data === 'object' && 'name' in data) {
		return [data.name, (data as { scopes?: unknown }).scopes ?? '<no scopes>'];
	}
	return data;
}
