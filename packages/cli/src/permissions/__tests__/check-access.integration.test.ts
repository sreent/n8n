// The access matrix of `userHasScopes`: for each user and each resource, which scope checks pass.
// The snapshot records what n8n answers, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/permissions/FORK.md tells how the fork made the snapshot.
import {
	createTeamProject,
	createWorkflow,
	getPersonalProject,
	linkUserToProject,
	shareWorkflowWithProjects,
	testDb,
	testModules,
} from '@n8n/backend-test-utils';
import type { CredentialsEntity, Project, User } from '@n8n/db';
import { ProjectRepository, SharedCredentialsRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type { Scope } from '@n8n/permissions';

import { userHasScopes } from '@/permissions/check-access';

import { saveCredential } from '@test-integration/db/credentials';
import { createDataTable } from '@test-integration/db/data-tables';
import { createCustomRoleWithScopeSlugs } from '@test-integration/db/roles';
import {
	createAdmin,
	createChatUser,
	createMember,
	createOwner,
	createUser,
} from '@test-integration/db/users';

const SCOPE_SETS: Scope[][] = [
	['project:read'],
	['project:update'],
	['project:delete'],
	['project:manageMembers'],
	['workflow:read'],
	['workflow:update'],
	['workflow:delete'],
	['workflow:execute'],
	['workflow:share'],
	['workflow:unshare'],
	['workflow:move'],
	['workflow:publish'],
	['workflow:enableRedaction'],
	['credential:read'],
	['credential:update'],
	['credential:delete'],
	['credential:share'],
	['credential:unshare'],
	['credential:move'],
	['credential:use'],
	['credential:createEndUser'],
	['credential:connect'],
	['dataTable:read'],
	['dataTable:readRow'],
	['dataTable:writeRow'],
	['dataTable:listProject'],
	['folder:list'],
	['externalSecret:list'],
	['agent:execute'],
	['project:read', 'agent:read'],
	['workflow:read', 'workflow:update'],
	['credential:read', 'credential:share'],
	[],
];

type Ids = { projectId?: string; workflowId?: string; credentialId?: string; dataTableId?: string };

const users: Record<string, User> = {};
const targets: Array<{ label: string; ids: Ids }> = [];

async function credentialOf(name: string, project: Project) {
	return await saveCredential(
		{ name, type: 'githubApi', data: { accessToken: 'token' } },
		{ project, role: 'credential:owner' },
	);
}

async function shareCredential(credential: CredentialsEntity, project: Project) {
	const repository = Container.get(SharedCredentialsRepository);
	await repository.save(
		repository.create({
			credentialsId: credential.id,
			projectId: project.id,
			role: 'credential:user',
		}),
	);
}

/** Run every scope set for a user and a target. T: allowed, F: refused, E: an error. */
async function row(user: User, ids: Ids, globalOnly = false) {
	let result = '';
	for (const scopes of SCOPE_SETS) {
		try {
			result += (await userHasScopes(user, scopes, globalOnly, ids)) ? 'T' : 'F';
		} catch {
			result += 'E';
		}
	}
	return result;
}

beforeAll(async () => {
	await testModules.loadModules(['data-table']);
	await testDb.init();

	users.owner = await createOwner();
	users.admin = await createAdmin();
	users.memberA = await createMember();
	users.memberB = await createMember();
	users.memberC = await createMember();
	users.chatUser = await createChatUser();
	const customGlobal = await createCustomRoleWithScopeSlugs(
		['project:read', 'workflow:read', 'credential:read'],
		{ slug: 'custom:global-reader', roleType: 'global' },
	);
	users.customGlobal = await createUser({ role: customGlobal });
	const customProject = await createCustomRoleWithScopeSlugs(
		[
			'project:read',
			'workflow:read',
			'workflow:execute',
			'credential:read',
			'dataTable:read',
			'dataTable:readRow',
		],
		{ slug: 'custom:project-runner', roleType: 'project' },
	);
	users.memberD = await createMember();
	// A global role and a project role that each hold one half of a scope set.
	const globalReader = await createCustomRoleWithScopeSlugs(
		['project:read', 'workflow:read', 'credential:read'],
		{ slug: 'custom:global-half', roleType: 'global' },
	);
	users.memberE = await createUser({ role: globalReader });
	const projectUpdater = await createCustomRoleWithScopeSlugs(
		['project:update', 'workflow:update', 'credential:update'],
		{ slug: 'custom:project-half', roleType: 'project' },
	);

	const personalA = await getPersonalProject(users.memberA);
	const personalB = await getPersonalProject(users.memberB);
	const personalC = await getPersonalProject(users.memberC);
	const team1 = await createTeamProject('Team 1', users.memberA);
	await linkUserToProject(users.memberB, team1, 'project:editor');
	await linkUserToProject(users.memberC, team1, 'project:viewer');
	const team2 = await createTeamProject('Team 2', users.memberB);
	await linkUserToProject(users.memberD, team2, customProject.slug);
	await linkUserToProject(users.chatUser, team2, 'project:chatUser');
	await linkUserToProject(users.memberE, team1, projectUpdater.slug);
	const team3 = await createTeamProject('Team 3');

	const projects: Record<string, Project> = {
		personalA,
		personalB,
		personalC,
		team1,
		team2,
		team3,
	};
	for (const [label, project] of Object.entries(projects)) {
		targets.push({ label: `project ${label}`, ids: { projectId: project.id } });
	}
	targets.push({ label: 'project missing', ids: { projectId: 'missing-project' } });

	const workflows = {
		personalA: await createWorkflow({ name: 'personalA' }, personalA),
		team1: await createWorkflow({ name: 'team1' }, team1),
		team2: await createWorkflow({ name: 'team2' }, team2),
		team3: await createWorkflow({ name: 'team3' }, team3),
		sharedFromPersonalA: await createWorkflow({ name: 'shared' }, personalA),
	};
	await shareWorkflowWithProjects(workflows.sharedFromPersonalA, [
		{ project: personalB, role: 'workflow:editor' },
		{ project: team2, role: 'workflow:editor' },
	]);
	for (const [label, workflow] of Object.entries(workflows)) {
		targets.push({ label: `workflow ${label}`, ids: { workflowId: workflow.id } });
	}
	targets.push({ label: 'workflow missing', ids: { workflowId: 'missing-workflow' } });

	const credentials = {
		personalA: await credentialOf('personalA', personalA),
		team1: await credentialOf('team1', team1),
		team3: await credentialOf('team3', team3),
		sharedFromPersonalA: await credentialOf('shared', personalA),
	};
	await shareCredential(credentials.sharedFromPersonalA, personalB);
	await shareCredential(credentials.sharedFromPersonalA, team2);
	for (const [label, credential] of Object.entries(credentials)) {
		targets.push({ label: `credential ${label}`, ids: { credentialId: credential.id } });
	}
	targets.push({ label: 'credential missing', ids: { credentialId: 'missing-credential' } });

	const dataTables = {
		personalA: await createDataTable(personalA, { name: 'personalA' }),
		team1: await createDataTable(team1, { name: 'team1' }),
		team2: await createDataTable(team2, { name: 'team2' }),
		team3: await createDataTable(team3, { name: 'team3' }),
	};
	for (const [label, dataTable] of Object.entries(dataTables)) {
		targets.push({ label: `dataTable ${label}`, ids: { dataTableId: dataTable.id } });
	}
	targets.push({ label: 'dataTable missing', ids: { dataTableId: 'missing-data-table' } });

	// Several ids at once, as route params give them.
	targets.push(
		{
			label: 'project team1 + dataTable team3',
			ids: { projectId: team1.id, dataTableId: dataTables.team3.id },
		},
		{
			label: 'project team3 + dataTable team1',
			ids: { projectId: team3.id, dataTableId: dataTables.team1.id },
		},
		{
			label: 'project team1 + workflow team3',
			ids: { projectId: team1.id, workflowId: workflows.team3.id },
		},
		{
			label: 'project team3 + workflow team1',
			ids: { projectId: team3.id, workflowId: workflows.team1.id },
		},
		{
			label: 'project team1 + credential team3',
			ids: { projectId: team1.id, credentialId: credentials.team3.id },
		},
		{
			label: 'project team3 + credential team1',
			ids: { projectId: team3.id, credentialId: credentials.team1.id },
		},
		{
			label: 'workflow team1 + credential team3',
			ids: { workflowId: workflows.team1.id, credentialId: credentials.team3.id },
		},
		{
			label: 'workflow team3 + credential team1',
			ids: { workflowId: workflows.team3.id, credentialId: credentials.team1.id },
		},
		{
			label: 'workflow team1 + dataTable team3',
			ids: { workflowId: workflows.team1.id, dataTableId: dataTables.team3.id },
		},
		{
			label: 'workflow team3 + dataTable team1',
			ids: { workflowId: workflows.team3.id, dataTableId: dataTables.team1.id },
		},
		{
			label: 'credential team1 + dataTable team3',
			ids: { credentialId: credentials.team1.id, dataTableId: dataTables.team3.id },
		},
		{
			label: 'credential team3 + dataTable team1',
			ids: { credentialId: credentials.team3.id, dataTableId: dataTables.team1.id },
		},
		{ label: 'no ids', ids: {} },
	);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('userHasScopes', () => {
	test('gives the recorded answer for each user, resource and scope set', async () => {
		const matrix: Record<string, string> = {};
		for (const [userLabel, user] of Object.entries(users)) {
			for (const { label, ids } of targets) {
				matrix[`${userLabel} | ${label}`] = await row(user, ids);
			}
		}
		expect(matrix).toMatchSnapshot();
	}, 120_000);

	test('throws the recorded errors', async () => {
		const errors: Record<string, string> = {};
		const someTargets = targets.filter(
			({ label }) => label.endsWith('missing') || label === 'no ids',
		);
		for (const userLabel of ['owner', 'memberA']) {
			for (const { label, ids } of someTargets) {
				for (const scopes of [['workflow:read'], []] as Scope[][]) {
					const key = `${userLabel} | ${label} | ${scopes.join(',') || 'no scopes'}`;
					try {
						errors[key] = String(await userHasScopes(users[userLabel], scopes, false, ids));
					} catch (error) {
						errors[key] =
							error instanceof Error
								? `${error.constructor.name}: ${error.message}`
								: String(error);
					}
				}
			}
		}
		expect(errors).toMatchSnapshot();
	});

	test('checks only global scopes when globalOnly is true', async () => {
		const matrix: Record<string, string> = {};
		const someTargets = targets.filter(({ label }) =>
			['project team1', 'workflow team1', 'credential team1', 'dataTable team1', 'no ids'].includes(
				label,
			),
		);
		for (const [userLabel, user] of Object.entries(users)) {
			for (const { label, ids } of someTargets) {
				matrix[`${userLabel} | ${label}`] = await row(user, ids, true);
			}
		}
		expect(matrix).toMatchSnapshot();
	});

	test('gives the same answers inside a transaction', async () => {
		const someTargets = targets.filter(({ label }) =>
			[
				'project team1',
				'project team2',
				'workflow team1',
				'credential team1',
				'dataTable team1',
			].includes(label),
		);
		for (const user of [users.memberA, users.memberB, users.memberD]) {
			for (const { ids } of someTargets) {
				const expected = await row(user, ids);
				let actual = '';
				await Container.get(ProjectRepository).manager.transaction(async (trx) => {
					for (const scopes of SCOPE_SETS) {
						try {
							actual += (await userHasScopes(user, scopes, false, ids, trx)) ? 'T' : 'F';
						} catch {
							actual += 'E';
						}
					}
				});
				expect(actual).toBe(expected);
			}
		}
	}, 120_000);
});
