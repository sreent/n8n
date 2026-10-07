// The behaviour of `ProjectService`: for a fixed set of users, projects and resources, what each
// method returns, which error it throws, which events it emits and what it changes in the
// database. The snapshot records what n8n does, so a change in behaviour shows up as a snapshot
// diff. packages/cli/src/services/FORK.md tells how the fork made the snapshot.
import type { UpdateProjectDto } from '@n8n/api-types';
import { LicenseState, ModuleRegistry } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import {
	createActiveWorkflow,
	createTeamProject,
	createWorkflow,
	linkUserToProject,
	mockInstance,
	shareWorkflowWithProjects,
	testDb,
	testModules,
} from '@n8n/backend-test-utils';
import type { BooleanLicenseFeature } from '@n8n/constants';
import type { Project, Role, User } from '@n8n/db';
import {
	GLOBAL_ADMIN_ROLE,
	GLOBAL_CHAT_USER_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRepository,
	ProjectSecretsProviderAccess,
	SecretsProviderConnection,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type { Scope } from '@n8n/permissions';
import type { MockInstance } from 'vitest';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { License } from '@/license';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { ExternalSecretsConfig } from '@/modules/external-secrets.ee/external-secrets.config';
import { OwnershipTransferHandlerRegistry } from '@/services/ownership-transfer/ownership-transfer-handler.registry';
import { ProjectService } from '@/services/project.service';

import {
	createCredentials,
	saveCredential,
	shareCredentialWithProjects,
} from '@test-integration/db/credentials';
import { createDataTable } from '@test-integration/db/data-tables';
import { createFolder } from '@test-integration/db/folders';
import { createCustomRoleWithScopeSlugs } from '@test-integration/db/roles';
import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import { LicenseMocker } from '@test-integration/license';

const activeWorkflowManager = mockInstance(ActiveWorkflowManager);

const FEATURES: BooleanLicenseFeature[] = [
	'feat:advancedPermissions',
	'feat:projectRole:admin',
	'feat:projectRole:editor',
	'feat:projectRole:viewer',
	'feat:customRoles',
];
const license = new LicenseMocker();

/** Run `fn` with a changed licence, then restore the full licence. */
async function withLicense<T>(
	change: {
		enable?: BooleanLicenseFeature[];
		disable?: BooleanLicenseFeature[];
		maxTeamProjects?: number;
	},
	fn: () => Promise<T>,
): Promise<T> {
	for (const feature of change.enable ?? []) license.enable(feature);
	for (const feature of change.disable ?? []) license.disable(feature);
	if (change.maxTeamProjects !== undefined) {
		license.setQuota('quota:maxTeamProjects', change.maxTeamProjects);
	}
	try {
		return await fn();
	} finally {
		for (const feature of change.enable ?? []) license.disable(feature);
		for (const feature of FEATURES) license.enable(feature);
		license.setQuota('quota:maxTeamProjects', -1);
	}
}

/** Run `fn` with external secrets for projects licensed and configured as given. */
async function withProjectSecrets<T>(
	setup: { active: boolean; licensed: boolean; forProjects: boolean },
	fn: () => Promise<T>,
): Promise<T> {
	const config = Container.get(ExternalSecretsConfig);
	const forProjects = config.externalSecretsForProjects;
	const activeModules = Container.get(ModuleRegistry).getActiveModules();
	if (setup.active) activeModules.push('external-secrets');
	if (setup.licensed) license.enable('feat:externalSecrets');
	config.externalSecretsForProjects = setup.forProjects;
	try {
		return await fn();
	} finally {
		license.disable('feat:externalSecrets');
		config.externalSecretsForProjects = forProjects;
		activeModules.splice(activeModules.indexOf('external-secrets'), setup.active ? 1 : 0);
	}
}

const recorder = new GoldenRecorder();
const {
	labels,
	connectionLabels,
	labelString,
	normalize,
	describeError,
	dumpDb,
	diffDumps,
	labelNewRows,
} = recorder;

// #region Fixture

let emitSpy: MockInstance<EventService['emit']>;
let projectService: ProjectService;

const roles: Record<string, Role> = {};

type Fixture = {
	users: Record<string, User>;
	projects: Record<string, Project>;
	ids: Record<string, string>;
};

let fixture: Fixture;

const USER_LABELS = [
	'owner',
	'admin',
	'adminDisabled',
	'memberA',
	'memberB',
	'memberC',
	'memberD',
	'chatUser',
	'customGlobal',
	'listOnly',
	'readOnly',
	'pending',
] as const;
type UserLabel = (typeof USER_LABELS)[number];

const TEAM_LABELS = ['alpha', 'beta', 'gamma', 'delta'] as const;
const PROJECT_LABELS = [
	...TEAM_LABELS,
	...USER_LABELS.map((user) => `personal:${user}`),
	'missing',
];

function label(id: string, name: string) {
	labels.set(id, name);
	return id;
}

async function seed(): Promise<Fixture> {
	await testDb.truncate([
		'ProjectSecretsProviderAccess',
		'SecretsProviderConnection',
		'SharedWorkflow',
		'SharedCredentials',
		'WorkflowEntity',
		'CredentialsEntity',
		'Folder',
		'DataTable',
		'ProjectRelation',
		'Project',
		'User',
	]);
	labels.clear();
	connectionLabels.clear();

	const roleOf: Record<UserLabel, Role> = {
		owner: GLOBAL_OWNER_ROLE,
		admin: GLOBAL_ADMIN_ROLE,
		adminDisabled: GLOBAL_ADMIN_ROLE,
		memberA: GLOBAL_MEMBER_ROLE,
		memberB: GLOBAL_MEMBER_ROLE,
		memberC: GLOBAL_MEMBER_ROLE,
		memberD: GLOBAL_MEMBER_ROLE,
		chatUser: GLOBAL_CHAT_USER_ROLE,
		customGlobal: roles.globalLister,
		listOnly: roles.globalListOnly,
		readOnly: roles.globalReadOnly,
		pending: GLOBAL_MEMBER_ROLE,
	};
	const users = {} as Record<string, User>;
	const projects: Record<string, Project> = {};
	const ids: Record<string, string> = { missing: 'missing-project' };
	for (const user of USER_LABELS) {
		users[user] = await createUser({
			email: `${user.toLowerCase()}@example.com`,
			firstName: user,
			lastName: 'Test',
			role: roleOf[user],
			disabled: user === 'adminDisabled',
			...(user === 'pending' ? { password: null } : {}),
		});
		label(users[user].id, user);
		const personal = await Container.get(ProjectRepository).getPersonalProjectForUser(
			users[user].id,
		);
		if (!personal) throw new Error(`No personal project for ${user}`);
		projects[`personal:${user}`] = personal;
		label(projects[`personal:${user}`].id, `personal:${user}`);
	}

	projects.alpha = await createTeamProject('Alpha', users.memberA);
	projects.beta = await createTeamProject('Banana Beta', users.memberB);
	projects.gamma = await createTeamProject('Gamma');
	projects.delta = await createTeamProject('Delta');
	for (const team of TEAM_LABELS) label(projects[team].id, team);
	for (const [project, user, role] of [
		['alpha', 'memberB', 'project:editor'],
		['alpha', 'memberC', 'project:viewer'],
		['alpha', 'admin', 'project:editor'],
		['alpha', 'memberD', roles.projectRunner.slug],
		['beta', 'chatUser', 'project:chatUser'],
		['beta', 'pending', 'project:viewer'],
		['delta', 'memberA', roles.projectManager.slug],
		['delta', 'owner', 'project:viewer'],
	] as const) {
		await linkUserToProject(users[user], projects[project], role as 'project:viewer');
	}
	for (const [key, project] of Object.entries(projects)) ids[key] = project.id;

	const alphaWorkflow = await createWorkflow({ name: 'alpha workflow' }, projects.alpha);
	await shareWorkflowWithProjects(alphaWorkflow, [
		{ project: projects.beta, role: 'workflow:editor' },
	]);
	const alphaActive = await createActiveWorkflow({ name: 'alpha active' }, projects.alpha);
	const betaWorkflow = await createWorkflow({ name: 'beta workflow' }, projects.beta);
	await shareWorkflowWithProjects(betaWorkflow, [
		{ project: projects.alpha, role: 'workflow:editor' },
	]);
	const personalWorkflow = await createWorkflow(
		{ name: 'personal workflow' },
		projects['personal:memberA'],
	);
	ids.alphaWorkflow = label(alphaWorkflow.id, 'alphaWorkflow');
	ids.alphaActive = label(alphaActive.id, 'alphaActive');
	ids.betaWorkflow = label(betaWorkflow.id, 'betaWorkflow');
	ids.personalWorkflow = label(personalWorkflow.id, 'personalWorkflow');
	ids.missingWorkflow = 'missing-workflow';

	const alphaCredential = await saveCredential(
		{ name: 'alpha credential', type: 'githubApi', data: { accessToken: 'x' } },
		{ project: projects.alpha, role: 'credential:owner' },
	);
	await shareCredentialWithProjects(alphaCredential, [projects.beta]);
	const endUserCredential = await createCredentials(
		{ name: 'End-user credential', type: 'githubApi', data: '', isResolvable: true },
		projects.alpha,
	);
	const betaCredential = await saveCredential(
		{ name: 'beta credential', type: 'githubApi', data: { accessToken: 'x' } },
		{ project: projects.beta, role: 'credential:owner' },
	);
	await shareCredentialWithProjects(betaCredential, [projects.alpha]);
	label(alphaCredential.id, 'alphaCredential');
	label(endUserCredential.id, 'endUserCredential');
	const secondEndUserCredential = await createCredentials(
		{ name: 'Second end-user credential', type: 'githubApi', data: '', isResolvable: true },
		projects.alpha,
	);
	label(secondEndUserCredential.id, 'secondEndUserCredential');
	label(betaCredential.id, 'betaCredential');

	const folder = await createFolder(projects.alpha, { name: 'alpha folder' });
	label(folder.id, 'alphaFolder');
	label(
		(await createFolder(projects.alpha, { name: 'alpha child', parentFolder: folder })).id,
		'alphaChild',
	);
	label((await createFolder(projects.beta, { name: 'alpha folder' })).id, 'betaFolder');
	label((await createDataTable(projects.alpha, { name: 'alpha table' })).id, 'alphaTable');
	label((await createDataTable(projects.beta, { name: 'beta table' })).id, 'betaTable');

	const manager = Container.get(ProjectRepository).manager;
	for (const [providerKey, access] of [
		['alphaOwned', [['alpha', 'secretsProviderConnection:owner']]],
		['betaOwned', [['beta', 'secretsProviderConnection:owner']]],
		[
			'sharedAlphaBeta',
			[
				['alpha', 'secretsProviderConnection:user'],
				['beta', 'secretsProviderConnection:user'],
			],
		],
		['sharedAlpha', [['alpha', 'secretsProviderConnection:user']]],
		['sharedBeta', [['beta', 'secretsProviderConnection:user']]],
		['disabledBeta', [['beta', 'secretsProviderConnection:user']]],
	] as const) {
		const connection = await manager.save(
			manager.create(SecretsProviderConnection, {
				providerKey,
				type: 'awsSecretsManager',
				encryptedSettings: 'x',
				isEnabled: providerKey !== 'disabledBeta',
			}),
		);
		connectionLabels.set(connection.id, providerKey);
		for (const [project, role] of access) {
			await manager.insert(ProjectSecretsProviderAccess, {
				secretsProviderConnectionId: connection.id,
				projectId: projects[project].id,
				role,
			});
		}
	}

	labels.set('missing-project', 'missing');
	return { users, projects, ids };
}

const user = (name: string) => fixture.users[name];
const projectId = (name: string) => fixture.ids[name];

// #endregion

// #region Observation

type Outcome = {
	result?: unknown;
	error?: string;
	events?: unknown[];
	activeWorkflowManager?: unknown[];
	db?: ReturnType<typeof diffDumps>;
};

const AWM_METHODS = ['add', 'remove', 'clearWebhooks', 'removeActivationError'] as const;

function resetCalls() {
	emitSpy.mockClear();
	for (const method of AWM_METHODS) activeWorkflowManager[method].mockClear();
}

function collectCalls(outcome: Outcome) {
	const events = emitSpy.mock.calls.map(([name, payload]) => [name, normalize(payload)]);
	if (events.length > 0) outcome.events = events;
	const calls = AWM_METHODS.flatMap((method) =>
		activeWorkflowManager[method].mock.calls.map((args) => [method, normalize(args)]),
	);
	if (calls.length > 0) outcome.activeWorkflowManager = calls;
}

/** Call a reading method. The database is checked once for all of them. */
async function read(run: () => Promise<unknown>): Promise<Outcome> {
	resetCalls();
	const outcome: Outcome = {};
	try {
		outcome.result = normalize(await run());
	} catch (error) {
		outcome.error = describeError(error);
	}
	collectCalls(outcome);
	return outcome;
}

/** Seed the fixture again, call a changing method, and record what changed. */
async function write(run: () => Promise<unknown>): Promise<Outcome> {
	fixture = await seed();
	const before = await dumpDb();
	resetCalls();
	const outcome: Outcome = {};
	try {
		const result = await run();
		await labelNewRows();
		outcome.result = normalize(result);
	} catch (error) {
		await labelNewRows();
		outcome.error = describeError(error);
	}
	collectCalls(outcome);
	const db = diffDumps(before, await dumpDb());
	if (Object.keys(db).length > 0) outcome.db = db;
	return outcome;
}

/** The labels of the projects (or ids) in a result, in the order the method gives them. */
function projectLabels(projects: Array<{ id: string } | string>) {
	return projects.map((project) => labelString(typeof project === 'string' ? project : project.id));
}

// #endregion

beforeAll(async () => {
	await testModules.loadModules(['data-table', 'external-secrets']);
	await testDb.init();
	// Scenarios turn the external secrets module on where they need it.
	const activeModules = Container.get(ModuleRegistry).getActiveModules();
	activeModules.splice(activeModules.indexOf('external-secrets'), 1);

	license.mock(Container.get(License));
	license.mockLicenseState(Container.get(LicenseState));
	for (const feature of FEATURES) license.enable(feature);
	license.setQuota('quota:maxTeamProjects', -1);

	// Production registers this handler in the data table module's `init`, which tests do not run.
	Container.get(OwnershipTransferHandlerRegistry).register({
		resource: 'data-table',
		transferAll: async (fromProjectId, toProjectId, trx) => {
			await Container.get(DataTableService).transferDataTablesByProjectId(
				fromProjectId,
				toProjectId,
				trx,
			);
		},
		deleteAll: async (projectId) => {
			await Container.get(DataTableService).deleteDataTableByProjectId(projectId);
		},
	});

	roles.globalLister = await createCustomRoleWithScopeSlugs(
		['project:list', 'project:read', 'workflow:read'],
		{ slug: 'custom:global-lister', displayName: 'Global Lister', roleType: 'global' },
	);
	roles.globalListOnly = await createCustomRoleWithScopeSlugs(['project:list'], {
		slug: 'custom:global-list-only',
		displayName: 'Global List Only',
		roleType: 'global',
	});
	roles.globalReadOnly = await createCustomRoleWithScopeSlugs(['project:read'], {
		slug: 'custom:global-read-only',
		displayName: 'Global Read Only',
		roleType: 'global',
	});
	roles.projectRunner = await createCustomRoleWithScopeSlugs(
		['project:read', 'workflow:read', 'workflow:create', 'credential:read'],
		{ slug: 'custom:project-runner', displayName: 'Project Runner', roleType: 'project' },
	);
	roles.projectManager = await createCustomRoleWithScopeSlugs(
		['project:read', 'project:list', 'project:manageMembers'],
		{ slug: 'custom:project-manager', displayName: 'Project Manager', roleType: 'project' },
	);

	projectService = Container.get(ProjectService);
	fixture = await seed();
});

// The vitest config restores spies after each test, so each test needs a new one.
beforeEach(() => {
	emitSpy = vi.spyOn(Container.get(EventService), 'emit');
});

afterAll(async () => {
	await testDb.terminate();
});

const SCOPE_SETS: Scope[][] = [
	[],
	['project:list'],
	['project:read'],
	['project:update'],
	['project:delete'],
	['project:manageMembers'],
	['project:export'],
	['workflow:read'],
	['workflow:create'],
	['credential:create'],
	['folder:list'],
	['dataTable:create'],
	['workflow:read', 'workflow:create'],
];

const LIST_OPTIONS = [
	{},
	{ take: 3 },
	{ skip: 2, take: 3 },
	{ search: 'banana' },
	{ search: 'ALPHA', type: 'team' as const },
	{ type: 'team' as const },
	{ type: 'personal' as const },
	{ activated: true },
];

describe('ProjectService', () => {
	test('reading methods', async () => {
		const outcomes: Record<string, unknown> = {};
		const before = await dumpDb();
		const project = (name: string) => fixture.projects[name];

		// A compact matrix: one letter per scope set. P: the project, N: null, E: an error.
		const withScope: Record<string, string> = {};
		const withScopeErrors: Record<string, string> = {};
		for (const userLabel of USER_LABELS) {
			for (const projectLabel of PROJECT_LABELS) {
				let row = '';
				for (const scopes of SCOPE_SETS) {
					const { result, error } = await read(
						async () =>
							await projectService.getProjectWithScope(
								user(userLabel),
								projectId(projectLabel),
								scopes,
							),
					);
					if (error) {
						row += 'E';
						withScopeErrors[`${userLabel} | ${projectLabel} | ${scopes.join(',')}`] = error;
					} else if (result === null) {
						row += 'N';
					} else {
						row += (result as { id: string }).id === `@${projectLabel}` ? 'P' : '?';
					}
				}
				withScope[`${userLabel} | ${projectLabel}`] = row;
			}
		}
		outcomes['getProjectWithScope matrix'] = withScope;
		outcomes['getProjectWithScope errors'] = withScopeErrors;
		outcomes['getProjectWithScope result'] = await read(
			async () =>
				await projectService.getProjectWithScope(user('memberA'), projectId('alpha'), [
					'project:read',
				]),
		);
		outcomes['getProjectWithScope in a transaction'] = await read(
			async () =>
				await Container.get(ProjectRepository).manager.transaction(
					async (trx) =>
						await projectService.getProjectWithScope(
							user('memberB'),
							projectId('alpha'),
							['workflow:create'],
							trx,
						),
				),
		);

		const idsWithScope: Record<string, unknown> = {};
		for (const userLabel of USER_LABELS) {
			for (const scopes of SCOPE_SETS) {
				for (const [listLabel, list] of [
					['all', undefined],
					['alpha,beta,missing', [projectId('alpha'), projectId('beta'), 'missing-project']],
					['none', []],
				] as const) {
					const { result, error } = await read(
						async () =>
							await projectService.getProjectIdsWithScope(
								user(userLabel),
								scopes,
								list ? [...list] : undefined,
							),
					);
					idsWithScope[`${userLabel} | ${scopes.join(',')} | ${listLabel}`] =
						error ?? (result as string[]).slice().sort().join(' ');
				}
			}
		}
		outcomes.getProjectIdsWithScope = idsWithScope;

		for (const userLabel of USER_LABELS) {
			outcomes[`getProjectRelationsForUser ${userLabel}`] = await read(async () => {
				const relations = await projectService.getProjectRelationsForUser(user(userLabel));
				return relations.map((relation) => ({
					...relation,
					role: { ...relation.role, scopes: relation.role.scopes.map((s) => s.slug).sort() },
				}));
			});
			outcomes[`getPersonalProject ${userLabel}`] = await read(
				async () => await projectService.getPersonalProject(user(userLabel)),
			);
			outcomes[`getAccessibleProjects ${userLabel}`] = await read(
				async () => await projectService.getAccessibleProjects(user(userLabel)),
			);
			outcomes[`getMyProjects ${userLabel}`] = await read(async () => {
				const projects = await projectService.getMyProjects(user(userLabel));
				return projects.map((p) => ({ ...p, scopes: p.scopes?.slice().sort() }));
			});
			for (const options of LIST_OPTIONS) {
				const key = JSON.stringify(options);
				outcomes[`getAccessibleProjectsAndCount ${userLabel} ${key}`] = await read(async () => {
					const { projects, count } = await projectService.getAccessibleProjectsAndCount(
						user(userLabel),
						options,
					);
					return { projects: projectLabels(projects), count };
				});
				outcomes[`getShareableProjectsAndCount ${userLabel} ${key}`] = await read(async () => {
					const { projects, count } = await projectService.getShareableProjectsAndCount(
						user(userLabel),
						options,
					);
					return { projects: projectLabels(projects), count };
				});
			}
			outcomes[`addUserScopes ${userLabel}`] = await read(async () => {
				const projects = await Container.get(ProjectRepository).find({ order: { name: 'ASC' } });
				const enriched = await projectService.addUserScopes(user(userLabel), projects);
				return enriched.map((p) => ({ ...p, scopes: p.scopes?.slice().sort() }));
			});
			const scopes: Record<string, unknown> = {};
			for (const projectLabel of PROJECT_LABELS) {
				const { result, error } = await read(
					async () =>
						await projectService.getProjectScopesForUser(user(userLabel), projectId(projectLabel)),
				);
				scopes[projectLabel] = error ?? (result as string[]).slice().sort().join(' ');
			}
			outcomes[`getProjectScopesForUser ${userLabel}`] = scopes;
			for (const scopeSet of [
				['project:export'],
				['project:read'],
				['workflow:read'],
			] as Scope[][]) {
				outcomes[`findProjectsByIdsForUser ${userLabel} ${scopeSet.join(',')}`] = await read(
					async () =>
						projectLabels(
							await projectService.findProjectsByIdsForUser(
								user(userLabel),
								PROJECT_LABELS.map(projectId),
								scopeSet,
							),
						),
				);
			}
		}
		outcomes['findProjectsByIdsForUser result'] = await read(
			async () =>
				await projectService.findProjectsByIdsForUser(
					user('memberA'),
					[projectId('alpha')],
					['project:read'],
				),
		);
		outcomes['getAccessibleProjectsAndCount result'] = await read(
			async () => await projectService.getAccessibleProjectsAndCount(user('memberC'), {}),
		);
		outcomes['getShareableProjectsAndCount result'] = await read(
			async () =>
				await projectService.getShareableProjectsAndCount(user('memberC'), { type: 'team' }),
		);

		for (const projectLabel of PROJECT_LABELS) {
			outcomes[`getProject ${projectLabel}`] = await read(
				async () => await projectService.getProject(projectId(projectLabel)),
			);
			outcomes[`findProject ${projectLabel}`] = await read(
				async () => await projectService.findProject(projectId(projectLabel)),
			);
			outcomes[`getProjectRelations ${projectLabel}`] = await read(async () => {
				const relations = await projectService.getProjectRelations(projectId(projectLabel));
				return relations.map((relation) => ({
					...relation,
					role: { ...relation.role, scopes: relation.role.scopes?.map((s) => s.slug).sort() },
				}));
			});
			outcomes[`findUserIdsByProjectId ${projectLabel}`] = await read(async () =>
				(await projectService.findUserIdsByProjectId(projectId(projectLabel)))
					.map(labelString)
					.sort(),
			);
			for (const page of [
				{ offset: 0, limit: 10 },
				{ offset: 1, limit: 1 },
			]) {
				outcomes[`getProjectMembersAndCount ${projectLabel} ${JSON.stringify(page)}`] = await read(
					async () => await projectService.getProjectMembersAndCount(projectId(projectLabel), page),
				);
			}
			if (projectLabel !== 'missing') {
				outcomes[`getImplicitProjectMembers ${projectLabel}`] = await read(
					async () => await projectService.getImplicitProjectMembers(project(projectLabel)),
				);
			}
		}

		for (const workflow of [
			'alphaWorkflow',
			'alphaActive',
			'betaWorkflow',
			'personalWorkflow',
			'missingWorkflow',
		]) {
			outcomes[`findProjectsWorkflowIsIn ${workflow}`] = await read(async () =>
				(await projectService.findProjectsWorkflowIsIn(projectId(workflow)))
					.map(labelString)
					.sort(),
			);
		}
		for (const list of [['alpha', 'missing', 'personal:memberA'], [], ['missing']]) {
			outcomes[`findExistingProjectIds ${list.join(',')}`] = await read(async () => {
				const ids = await projectService.findExistingProjectIds(list.map(projectId));
				return { type: ids.constructor.name, ids: [...ids].map(labelString).sort() };
			});
		}
		for (const page of [
			{ offset: 0, limit: 100 },
			{ offset: 2, limit: 3 },
		]) {
			outcomes[`getProjectsAndCount ${JSON.stringify(page)}`] = await read(async () => {
				const { projects, count } = await projectService.getProjectsAndCount(page);
				return { projects: projectLabels(projects), count };
			});
		}
		outcomes['getProjectsAndCount result'] = await read(
			async () => await projectService.getProjectsAndCount({ offset: 0, limit: 1 }),
		);
		outcomes.getProjectCounts = await read(async () => await projectService.getProjectCounts());

		outcomes['database changes'] = diffDumps(before, await dumpDb());
		expect(outcomes).toMatchSnapshot();
	}, 600_000);

	test('changing methods', async () => {
		const outcomes: Record<string, Outcome> = {};
		const icon = { type: 'icon' as const, value: 'briefcase' };

		// createTeamProject
		for (const creator of ['owner', 'admin', 'memberA', 'chatUser', 'customGlobal'] as const) {
			outcomes[`createTeamProject by ${creator}`] = await write(
				async () => await projectService.createTeamProject(user(creator), { name: 'New' }),
			);
		}
		outcomes['createTeamProject with icon and context'] = await write(
			async () =>
				await projectService.createTeamProject(user('owner'), {
					name: 'New',
					icon,
					uiContext: 'universal_button',
				}),
		);
		outcomes['createTeamProject with options'] = await write(
			async () =>
				await projectService.createTeamProject(
					user('owner'),
					{ name: 'New' },
					{
						id: 'new-project-id',
						description: 'About it',
						customTelemetryTags: [{ key: 'team', value: 'sales' }],
					},
				),
		);
		outcomes['createTeamProject with description null'] = await write(
			async () =>
				await projectService.createTeamProject(
					user('owner'),
					{ name: 'New' },
					{ description: null },
				),
		);
		for (const target of ['alpha', 'personal:memberB']) {
			outcomes[`createTeamProject with the id of ${target}`] = await write(
				async () =>
					await projectService.createTeamProject(
						user('owner'),
						{ name: 'New' },
						{ id: projectId(target) },
					),
			);
		}
		for (const quota of [0, 3, 4, 5]) {
			outcomes[`createTeamProject with quota ${quota}`] = await write(
				async () =>
					await withLicense(
						{ maxTeamProjects: quota },
						async () => await projectService.createTeamProject(user('owner'), { name: 'New' }),
					),
			);
		}
		outcomes['createTeamProject over quota with a used id'] = await write(
			async () =>
				await withLicense(
					{ maxTeamProjects: 4 },
					async () =>
						await projectService.createTeamProject(
							user('owner'),
							{ name: 'New' },
							{ id: projectId('alpha') },
						),
				),
		);
		outcomes['createTeamProject without the project admin role licence'] = await write(
			async () =>
				await withLicense(
					{ disable: ['feat:projectRole:admin'] },
					async () => await projectService.createTeamProject(user('owner'), { name: 'New' }),
				),
		);

		// updateProject
		for (const [name, actor, target, payload] of [
			['name', 'memberA', 'alpha', { name: 'Renamed' }],
			['icon', 'memberA', 'alpha', { icon }],
			['description', 'memberA', 'alpha', { description: 'About' }],
			['empty description', 'memberA', 'alpha', { description: '' }],
			['tags', 'memberA', 'alpha', { customTelemetryTags: [{ key: 'k', value: 'v' }] }],
			[
				'everything',
				'owner',
				'beta',
				{ name: 'B', icon, description: 'D', customTelemetryTags: [] },
			],
			['nothing', 'memberA', 'alpha', {}],
			['by a viewer', 'memberC', 'alpha', { name: 'Renamed' }],
			['by a non-member', 'memberD', 'beta', { name: 'Renamed' }],
			['of a personal project', 'owner', 'personal:memberA', { name: 'Renamed' }],
			['of a missing project', 'owner', 'missing', { name: 'Renamed' }],
			['nothing of a missing project', 'owner', 'missing', {}],
			['nothing of a personal project', 'owner', 'personal:memberA', {}],
		] as const) {
			outcomes[`updateProject ${name}`] = await write(
				async () =>
					await projectService.updateProject(
						user(actor),
						projectId(target),
						payload as UpdateProjectDto,
					),
			);
		}

		for (const [name, existing, payload] of [
			['new tags', [], { customTelemetryTags: [{ key: 'b', value: '2' }] }],
			[
				'other tags',
				[{ key: 'a', value: '1' }],
				{ customTelemetryTags: [{ key: 'b', value: '2' }] },
			],
			[
				'a changed tag',
				[{ key: 'a', value: '1' }],
				{ customTelemetryTags: [{ key: 'a', value: '2' }] },
			],
			['no tags', [{ key: 'a', value: '1' }], { customTelemetryTags: [] }],
			['only a name', [{ key: 'a', value: '1' }], { name: 'Renamed' }],
			[
				'padded and empty tags',
				[],
				{
					customTelemetryTags: [
						{ key: ' team ', value: ' Sales ' },
						{ key: 'region', value: '' },
					],
				},
			],
		] as const) {
			for (const preserve of [true, false]) {
				for (const licensed of [true, false]) {
					outcomes[
						`updateProject ${name}${preserve ? ' with preserved tags' : ''}${licensed ? ' with span attributes licensed' : ''}`
					] = await write(
						async () =>
							await withLicense(
								{ enable: licensed ? ['feat:otel:customSpanAttributes'] : [] },
								async () => {
									await Container.get(ProjectRepository).update(projectId('alpha'), {
										customTelemetryTags: [...existing],
									});
									return await projectService.updateProject(
										user('owner'),
										projectId('alpha'),
										{ ...payload } as UpdateProjectDto,
										preserve ? { preserveCustomTelemetryTags: true } : undefined,
									);
								},
							),
					);
				}
			}
		}

		// addUser
		for (const [name, target, member, role] of [
			['new viewer', 'alpha', 'owner', 'project:viewer'],
			['existing member', 'alpha', 'memberC', 'project:admin'],
			['custom role', 'gamma', 'memberC', 'custom:project-runner'],
			['missing role', 'gamma', 'memberC', 'project:missing'],
			['personal owner role', 'gamma', 'memberC', 'project:personalOwner'],
			['to a personal project', 'personal:memberA', 'memberB', 'project:editor'],
			['to a missing project', 'missing', 'memberB', 'project:editor'],
		] as const) {
			outcomes[`addUser ${name}`] = await write(
				async () =>
					await projectService.addUser(projectId(target), { userId: user(member).id, role }),
			);
		}

		// addUsersToProject and addUsersWithConflictSemantics
		const memberLists = [
			['new member', 'memberB', 'beta', [['memberD', 'project:viewer']]],
			[
				'new members',
				'memberB',
				'beta',
				[
					['memberD', 'project:editor'],
					['memberA', 'project:admin'],
				],
			],
			['same role', 'memberA', 'alpha', [['memberC', 'project:viewer']]],
			['other role', 'memberA', 'alpha', [['memberC', 'project:editor']]],
			[
				'new and other role',
				'memberA',
				'alpha',
				[
					['owner', 'project:viewer'],
					['memberB', 'project:admin'],
				],
			],
			[
				'instance owner and admins',
				'owner',
				'gamma',
				[
					['owner', 'project:viewer'],
					['admin', 'project:editor'],
					['memberA', 'project:viewer'],
				],
			],
			['only instance admins', 'owner', 'gamma', [['admin', 'project:viewer']]],
			['an instance admin with a relation', 'owner', 'alpha', [['admin', 'project:admin']]],
			['a disabled instance admin', 'owner', 'gamma', [['adminDisabled', 'project:viewer']]],
			['a chat user', 'owner', 'gamma', [['chatUser', 'project:viewer']]],
			[
				'users with global project scopes',
				'owner',
				'gamma',
				[
					['customGlobal', 'project:viewer'],
					['readOnly', 'project:viewer'],
					['listOnly', 'project:viewer'],
				],
			],
			['a pending user', 'owner', 'gamma', [['pending', 'project:editor']]],
			['a custom role', 'owner', 'gamma', [['memberC', 'custom:project-runner']]],
			['a missing role', 'owner', 'gamma', [['memberC', 'project:missing']]],
			['the personal owner role', 'owner', 'gamma', [['memberC', 'project:personalOwner']]],
			['the chat user role', 'owner', 'gamma', [['memberC', 'project:chatUser']]],
			['a global role', 'owner', 'gamma', [['memberC', 'global:member']]],
			['nobody', 'owner', 'gamma', []],
			[
				'the same user twice',
				'owner',
				'gamma',
				[
					['memberC', 'project:viewer'],
					['memberC', 'project:editor'],
				],
			],
			['to a personal project', 'memberA', 'personal:memberA', [['memberB', 'project:viewer']]],
			['to a missing project', 'owner', 'missing', [['memberB', 'project:viewer']]],
			['a missing role to a missing project', 'owner', 'missing', [['memberB', 'project:missing']]],
			[
				'the personal owner role to a personal project',
				'owner',
				'personal:memberA',
				[['memberB', 'project:personalOwner']],
			],
			['an instance admin to a missing project', 'owner', 'missing', [['admin', 'project:viewer']]],
			['a missing user', 'owner', 'gamma', [['missing-user', 'project:viewer']]],
		] as const;
		for (const [name, actor, target, relations] of memberLists) {
			const toRelations = () =>
				relations.map(([member, role]) => ({
					userId: fixture.users[member]?.id ?? member,
					role: role as 'project:viewer',
				}));
			outcomes[`addUsersToProject ${name}`] = await write(
				async () =>
					await projectService.addUsersToProject(user(actor), projectId(target), toRelations()),
			);
			outcomes[`addUsersWithConflictSemantics ${name}`] = await write(
				async () =>
					await projectService.addUsersWithConflictSemantics(
						user(actor),
						projectId(target),
						toRelations(),
					),
			);
		}
		for (const [role, feature] of [
			['project:admin', 'feat:projectRole:admin'],
			['project:editor', 'feat:projectRole:editor'],
			['project:viewer', 'feat:projectRole:viewer'],
			['custom:project-runner', 'feat:customRoles'],
		] as const) {
			const relations = () => [{ userId: user('memberD').id, role: role as 'project:viewer' }];
			outcomes[`addUsersToProject without the licence for ${role}`] = await write(
				async () =>
					await withLicense(
						{ disable: [feature] },
						async () =>
							await projectService.addUsersToProject(
								user('owner'),
								projectId('gamma'),
								relations(),
							),
					),
			);
			outcomes[`addUsersWithConflictSemantics without the licence for ${role}`] = await write(
				async () =>
					await withLicense(
						{ disable: [feature] },
						async () =>
							await projectService.addUsersWithConflictSemantics(
								user('owner'),
								projectId('gamma'),
								relations(),
							),
					),
			);
		}

		// The licence is checked only for a role that changes. memberC is a viewer in alpha.
		for (const [name, relations] of [
			['the same role', [['memberC', 'project:viewer']]],
			['another role', [['memberC', 'project:editor']]],
			['a new member', [['owner', 'project:viewer']]],
			['an instance admin', [['admin', 'project:viewer']]],
		] as const) {
			const toRelations = () =>
				relations.map(([member, role]) => ({
					userId: user(member).id,
					role: role as 'project:viewer',
				}));
			for (const method of ['addUsersToProject', 'addUsersWithConflictSemantics'] as const) {
				outcomes[`${method} ${name} without the licence for viewers and editors`] = await write(
					async () =>
						await withLicense(
							{ disable: ['feat:projectRole:viewer', 'feat:projectRole:editor'] },
							async () =>
								await projectService[method](user('memberA'), projectId('alpha'), toRelations()),
						),
				);
			}
			outcomes[`syncProjectRelations ${name} without the licence for viewers and editors`] =
				await write(
					async () =>
						await withLicense(
							{ disable: ['feat:projectRole:viewer', 'feat:projectRole:editor'] },
							async () =>
								await projectService.syncProjectRelations(projectId('alpha'), toRelations()),
						),
				);
		}

		// syncProjectRelations
		for (const [name, target, relations] of [
			['replace', 'alpha', [['memberC', 'project:admin']]],
			[
				'keep and add',
				'alpha',
				[
					['memberA', 'project:admin'],
					['owner', 'project:viewer'],
				],
			],
			['empty', 'alpha', []],
			['instance admin', 'gamma', [['admin', 'project:viewer']]],
			['missing role', 'gamma', [['memberC', 'project:missing']]],
			['personal project', 'personal:memberA', [['memberB', 'project:viewer']]],
			['missing project', 'missing', [['memberB', 'project:viewer']]],
			['missing role in a missing project', 'missing', [['memberB', 'project:missing']]],
			['personal owner role', 'gamma', [['memberB', 'project:personalOwner']]],
			[
				'same user twice',
				'gamma',
				[
					['memberB', 'project:viewer'],
					['memberB', 'project:editor'],
				],
			],
		] as const) {
			outcomes[`syncProjectRelations ${name}`] = await write(
				async () =>
					await projectService.syncProjectRelations(
						projectId(target),
						relations.map(([member, role]) => ({
							userId: user(member).id,
							role: role as 'project:viewer',
						})),
					),
			);
		}

		// changeUserRoleInProject
		for (const [name, actor, target, member, role] of [
			['viewer to editor', 'memberA', 'alpha', 'memberC', 'project:editor'],
			['viewer to admin', 'memberA', 'alpha', 'memberC', 'project:admin'],
			['own role', 'memberA', 'alpha', 'memberA', 'project:viewer'],
			['to a custom role', 'memberA', 'alpha', 'memberC', 'custom:project-runner'],
			['to a missing role', 'memberA', 'alpha', 'memberC', 'project:missing'],
			['to the personal owner role', 'memberA', 'alpha', 'memberC', 'project:personalOwner'],
			['of a non-member', 'memberA', 'alpha', 'owner', 'project:editor'],
			['of an instance admin', 'owner', 'alpha', 'admin', 'project:viewer'],
			['of a member outside the project', 'memberB', 'beta', 'memberD', 'project:viewer'],
			['of a user with global project scopes', 'owner', 'gamma', 'readOnly', 'project:viewer'],
			['in a personal project', 'owner', 'personal:memberA', 'memberA', 'project:editor'],
			['in a missing project', 'owner', 'missing', 'memberA', 'project:editor'],
			['to a missing role in a missing project', 'owner', 'missing', 'memberA', 'project:missing'],
			[
				'to the personal owner role in a missing project',
				'owner',
				'missing',
				'memberA',
				'project:personalOwner',
			],
			['of an instance admin in a missing project', 'owner', 'missing', 'admin', 'project:editor'],
			['of an instance admin to a missing role', 'owner', 'alpha', 'admin', 'project:missing'],
			[
				'of an instance admin to the personal owner role',
				'owner',
				'alpha',
				'admin',
				'project:personalOwner',
			],
			['of a non-member to a missing role', 'memberB', 'beta', 'memberD', 'project:missing'],
		] as const) {
			outcomes[`changeUserRoleInProject ${name}`] = await write(
				async () =>
					await projectService.changeUserRoleInProject(
						user(actor),
						projectId(target),
						user(member).id,
						role as 'project:viewer',
					),
			);
		}
		for (const [role, feature] of [
			['project:editor', 'feat:projectRole:editor'],
			['project:viewer', 'feat:projectRole:viewer'],
			['custom:project-runner', 'feat:customRoles'],
		] as const) {
			outcomes[`changeUserRoleInProject without the licence for ${role}`] = await write(
				async () =>
					await withLicense(
						{ disable: [feature] },
						async () =>
							await projectService.changeUserRoleInProject(
								user('memberA'),
								projectId('alpha'),
								user('memberB').id,
								role as 'project:viewer',
							),
					),
			);
		}

		// deleteUserFromProject
		for (const [name, actor, target, member] of [
			['a viewer', 'memberA', 'alpha', 'memberC'],
			['self', 'memberC', 'alpha', 'memberC'],
			['the only admin', 'owner', 'alpha', 'memberA'],
			['a non-member', 'memberA', 'alpha', 'owner'],
			['an instance admin', 'owner', 'alpha', 'admin'],
			['a member outside the project', 'memberB', 'beta', 'memberD'],
			['a user with global project scopes', 'owner', 'gamma', 'readOnly'],
			['the personal owner', 'owner', 'personal:memberA', 'memberA'],
			['from a missing project', 'owner', 'missing', 'memberA'],
			['an instance admin from a missing project', 'owner', 'missing', 'admin'],
		] as const) {
			outcomes[`deleteUserFromProject ${name}`] = await write(
				async () =>
					await projectService.deleteUserFromProject(
						user(actor),
						projectId(target),
						user(member).id,
					),
			);
		}

		outcomes['syncProjectRelations without the licence for project:editor'] = await write(
			async () =>
				await withLicense(
					{ disable: ['feat:projectRole:editor'] },
					async () =>
						await projectService.syncProjectRelations(projectId('gamma'), [
							{ userId: user('memberC').id, role: 'project:editor' },
						]),
				),
		);
		outcomes['deleteUserFromProject a personal owner relation of a team project'] = await write(
			async () => {
				await projectService.addUser(projectId('gamma'), {
					userId: user('memberC').id,
					role: 'project:personalOwner',
				});
				return await projectService.deleteUserFromProject(
					user('owner'),
					projectId('gamma'),
					user('memberC').id,
				);
			},
		);
		outcomes['addUser in a transaction'] = await write(
			async () =>
				await Container.get(ProjectRepository).manager.transaction(
					async (trx) =>
						await projectService.addUser(
							projectId('gamma'),
							{ userId: user('memberC').id, role: 'project:editor' },
							trx,
						),
				),
		);

		// deleteProject
		for (const [name, actor, target, migrateTo] of [
			['alpha', 'memberA', 'alpha', undefined],
			['alpha by the owner', 'owner', 'alpha', undefined],
			['beta', 'memberB', 'beta', undefined],
			['an empty project', 'owner', 'gamma', undefined],
			['alpha to beta by the owner', 'owner', 'alpha', 'beta'],
			['alpha to beta by a non-member of beta', 'memberA', 'alpha', 'beta'],
			['beta to alpha by a viewer of alpha', 'pending', 'beta', 'alpha'],
			['beta to delta', 'owner', 'beta', 'delta'],
			['alpha to itself', 'memberA', 'alpha', 'alpha'],
			[
				'alpha to a personal project with an end-user credential',
				'memberA',
				'alpha',
				'personal:memberA',
			],
			['beta to a personal project', 'memberB', 'beta', 'personal:memberB'],
			['alpha to a missing project', 'owner', 'alpha', 'missing'],
			['a personal project', 'memberA', 'personal:memberA', undefined],
			['a personal project by the owner', 'owner', 'personal:memberA', undefined],
			['the own personal project of the owner', 'owner', 'personal:owner', undefined],
			['beta by the owner', 'owner', 'beta', undefined],
			['delta to gamma by its viewer', 'owner', 'delta', 'gamma'],
			['beta to alpha by an editor of alpha', 'memberB', 'beta', 'alpha'],
			['a missing project', 'owner', 'missing', undefined],
		] as const) {
			outcomes[`deleteProject ${name}`] = await write(
				async () =>
					await projectService.deleteProject(
						user(actor),
						projectId(target),
						migrateTo ? { migrateToProject: projectId(migrateTo) } : undefined,
					),
			);
		}

		for (const [name, active, licensed, forProjects] of [
			['inactive, licensed and on', false, true, true],
			['active, licensed and on', true, true, true],
			['active, licensed and off', true, true, false],
			['active, not licensed and on', true, false, true],
		] as const) {
			for (const [target, migrateTo] of [
				['beta', undefined],
				['beta', 'delta'],
				['gamma', undefined],
			] as const) {
				outcomes[
					`deleteProject ${target}${migrateTo ? ` to ${migrateTo}` : ''} with project secrets ${name}`
				] = await write(
					async () =>
						await withProjectSecrets(
							{ active, licensed, forProjects },
							async () =>
								await projectService.deleteProject(
									user('owner'),
									projectId(target),
									migrateTo ? { migrateToProject: projectId(migrateTo) } : undefined,
								),
						),
				);
			}
		}

		expect(outcomes).toMatchSnapshot();
	}, 900_000);
});
