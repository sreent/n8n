// Fork test (not in upstream n8n): a golden test of the push of source control. It fills an
// instance with workflows, credentials, variables, tags, folders, projects and data tables, reads
// the status for a push as users with each role, pushes all or some of the files, changes them
// locally and in Git, and pushes again with and without force. It records the status and the body
// of each answer, the files and the commits of the Git branch, the events and the Git requests of
// each step. The snapshot was recorded against the original module of source control, and the fork
// module gives the same snapshot. See `packages/cli/src/modules/source-control/README.md`.
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
	CredentialsRepository,
	FolderRepository,
	ProjectRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { DataTableColumnRepository } from '@/modules/data-table/data-table-column.repository';
import { saveCredential } from '@test-integration/db/credentials';
import { createDataTable } from '@test-integration/db/data-tables';
import { createTag } from '@test-integration/db/tags';
import { createProjectVariable, createVariable } from '@test-integration/db/variables';
import { createUser } from '@test-integration/db/users';
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

type Who = 'owner' | 'admin' | 'member' | 'projAdmin' | 'editor';

const USER_IDS: Record<Who, string> = {
	owner: '00000000-0000-4000-8000-000000000001',
	admin: '00000000-0000-4000-8000-000000000002',
	member: '00000000-0000-4000-8000-000000000003',
	projAdmin: '00000000-0000-4000-8000-000000000004',
	editor: '00000000-0000-4000-8000-000000000005',
};

const users = {} as Record<Who, User>;
const agents = {} as Record<Who, SuperAgentTest>;
let goldenProject: Project;
let otherProject: Project;
let tableId = '';
const credentialIds: Record<string, string> = {};
let transcript: unknown[] = [];
let events: Array<{ name: string; payload: unknown }> = [];

