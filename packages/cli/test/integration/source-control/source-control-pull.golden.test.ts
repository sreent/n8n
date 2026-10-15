// Fork test (not in upstream n8n): a golden test of the pull of source control. Another instance
// writes workflows, credential stubs, variable stubs, tags, folders, projects and a data table to
// the Git branch. The test reads the status for a pull as users with each role, pulls with and
// without force and with each mode of automatic publishing, and changes the files in Git and in
// the instance between the pulls. It records the status and the body of each answer, the rows that
// each pull adds, changes or removes, the events and the Git requests of each step. The snapshot
// was recorded against the original module of source control, and the fork module gives the same
// snapshot. See `packages/cli/src/modules/source-control/README.md`.
import {
	createActiveWorkflow,
	createWorkflow,
	linkUserToProject,
	mockInstance,
} from '@n8n/backend-test-utils';
import { EventService } from '@n8n/backend-services';
import type { Project, User } from '@n8n/db';
import {
	GLOBAL_ADMIN_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { DataTableColumnRepository } from '@/modules/data-table/data-table-column.repository';
import { saveCredential } from '@test-integration/db/credentials';
import { createDataTable } from '@test-integration/db/data-tables';
import { createFolder } from '@test-integration/db/folders';
import { createTag } from '@test-integration/db/tags';
import { createUser } from '@test-integration/db/users';
import { createVariable } from '@test-integration/db/variables';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { LocalGitHttpServer } from './git-http-server';
import { LocalGitRemote } from './git-remote';

// Git must reach the local server directly. The cloud session sets proxy variables that the test
// setup does not clear (the `npm_config_*` ones), and n8n resolves the proxy of Git from them.
for (const name of Object.keys(process.env)) {
	if (/proxy/i.test(name)) delete process.env[name];
}

mockInstance(ActiveWorkflowManager);

const remote = new LocalGitRemote();
remote.install();
const server = new LocalGitHttpServer(remote.repos);

const testServer = utils.setupTestServer({
	endpointGroups: ['sourceControl', 'workflows', 'credentials', 'tags', 'variables', 'data-table'],
	enabledFeatures: [
		'feat:sourceControl',
		'feat:sharing',
		'feat:variables',
		'feat:projectRole:admin',
		'feat:projectRole:editor',
		'feat:folders',
	],
	quotas: { 'quota:maxTeamProjects': -1 },
	modules: ['source-control', 'data-table'],
});

const rec = new GoldenRecorder();

type Who = 'owner' | 'admin' | 'member' | 'projAdmin';

const USER_IDS: Record<Who, string> = {
	owner: '00000000-0000-4000-8000-000000000001',
	admin: '00000000-0000-4000-8000-000000000002',
	member: '00000000-0000-4000-8000-000000000003',
	projAdmin: '00000000-0000-4000-8000-000000000004',
};

const users = {} as Record<Who, User>;
const agents = {} as Record<Who, SuperAgentTest>;
let goldenProject: Project;
let transcript: unknown[] = [];
let events: Array<{ name: string; payload: unknown }> = [];

const DATE = '2026-01-02T03:04:05.000Z';

/** Random ids that the id pattern of the recorder can miss: an id without a digit. */
const randomIds: string[] = [];

function mask(text: string): string {
	let result = text;
	for (const id of randomIds) result = result.split(id).join('<id>');
	return result
		.split(remote.root)
		.join('<remote>')
		.replace(/\/tmp\/n8n-tests\/[^/\s'"\\]+\/\.n8n/g, '<n8n>')
		.replace(/\/tmp\/[^\s'"\\]+/g, '<tmp>')
		.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
		.replace(/\b[0-9a-f]{40}\b/g, '<hash>');
}

/** Masks each string first, so that the labels of the recorder do not cut a value in two. */
function maskDeep(value: unknown): unknown {
	if (typeof value === 'string') return mask(value);
	if (Array.isArray(value)) return value.map(maskDeep);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				key === 'hash' && typeof entry === 'string' && /^[0-9a-f]{7,40}$/.test(entry)
					? '<hash>'
					: key === 'checksum' && typeof entry === 'string'
						? '<checksum>'
						: maskDeep(entry),
			]),
		);
	}
	return value;
}

function normalize(value: unknown): unknown {
	return rec.normalize(maskDeep(deepCopy(value as object)));
}

function gitRequests() {
	const counts = new Map<string, number>();
	for (const request of server.takeRequests()) {
		const line = `${request.method} ${request.path}${request.service ? `?service=${request.service}` : ''} auth=${request.auth} -> ${request.status}`;
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return [...counts].map(([line, count]) => `${line} x${count}`).sort();
}

/** Tables whose rows a pull can add, change or remove. */
const TABLES = [
	'workflow_entity',
	'shared_workflow',
	'workflows_tags',
	'tag_entity',
	'credentials_entity',
	'shared_credentials',
	'variables',
	'folder',
	'project',
	'project_relation',
	'data_table',
	'data_table_column',
	'workflow_history',
	'workflow_published_version',
];

async function dump() {
	const all = await rec.dumpDb();
	return Object.fromEntries(
		Object.entries(all).filter(([table]) => TABLES.some((name) => table.endsWith(name))),
	);
}

/** Runs a step and records the answer, the rows that changed, the events and the Git requests. */
async function step(name: string, run: () => Promise<{ status: number; body: unknown }>) {
	events = [];
	const before = await dump();
	const response = await run();
	await rec.labelNewRows([
		'project',
		'workflow_entity',
		'credentials_entity',
		'folder',
		'tag_entity',
		'variables',
		'data_table',
	]);
	const after = await dump();
	transcript.push({
		step: name,
		status: response.status,
		body: normalize(response.body),
		...(events.length > 0 ? { events: normalize(events) } : {}),
		rows: rec.diffDumps(before, after),
		git: gitRequests(),
	});
	return response;
}

async function makeUser(who: Who, firstName: string, role: typeof GLOBAL_OWNER_ROLE) {
	const user = await createUser({
		id: USER_IDS[who],
		email: `${who.toLowerCase()}@golden.test`,
		firstName,
		lastName: 'Golden',
		role,
	});
	users[who] = user;
	agents[who] = testServer.authAgentFor(user);
	rec.label(user.id, who);
	const personal = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(user.id);
	rec.label(personal.id, `personal ${who}`);
	return personal;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function workflowFile(
	id: string,
	name: string,
	versionId: string,
	owner: Record<string, string>,
	extra: Record<string, unknown> = {},
) {
	if (!rec.labels.has(id)) rec.label(id, `workflow ${name}`);
	if (!rec.labels.has(versionId)) rec.label(versionId, `version ${versionId.slice(0, 4)}`);
	return json({
		id,
		name,
		description: null,
		nodes: [
			{
				id: 'node-1',
				name: 'Schedule Trigger',
				parameters: { rule: { interval: [{}] } },
				position: [0, 0],
				type: 'n8n-nodes-base.scheduleTrigger',
				typeVersion: 1.2,
			},
		],
		connections: {},
		settings: { executionOrder: 'v1' },
		triggerCount: 1,
		versionId,
		owner,
		parentFolderId: null,
		isArchived: false,
		nodeGroups: [],
		...extra,
	});
}

const ownerOwner = () => ({
	type: 'personal',
	projectId: 'prjRemoteOwner01',
	projectName: 'Olivia Golden <owner@golden.test>',
	personalEmail: 'owner@golden.test',
});

beforeAll(async () => {
	await server.start();
	process.env.GIT_SSL_CAINFO = server.certFile;
	// A direct hook: the test setup restores the spies of `vi.spyOn` before each test.
	const eventService = Container.get(EventService);
	const emit = eventService.emit.bind(eventService);
	eventService.emit = ((name: string, ...rest: unknown[]) => {
		if (String(name).startsWith('source-control') || String(name) === 'workflow-imported') {
			events.push({ name: String(name), payload: deepCopy(rest[0] ?? null) });
		}
		return emit(name as never, ...(rest as never[]));
	}) as typeof eventService.emit;

	await makeUser('owner', 'Olivia', GLOBAL_OWNER_ROLE);
	await makeUser('admin', 'Adam', GLOBAL_ADMIN_ROLE);
	await makeUser('member', 'Mia', GLOBAL_MEMBER_ROLE);
	await makeUser('projAdmin', 'Paul', GLOBAL_MEMBER_ROLE);
	const repository = Container.get(ProjectRepository);
	goldenProject = await repository.save(
		repository.create({ id: 'prjGolden0000001', name: 'Golden project', type: 'team' }),
	);
	await linkUserToProject(users.owner, goldenProject, 'project:admin');
	await linkUserToProject(users.projAdmin, goldenProject, 'project:admin');
	rec.label(goldenProject.id, 'Golden project');
	rec.label('prjRemoteOwner01', 'remote personal project of owner');
	rec.label('prjRemoteMia0001', 'remote personal project of nobody');

	// Local resources that the pull finds: a tag, a folder, a workflow, a credential, a variable.
	const localTag = await createTag({ id: 'tagLocal00000001', name: 'local-tag' });
	rec.label(localTag.id, 'tag local-tag');
	const localFolder = await createFolder(goldenProject, { name: 'Local folder' });
	rec.label(localFolder.id, 'folder Local folder');
	const local = await createWorkflow(
		{ id: 'wfLocal000000001', name: 'Local workflow' },
		users.owner,
	);
	rec.label(local.id, 'workflow Local workflow');
	rec.label(local.versionId, 'version of Local workflow');
	const published = await createActiveWorkflow(
		{ id: 'wfPublished00001', name: 'Published workflow' },
		users.owner,
	);
	rec.label(published.id, 'workflow Published workflow');
	rec.label(published.versionId, 'version of Published workflow');
	const credential = await saveCredential(
		{
			name: 'Local credential',
			type: 'httpBasicAuth',
			data: { user: 'olivia', password: 'secret' },
		},
		{ user: users.owner, role: 'credential:owner' },
	);
	rec.label(credential.id, 'credential Local credential');
	const variable = await createVariable('LOCAL_VAR', 'local value');
	rec.label(variable.id, 'variable LOCAL_VAR');
	const table = await createDataTable(goldenProject, {
		name: 'Local table',
		columns: [{ name: 'name', type: 'string' }],
		data: [{ name: 'Ada' }],
	});
	rec.label(table.id, 'data table Local table');
	for (const column of await Container.get(DataTableColumnRepository).getColumns(table.id)) {
		randomIds.push(column.id);
	}

	// The branch as another instance pushed it.
	rec.label('fldRemote0000001', 'folder Remote folder');
	rec.label('fldRemoteChild01', 'folder Remote child');
	rec.label('tagRemote0000001', 'tag remote-tag');
	rec.label('crRemote00000001', 'credential Remote credential');
	rec.label('crRemoteTeam0001', 'credential Remote team credential');
	rec.label('varRemote0000001', 'variable REMOTE_VAR');
	rec.label('varRemoteProj001', 'variable REMOTE_PROJECT_VAR');
	rec.label('prjNew0000000001', 'New project');
	rec.label('dtRemote00000001', 'data table Remote table');
	rec.label('colRemote0000001', 'column remote name');
	rec.label('colRemote0000002', 'column remote count');
	remote.createRepo('owner', 'repo');
	remote.seed(
		'owner',
		'repo',
		'main',
		{
			'README.md': '# n8n\n',
			'workflows/wfRemote00000001.json': workflowFile(
				'wfRemote00000001',
				'Remote workflow',
				'aaaaaaaa-0000-4000-8000-000000000001',
				ownerOwner(),
			),
			'workflows/wfRemoteUnknown1.json': workflowFile(
				'wfRemoteUnknown1',
				'Unknown owner workflow',
				'aaaaaaaa-0000-4000-8000-000000000002',
				{
					type: 'personal',
					projectId: 'prjRemoteMia0001',
					projectName: 'Nobody Golden <nobody@golden.test>',
					personalEmail: 'nobody@golden.test',
				},
			),
			'workflows/wfRemoteTeam0001.json': workflowFile(
				'wfRemoteTeam0001',
				'Team workflow',
				'aaaaaaaa-0000-4000-8000-000000000003',
				{
					type: 'team',
					teamId: 'prjGolden0000001',
					teamName: 'Golden project',
				},
				{ parentFolderId: 'fldRemoteChild01' },
			),
			'workflows/wfRemoteNewTeam1.json': workflowFile(
				'wfRemoteNewTeam1',
				'New team workflow',
				'aaaaaaaa-0000-4000-8000-000000000004',
				{
					type: 'team',
					teamId: 'prjNew0000000001',
					teamName: 'New project',
				},
			),
			'workflows/wfRemoteArchive1.json': workflowFile(
				'wfRemoteArchive1',
				'Archived remote workflow',
				'aaaaaaaa-0000-4000-8000-000000000005',
				ownerOwner(),
				{ isArchived: true },
			),
			'workflows/wfLocal000000001.json': workflowFile(
				'wfLocal000000001',
				'Local workflow from Git',
				'aaaaaaaa-0000-4000-8000-000000000006',
				ownerOwner(),
			),
			'workflows/wfPublished00001.json': workflowFile(
				'wfPublished00001',
				'Published workflow from Git',
				'aaaaaaaa-0000-4000-8000-000000000007',
				ownerOwner(),
			),
			'credential_stubs/crRemote00000001.json': json({
				id: 'crRemote00000001',
				name: 'Remote credential',
				type: 'httpBasicAuth',
				data: { user: '', password: '' },
				ownedBy: ownerOwner(),
				isGlobal: false,
				isResolvable: false,
				resolvableAllowFallback: false,
			}),
			'credential_stubs/crRemoteTeam0001.json': json({
				id: 'crRemoteTeam0001',
				name: 'Remote team credential',
				type: 'httpHeaderAuth',
				data: { name: '', value: '={{ $vars.API_KEY }}' },
				ownedBy: { type: 'team', teamId: 'prjGolden0000001', teamName: 'Golden project' },
				isGlobal: false,
				isResolvable: false,
				resolvableAllowFallback: false,
			}),
			'variable_stubs.json': json([
				{ id: 'varRemote0000001', key: 'REMOTE_VAR', type: 'string', value: '' },
				{ id: variable.id, key: 'LOCAL_VAR', type: 'string', value: '' },
			]),
			'tags.json': json({
				tags: [
					{ id: 'tagRemote0000001', name: 'remote-tag' },
					{ id: 'tagLocal00000001', name: 'local-tag-renamed' },
				],
				mappings: [
					{ workflowId: 'wfRemote00000001', tagId: 'tagRemote0000001' },
					{ workflowId: 'wfRemoteTeam0001', tagId: 'tagLocal00000001' },
				],
			}),
			'folders.json': json({
				folders: [
					{
						id: 'fldRemote0000001',
						name: 'Remote folder',
						parentFolderId: null,
						homeProjectId: 'prjGolden0000001',
						createdAt: DATE,
						updatedAt: DATE,
					},
					{
						id: 'fldRemoteChild01',
						name: 'Remote child',
						parentFolderId: 'fldRemote0000001',
						homeProjectId: 'prjGolden0000001',
						createdAt: DATE,
						updatedAt: DATE,
					},
				],
			}),
			'projects/prjNew0000000001.json': json({
				id: 'prjNew0000000001',
				name: 'New project',
				icon: { type: 'icon', value: 'rocket' },
				description: 'A project from Git',
				type: 'team',
				owner: { type: 'team', teamId: 'prjNew0000000001', teamName: 'New project' },
				variableStubs: [
					{ id: 'varRemoteProj001', key: 'REMOTE_PROJECT_VAR', type: 'string', value: '' },
				],
			}),
			'projects/prjGolden0000001.json': json({
				id: 'prjGolden0000001',
				name: 'Golden project',
				icon: null,
				description: 'Description from Git',
				type: 'team',
				owner: { type: 'team', teamId: 'prjGolden0000001', teamName: 'Golden project' },
				variableStubs: [],
			}),
			'datatables/dtRemote00000001.json': json({
				id: 'dtRemote00000001',
				name: 'Remote table',
				columns: [
					{ id: 'colRemote0000001', name: 'name', type: 'string', index: 0 },
					{ id: 'colRemote0000002', name: 'count', type: 'number', index: 1 },
				],
				ownedBy: { type: 'team', teamId: 'prjGolden0000001', teamName: 'Golden project' },
				createdAt: DATE,
				updatedAt: DATE,
			}),
		},
		'Push from another instance',
	);
	// The rows of the test setup (the owner of the instance and its project) get labels too.
	await rec.labelNewRows(['project', 'user']);
});

afterAll(async () => {
	remote.uninstall();
	await server.stop();
});

const pullStatus = async (agent: SuperAgentTest) =>
	await agent
		.get('/source-control/get-status')
		.query({ direction: 'pull', preferLocalVersion: false, verbose: false });

test('the pull of source control', { timeout: 600_000 }, async () => {
	transcript = [];
	const owner = agents.owner;
	await step(
		'connect over HTTPS',
		async () =>
			await owner.post('/source-control/preferences').send({
				repositoryUrl: `${server.origin}/owner/repo.git`,
				connectionType: 'https',
				httpsUsername: 'git-user',
				httpsPassword: 'git-token',
			}),
	);

	// The status for a pull.
	for (const who of ['owner', 'admin', 'projAdmin', 'member'] as const) {
		await step(`${who}: status for pull`, async () => await pullStatus(agents[who]));
	}
	await step(
		'owner: verbose status for pull',
		async () =>
			await owner
				.get('/source-control/get-status')
				.query({ direction: 'pull', preferLocalVersion: false, verbose: true }),
	);
	await step(
		'owner: remote content of a workflow',
		async () => await owner.get('/source-control/remote-content/workflow/wfRemote00000001'),
	);

	// The first pull. Local changes block it until the owner forces it.
	await step(
		'admin: pull without force',
		async () => await agents.admin.post('/source-control/pull-workfolder').send({ force: false }),
	);
	await step(
		'owner: pull with force',
		async () => await owner.post('/source-control/pull-workfolder').send({ force: true }),
	);
	await step('owner: status for pull after the pull', async () => await pullStatus(owner));
	await step(
		'owner: status for push after the pull',
		async () =>
			await owner
				.get('/source-control/get-status')
				.query({ direction: 'push', preferLocalVersion: true, verbose: false }),
	);

	// Changes in Git: a new version, a deleted file, a renamed tag, a new variable, a moved
	// workflow, a changed data table.
	const files = remote.readBranch('owner', 'repo', 'main') ?? {};
	remote.seed(
		'owner',
		'repo',
		'main',
		{
			'workflows/wfRemote00000001.json': workflowFile(
				'wfRemote00000001',
				'Remote workflow v2',
				'bbbbbbbb-0000-4000-8000-000000000001',
				ownerOwner(),
			),
			'workflows/wfRemoteArchive1.json': null,
			'workflows/wfRemoteTeam0001.json': workflowFile(
				'wfRemoteTeam0001',
				'Team workflow v2',
				'bbbbbbbb-0000-4000-8000-000000000003',
				{
					type: 'team',
					teamId: 'prjGolden0000001',
					teamName: 'Golden project',
				},
				{ parentFolderId: 'fldRemote0000001' },
			),
			'tags.json': json({
				tags: [
					{ id: 'tagRemote0000001', name: 'remote-tag-v2' },
					{ id: 'tagLocal00000001', name: 'local-tag-renamed' },
				],
				mappings: [{ workflowId: 'wfRemoteTeam0001', tagId: 'tagRemote0000001' }],
			}),
			'variable_stubs.json': json([
				{ id: 'varRemote0000001', key: 'REMOTE_VAR', type: 'string', value: '' },
				{ id: 'varRemote0000002', key: 'SECOND_VAR', type: 'string', value: '' },
			]),
			'datatables/dtRemote00000001.json': files['datatables/dtRemote00000001.json']
				? json({
						...(JSON.parse(files['datatables/dtRemote00000001.json']) as Record<string, unknown>),
						columns: [
							{ id: 'colRemote0000001', name: 'name', type: 'string', index: 0 },
							{ id: 'colRemote0000003', name: 'flag', type: 'boolean', index: 1 },
						],
					})
				: null,
		},
		'Second push from another instance',
	);
	rec.label('varRemote0000002', 'variable SECOND_VAR');
	rec.label('colRemote0000003', 'column remote flag');

	// A local change of the team workflow conflicts with the change in Git.
	await Container.get(WorkflowRepository).update('wfRemoteTeam0001', {
		name: 'Team workflow changed locally',
		versionId: 'cccccccc-0000-4000-8000-000000000003',
	});
	rec.label('cccccccc-0000-4000-8000-000000000003', 'version cccc');
	await step('owner: status for pull with changes', async () => await pullStatus(owner));
	await step(
		'owner: pull without force',
		async () => await owner.post('/source-control/pull-workfolder').send({ force: false }),
	);
	await step(
		'owner: pull with force and publish the published ones',
		async () =>
			await owner
				.post('/source-control/pull-workfolder')
				.send({ force: true, autoPublish: 'published' }),
	);

	// A third version, published by the pull.
	remote.seed(
		'owner',
		'repo',
		'main',
		{
			'workflows/wfRemote00000001.json': workflowFile(
				'wfRemote00000001',
				'Remote workflow v3',
				'dddddddd-0000-4000-8000-000000000001',
				ownerOwner(),
			),
			'workflows/wfPublished00001.json': workflowFile(
				'wfPublished00001',
				'Published workflow v3',
				'dddddddd-0000-4000-8000-000000000007',
				ownerOwner(),
			),
		},
		'Third push from another instance',
	);
	await step(
		'owner: pull with force and publish all',
		async () =>
			await owner.post('/source-control/pull-workfolder').send({ force: true, autoPublish: 'all' }),
	);
	await step(
		'owner: pull with nothing new',
		async () => await owner.post('/source-control/pull-workfolder').send({ force: false }),
	);
	await step(
		'member: pull',
		async () => await agents.member.post('/source-control/pull-workfolder').send({ force: true }),
	);
	await step(
		'owner: pull with an unknown publish mode',
		async () =>
			await owner
				.post('/source-control/pull-workfolder')
				.send({ force: true, autoPublish: 'sometimes' }),
	);

	expect(transcript).toMatchSnapshot();
});