function mask(text: string): string {
	return text
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
				// A commit hash changes with the time of the commit.
				key === 'hash' && typeof entry === 'string' && /^[0-9a-f]{7,40}$/.test(entry)
					? '<hash>'
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

const ISO_DATE_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

/** The text of a file, with labels for the known ids and placeholders for dates and other ids. */
function maskText(text: string) {
	let result = mask(text).replace(ISO_DATE_IN_TEXT, '<date>');
	for (const [id, name] of rec.labels) result = result.replaceAll(id, `@${name}`);
	return result.replace(
		/\b((?=[A-Za-z]*\d)[A-Za-z0-9]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
		'<id>',
	);
}

/** The files and the commits of the branch. The files are texts, so the order of the keys shows. */
function branchState(branch = 'main') {
	const files = remote.readBranch('owner', 'repo', branch) ?? {};
	const texts: Record<string, string> = {};
	for (const [file, content] of Object.entries(files)) {
		texts[maskText(file)] = maskText(content);
	}
	return { log: remote.log('owner', 'repo', branch).map(mask), files: texts };
}

async function step(name: string, run: () => Promise<{ status: number; body: unknown }>) {
	events = [];
	const response = await run();
	transcript.push({
		step: name,
		status: response.status,
		body: normalize(response.body),
		...(events.length > 0 ? { events: normalize(events) } : {}),
		git: gitRequests(),
	});
	return response;
}

async function record(name: string, value: unknown) {
	transcript.push({ step: name, value: normalize(await value) });
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
}

async function makeProject(id: string, name: string, admin: User) {
	const repository = Container.get(ProjectRepository);
	const project = await repository.save(
		repository.create({
			id,
			name,
			type: 'team',
			creatorId: admin.id,
			icon: { type: 'icon', value: 'layers' },
			description: `${name} description`,
		}),
	);
	await linkUserToProject(admin, project, 'project:admin');
	rec.label(project.id, name);
	return project;
}

/** The status for a push, as the editor asks for it. */
async function pushStatus(agent: SuperAgentTest) {
	return await agent
		.get('/source-control/get-status')
		.query({ direction: 'push', preferLocalVersion: true, verbose: false });
}

type StatusFile = { id: string; type: string; name: string };

function filesOf(response: { body: unknown }) {
	const body = response.body as { data?: StatusFile[] };
	return body.data ?? [];
}

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
	await makeUser('editor', 'Eve', GLOBAL_MEMBER_ROLE);
	goldenProject = await makeProject('prjGolden0000001', 'Golden project', users.owner);
	otherProject = await makeProject('prjOther00000001', 'Other project', users.owner);
	await linkUserToProject(users.projAdmin, goldenProject, 'project:admin');
	await linkUserToProject(users.editor, goldenProject, 'project:editor');

	// Tags, folders, workflows, credentials, variables and a data table.
	const alpha = await createTag({ id: 'tagAlpha00000001', name: 'alpha' });
	const beta = await createTag({ id: 'tagBeta000000001', name: 'beta' });
	rec.label(alpha.id, 'tag alpha');
	rec.label(beta.id, 'tag beta');
	const folders = Container.get(FolderRepository);
	const parent = await folders.save(
		folders.create({
			id: 'fldParent0000001',
			name: 'Parent',
			homeProject: goldenProject,
			parentFolder: null,
		}),
	);
	const child = await folders.save(
		folders.create({
			id: 'fldChild00000001',
			name: 'Child',
			homeProject: goldenProject,
			parentFolder: parent,
		}),
	);
	rec.label(parent.id, 'folder Parent');
	rec.label(child.id, 'folder Child');

	const workflows: Array<[string, string, Promise<{ id: string; versionId: string }>]> = [
		[
			'wfPersonal000001',
			'Personal workflow',
			createWorkflow(
				{ id: 'wfPersonal000001', name: 'Personal workflow', tags: [alpha, beta] },
				users.owner,
			),
		],
		[
			'wfPublished00001',
			'Published workflow',
			createActiveWorkflow({ id: 'wfPublished00001', name: 'Published workflow' }, users.owner),
		],
		[
			'wfProject0000001',
			'Project workflow',
			createWorkflow(
				{ id: 'wfProject0000001', name: 'Project workflow', parentFolder: child },
				goldenProject,
			),
		],
		[
			'wfArchived000001',
			'Archived workflow',
			createWorkflow(
				{ id: 'wfArchived000001', name: 'Archived workflow', isArchived: true },
				users.owner,
			),
		],
		[
			'wfMember00000001',
			'Member workflow',
			createWorkflow({ id: 'wfMember00000001', name: 'Member workflow' }, users.member),
		],
		[
			'wfOther000000001',
			'Other workflow',
			createWorkflow(
				{ id: 'wfOther000000001', name: 'Other workflow', tags: [beta] },
				otherProject,
			),
		],
	];
	for (const [id, name, created] of workflows) {
		const workflow = await created;
		rec.label(id, `workflow ${name}`);
		rec.label(workflow.versionId, `version of ${name}`);
	}

	// The database gives the ids of the credentials; the first value is only a name.
	const credentials: Array<[string, string, Promise<{ id: string }>]> = [
		[
			'crPersonal000001',
			'Personal credential',
			saveCredential(
				{
					name: 'Personal credential',
					type: 'httpBasicAuth',
					data: { user: 'olivia', password: 'secret' },
				},
				{ user: users.owner, role: 'credential:owner' },
			),
		],
		[
			'crProject0000001',
			'Project credential',
			saveCredential(
				{
					name: 'Project credential',
					type: 'httpHeaderAuth',
					data: { name: 'X-Api-Key', value: '={{ $vars.API_KEY }}' },
				},
				{ project: goldenProject, role: 'credential:owner' },
			),
		],
		[
			'crMember00000001',
			'Member credential',
			saveCredential(
				{ name: 'Member credential', type: 'httpBasicAuth', data: { user: 'mia', password: '' } },
				{ user: users.member, role: 'credential:owner' },
			),
		],
		[
			'crShapes00000001',
			'Shapes credential',
			saveCredential(
				{
					name: 'Shapes credential',
					type: 'postgres',
					data: {
						host: 'db.example.com',
						port: 5432,
						ssl: true,
						database: '={{ $vars.DB }}',
						user: '=plain',
						password: '',
						nested: { token: 'x', expression: '={{ 1 }}', list: ['a', '={{ 2 }}'] },
						empty: null,
					} as unknown as ICredentialDataDecryptedObject,
				},
				{ project: otherProject, role: 'credential:owner' },
			),
		],
		[
			'crGlobal00000001',
			'Global credential',
			saveCredential(
				{
					name: 'Global credential',
					type: 'httpBasicAuth',
					data: { user: 'all', password: 'all' },
					isGlobal: true,
				},
				{ user: users.owner, role: 'credential:owner' },
			),
		],
	];
	for (const [, name, created] of credentials) {
		const credential = await created;
		rec.label(credential.id, `credential ${name}`);
		credentialIds[name.split(' ')[0]] = credential.id;
	}

	const globalVariable = await createVariable('GLOBAL_VAR', 'global value');
	const projectVariable = await createProjectVariable(
		'PROJECT_VAR',
		'project value',
		goldenProject,
	);
	rec.label(globalVariable.id, 'variable GLOBAL_VAR');
	rec.label(projectVariable.id, 'variable PROJECT_VAR');

	const table = await createDataTable(goldenProject, {
		name: 'Golden table',
		columns: [
			{ name: 'name', type: 'string' },
			{ name: 'age', type: 'number' },
		],
		data: [{ name: 'Ada', age: 36 }],
	});
	rec.label(table.id, 'data table Golden table');
	tableId = table.id;

	// The rows of the test setup and the generated ids of the fixture get labels too.
	await rec.labelNewRows(['project', 'user', 'data_table_column']);

	remote.createRepo('owner', 'repo');
	remote.seed('owner', 'repo', 'main', { 'README.md': '# n8n\n' }, 'Initial commit');
});

afterAll(async () => {
	remote.uninstall();
	await server.stop();
});

test('the push of source control', { timeout: 600_000 }, async () => {
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

	// The status for a push, as each user sees it.
	for (const who of ['owner', 'admin', 'projAdmin', 'editor', 'member'] as const) {
		await step(`${who}: status for push`, async () => await pushStatus(agents[who]));
	}
	await step(
		'owner: verbose status for push',
		async () =>
			await owner
				.get('/source-control/get-status')
				.query({ direction: 'push', preferLocalVersion: true, verbose: true }),
	);
	await step(
		'owner: status with defaults',
		async () => await owner.get('/source-control/get-status').query({ direction: 'push' }),
	);
	await step('owner: status route', async () => await owner.get('/source-control/status'));
	for (const query of [
		{ direction: 'pull' },
		{ direction: 'pull', preferLocalVersion: 'false' },
		{ direction: 'pull', preferLocalVersion: 'true' },
		{ direction: 'push', verbose: 'true' },
		{ direction: 'push', verbose: '1' },
	]) {
		const body = await owner.get('/source-control/get-status').query(query);
		const data = (body.body as { data?: unknown }).data;
		transcript.push({
			step: `owner: status with ${JSON.stringify(query)}`,
			status: body.status,
			shape: Array.isArray(data)
				? `list of ${data.length}`
				: typeof data === 'object' && data
					? `object with ${Object.keys(data).sort().join(',')}`
					: String(data),
			git: gitRequests(),
		});
	}

	// The project admin pushes the project workflow only.
	const projAdminStatus = await pushStatus(agents.projAdmin);
	await step(
		'projAdmin: push the project workflow',
		async () =>
			await agents.projAdmin.post('/source-control/push-workfolder').send({
				commitMessage: 'Project admin push',
				fileNames: filesOf(projAdminStatus).filter((file) => file.id === 'wfProject0000001'),
			}),
	);
	await record('branch after the push of the project admin', branchState());
	await step(
		'editor: push the project workflow',
		async () =>
			await agents.editor.post('/source-control/push-workfolder').send({
				commitMessage: 'Editor push',
				fileNames: filesOf(projAdminStatus).filter((file) => file.id === 'wfProject0000001'),
			}),
	);
	await step(
		'member: push',
		async () =>
			await agents.member
				.post('/source-control/push-workfolder')
				.send({ commitMessage: 'Member push', fileNames: [] }),
	);

	// The owner pushes all files.
	const ownerStatus = await pushStatus(owner);
	await step(
		'owner: push all files',
		async () =>
			await owner.post('/source-control/push-workfolder').send({
				commitMessage: 'Golden push',
				fileNames: filesOf(ownerStatus),
			}),
	);
	await record('branch after the push of all files', branchState());
	await step('owner: status after the push', async () => await pushStatus(owner));
	await step(
		'owner: pull status after the push',
		async () =>
			await owner
				.get('/source-control/get-status')
				.query({ direction: 'pull', preferLocalVersion: false, verbose: false }),
	);

	// Local changes: a rename, a new tag, a deleted workflow, a new variable, a renamed credential
	// and a new column.
	await Container.get(WorkflowRepository).update('wfPersonal000001', {
		name: 'Personal workflow renamed',
		versionId: '11111111-1111-4111-8111-111111111111',
	});
	rec.label('11111111-1111-4111-8111-111111111111', 'version 2 of Personal workflow');
	await step(
		'owner: archive the member workflow',
		async () => await owner.post('/workflows/wfOther000000001/archive').send({}),
	);
	await step(
		'owner: delete the archived workflow',
		async () => await owner.delete('/workflows/wfArchived000001'),
	);
	await createTag({ id: 'tagGamma00000001', name: 'gamma' });
	rec.label('tagGamma00000001', 'tag gamma');
	const newVariable = await createVariable('NEW_VAR', 'new');
	rec.label(newVariable.id, 'variable NEW_VAR');
	await step(
		'owner: rename the personal credential',
		async () =>
			await owner.patch('/credentials/crPersonal000001').send({
				name: 'Personal credential renamed',
				type: 'httpBasicAuth',
				data: { user: 'olivia', password: 'secret' },
			}),
	);
	const changed = await step(
		'owner: status after local changes',
		async () => await pushStatus(owner),
	);

	// Push only the renamed workflow, then the rest.
	await step(
		'owner: push the renamed workflow',
		async () =>
			await owner.post('/source-control/push-workfolder').send({
				commitMessage: 'Rename',
				fileNames: filesOf(changed).filter((file) => file.id === 'wfPersonal000001'),
			}),
	);
	await record('branch after the push of the rename', branchState());
	const rest = await step(
		'owner: status before the push of the rest',
		async () => await pushStatus(owner),
	);
	await step(
		'owner: push the rest',
		async () =>
			await owner
				.post('/source-control/push-workfolder')
				.send({ commitMessage: 'The rest', fileNames: filesOf(rest) }),
	);
	await record('branch after the push of the rest', branchState());

	// A conflict: Git and the instance change the same workflow.
	const files = remote.readBranch('owner', 'repo', 'main') ?? {};
	const workflowFile = Object.keys(files).find((file) => file.includes('wfPublished00001'));
	if (workflowFile) {
		const content = JSON.parse(files[workflowFile]) as Record<string, unknown>;
		content.name = 'Published workflow changed in Git';
		content.versionId = '22222222-2222-4222-8222-222222222222';
		rec.label('22222222-2222-4222-8222-222222222222', 'version from Git');
		remote.seed(
			'owner',
			'repo',
			'main',
			{ [workflowFile]: JSON.stringify(content, null, 2) },
			'Change in Git',
		);
	}
	await Container.get(WorkflowRepository).update('wfPublished00001', {
		name: 'Published workflow changed locally',
		versionId: '33333333-3333-4333-8333-333333333333',
	});
	rec.label('33333333-3333-4333-8333-333333333333', 'local version 2');
	const conflict = await step('owner: status with a conflict', async () => await pushStatus(owner));
	await step(
		'owner: push the conflict without force',
		async () =>
			await owner.post('/source-control/push-workfolder').send({
				commitMessage: 'Conflict',
				fileNames: filesOf(conflict).filter((file) => file.id === 'wfPublished00001'),
			}),
	);
	await record('branch after the push without force', branchState());
	await step(
		'owner: push the conflict with force',
		async () =>
			await owner.post('/source-control/push-workfolder').send({
				commitMessage: 'Forced',
				force: true,
				fileNames: filesOf(conflict).filter((file) => file.id === 'wfPublished00001'),
			}),
	);
	await record('branch after the push with force', branchState());

	// Odd requests.
	await step(
		'owner: push a file that is not in the status',
		async () =>
			await owner.post('/source-control/push-workfolder').send({
				commitMessage: 'Unknown',
				fileNames: [
					{
						id: 'unknown',
						name: 'Unknown',
						type: 'workflow',
						status: 'created',
						location: 'local',
						conflict: false,
						file: '/unknown.json',
						updatedAt: '2026-01-01T00:00:00.000Z',
					},
				],
			}),
	);
	await step(
		'owner: push without a commit message',
		async () => await owner.post('/source-control/push-workfolder').send({ fileNames: [] }),
	);
	await step(
		'owner: push without file names',
		async () =>
			await owner.post('/source-control/push-workfolder').send({ commitMessage: 'No files' }),
	);
	await step(
		'owner: remote content of the published workflow',
		async () => await owner.get('/source-control/remote-content/workflow/wfPublished00001'),
	);
	await record('branch at the end', branchState());

	// Partial pushes: which files a push of one entry writes.
	await step(
		'owner: push all to start clean',
		async () =>
			await owner
				.post('/source-control/push-workfolder')
				.send({ commitMessage: 'Clean', force: true, fileNames: [] }),
	);
	const delta = await createTag({ id: 'tagDelta00000001', name: 'delta' });
	rec.label(delta.id, 'tag delta');
	const folders = Container.get(FolderRepository);
	const extraFolder = await folders.save(
		folders.create({
			id: 'fldExtra00000001',
			name: 'Extra',
			homeProject: goldenProject,
			parentFolder: null,
		}),
	);
	rec.label(extraFolder.id, 'folder Extra');
	const extraVariable = await createVariable('EXTRA_VAR', 'extra');
	rec.label(extraVariable.id, 'variable EXTRA_VAR');
	const extraWorkflow = await createWorkflow(
		{ id: 'wfExtra000000001', name: 'Extra workflow', tags: [delta], parentFolder: extraFolder },
		goldenProject,
	);
	rec.label(extraWorkflow.id, 'workflow Extra workflow');
	rec.label(extraWorkflow.versionId, 'version of Extra workflow');
	await Container.get(DataTableColumnRepository).insert({
		id: 'colExtra00000001',
		name: 'extra',
		type: 'string',
		index: 2,
		dataTableId: tableId,
	});
	rec.label('colExtra00000001', 'column extra');
	await Container.get(CredentialsRepository).update(credentialIds.Personal, {
		name: 'Personal credential renamed',
	});
	const partial = await step(
		'owner: status before the partial pushes',
		async () => await pushStatus(owner),
	);
	for (const [label, pick] of [
		['the extra workflow', (file: StatusFile) => file.id === 'wfExtra000000001'],
		['the tag delta', (file: StatusFile) => file.id === 'tagDelta00000001'],
		['the variable EXTRA_VAR', (file: StatusFile) => file.id === extraVariable.id],
		['the folder Extra', (file: StatusFile) => file.id === 'fldExtra00000001'],
		['the data table', (file: StatusFile) => file.type === 'datatable'],
		['the renamed credential', (file: StatusFile) => file.id === credentialIds.Personal],
	] as const) {
		await step(
			`owner: push ${label}`,
			async () =>
				await owner.post('/source-control/push-workfolder').send({
					commitMessage: `Push ${label}`,
					force: true,
					fileNames: filesOf(partial).filter(pick),
				}),
		);
		await record(`branch after the push of ${label}`, branchState());
	}

	// Two new tags, folders and variables. A push of one of each.
	for (const name of ['epsilon', 'zeta']) {
		const tag = await createTag({ id: `tag${name}`.padEnd(16, '0'), name });
		rec.label(tag.id, `tag ${name}`);
		const folder = await folders.save(
			folders.create({
				id: `fld${name}`.padEnd(16, '0'),
				name: `Folder ${name}`,
				homeProject: goldenProject,
				parentFolder: null,
			}),
		);
		rec.label(folder.id, `folder ${name}`);
		const variable = await createVariable(`VAR_${name.toUpperCase()}`, name);
		rec.label(variable.id, `variable VAR_${name.toUpperCase()}`);
	}
	const pairs = await step(
		'owner: status with two new of each',
		async () => await pushStatus(owner),
	);
	await step(
		'owner: push one tag, one folder and one variable',
		async () =>
			await owner.post('/source-control/push-workfolder').send({
				commitMessage: 'One of each',
				fileNames: filesOf(pairs).filter((file) =>
					['epsilon', 'Folder epsilon', 'VAR_EPSILON'].includes(file.name),
				),
			}),
	);
	await record('branch after the push of one of each', branchState());
	await step('owner: status after the push of one of each', async () => await pushStatus(owner));

	// A push on a protected instance.
	await step(
		'owner: protect the instance',
		async () => await owner.patch('/source-control/preferences').send({ branchReadOnly: true }),
	);
	await step(
		'owner: push on a protected instance',
		async () =>
			await owner
				.post('/source-control/push-workfolder')
				.send({ commitMessage: 'Protected', force: true, fileNames: [] }),
	);
	await step('owner: status on a protected instance', async () => await pushStatus(owner));

	expect(transcript).toMatchSnapshot();
});
