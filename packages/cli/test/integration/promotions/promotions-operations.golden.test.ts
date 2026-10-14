// Fork test (not in upstream n8n): a golden test of the operations of Git connections (promotions)
// through the public API: the change preview, promote, selective promote, a branch for each
// promotion, a diverged branch, apply (applied, source-changed, blocked) and continue. The data
// is real: team projects with folders, workflows, a credential, variables, a tag and a data
// table. It records the answers, the files and commits of the branch, and the state of the
// instance after each step. The snapshot was recorded against the original module, and the fork
// module gives the same snapshot. See `packages/cli/src/modules/promotions/README.md`.
import {
	createActiveWorkflow,
	createWorkflow,
	createWorkflowHistory,
	getPersonalProject,
	linkUserToProject,
	mockInstance,
} from '@n8n/backend-test-utils';
import type { Project, User } from '@n8n/db';
import {
	CredentialsEntity,
	CredentialsRepository,
	FolderRepository,
	ProjectRepository,
	SharedCredentialsRepository,
	TagRepository,
	VariablesRepository,
	WorkflowPublishedVersionRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type { ICredentialDataDecryptedObject, INode, INodeParameters } from 'n8n-workflow';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import { encryptCredentialData } from '@test-integration/db/credentials';
import { createDataTable } from '@test-integration/db/data-tables';
import { createTag } from '@test-integration/db/tags';
import { addApiKey, createOwnerWithApiKey } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { LocalGitHttpServer } from '../source-control/git-http-server';
import { LocalGitRemote } from '../source-control/git-remote';

import { VariablesService } from './subject';

// Git must reach the local server directly. The cloud session sets proxy variables.
for (const name of Object.keys(process.env)) {
	if (/proxy/i.test(name)) delete process.env[name];
}

mockInstance(ActiveWorkflowManager);

const remote = new LocalGitRemote();
remote.install();
const server = new LocalGitHttpServer(remote.repos);

const testServer = utils.setupTestServer({
	endpointGroups: ['publicApi'],
	enabledFeatures: [
		'feat:gitConnections',
		'feat:sharing',
		'feat:variables',
		'feat:folders',
		'feat:projectRole:admin',
	],
	quotas: { 'quota:maxTeamProjects': -1 },
	modules: ['promotions', 'data-table'],
});

const rec = new GoldenRecorder();
let owner: User;
let agent: SuperAgentTest;
const transcript: unknown[] = [];

/** Masks the parts of a text that change from run to run: ports, hashes, times and names. */
function mask(text: string): string {
	return (
		text
			.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
			// The name of a promotion branch keeps its format: digits become 0.
			.replace(
				/(n8n-promotion\/)([^\s"'|]+)/g,
				(_name, prefix: string, rest: string) => `${prefix}${rest.replace(/\d/g, '0')}`,
			)
			.replace(/\b[0-9a-f]{64}\b/g, '<sha256>')
			.replace(/\b[0-9a-f]{40}\b/g, '<sha>')
			.replace(
				/(?<!n8n-promotion\/)\b\d{4}-?\d{2}-?\d{2}[T-]?\d{2}[:-]?\d{2}[:-]?\d{2}(?:[.-]\d{3})?Z?\b/g,
				'<time>',
			)
			.replace(/\b\d{13}\b/g, '<epoch>')
	);
}

function normalize(value: unknown): unknown {
	return rec.normalize(JSON.parse(mask(JSON.stringify(deepCopy(value as object)))));
}

/** The repositories that the test watches, as `owner/name`. */
const REPOS = ['acme/flows'];
/** The branches seen in each repository, as `owner/name branch`. */
const BRANCHES_SEEN = new Set<string>();
/** The promotion branches in the order the test sees them. Their names hold the time. */
const PROMOTION_BRANCHES: string[] = [];

function branchKey(repo: string, branchName: string) {
	if (!branchName.startsWith('n8n-promotion/')) return `${repo} ${branchName}`;
	if (!PROMOTION_BRANCHES.includes(branchName)) PROMOTION_BRANCHES.push(branchName);
	return `${repo} ${mask(branchName)} #${PROMOTION_BRANCHES.indexOf(branchName) + 1}`;
}

/** The files of a branch, with their content as normalized JSON, and its commits. */
function branchState(repo: string, branchName: string) {
	const [repoOwner, repoName] = repo.split('/');
	const files = remote.readBranch(repoOwner, repoName, branchName);
	if (files === null) return null;
	const content: Record<string, unknown> = {};
	for (const file of Object.keys(files).sort()) {
		let value: unknown = files[file];
		try {
			value = normalize(JSON.parse(files[file]));
		} catch {}
		content[rec.labelString(file)] = value;
	}
	const log = remote
		.log(repoOwner, repoName, branchName)
		.map((line) => line.replace(rec.labels.get(owner.id) ?? '', 'owner'));
	return { log: log.map((line) => rec.labelString(line)), files: content };
}

/** The content of the instance that promotions read and write. */
async function instanceState() {
	await rec.labelNewRows(['project', 'workflow_entity', 'credentials_entity', 'folder', 'user']);
	const projects = await Container.get(ProjectRepository).find({ order: { name: 'ASC' } });
	const workflows = await Container.get(WorkflowRepository).find({
		relations: { shared: true, parentFolder: true, tags: true },
	});
	const folders = await Container.get(FolderRepository).find({
		relations: { homeProject: true, parentFolder: true },
	});
	const credentials = await Container.get(CredentialsRepository).find({
		relations: { shared: true },
	});
	const variables = await Container.get(VariablesRepository).find({ relations: { project: true } });
	const tags = await Container.get(TagRepository).find();
	const dataTables = await Container.get(DataTableRepository).find();
	const project = (id: string | undefined) => (id ? rec.labelString(id) : '-');
	return normalize({
		projects: projects.map((row) => `${row.type} ${rec.labelString(row.id)} "${row.name}"`).sort(),
		workflows: workflows
			.map(
				(row) =>
					`${rec.labelString(row.id)} "${row.name}" in ${project(row.shared?.[0]?.projectId)}` +
					`${row.parentFolder ? ` / ${rec.labelString(row.parentFolder.id)}` : ''}` +
					`${row.isArchived ? ' (archived)' : ''}` +
					` nodes ${JSON.stringify(row.nodes.map((node) => node.parameters))}` +
					` tags ${row.tags?.map((tag) => tag.name).join(',') ?? ''}` +
					` active ${row.activeVersionId ? 'yes' : 'no'}`,
			)
			.sort(),
		folders: folders
			.map(
				(row) =>
					`${rec.labelString(row.id)} "${row.name}" in ${project(row.homeProject?.id)}` +
					`${row.parentFolder ? ` / ${rec.labelString(row.parentFolder.id)}` : ''}`,
			)
			.sort(),
		credentials: credentials
			.map(
				(row) =>
					`${rec.labelString(row.id)} "${row.name}" ${row.type} in ${project(row.shared?.[0]?.projectId)}` +
					` data ${row.data ? 'set' : 'none'}`,
			)
			.sort(),
		variables: variables
			.map((row) => `${row.key}=${JSON.stringify(row.value)} in ${project(row.project?.id)}`)
			.sort(),
		tags: tags.map((row) => row.name).sort(),
		dataTables: dataTables
			.map((row) => `${rec.labelString(row.id)} "${row.name}" in ${project(row.projectId)}`)
			.sort(),
	});
}

/** Gives each new row of the promotion tables a label: the provider, the connection and the configs. */
async function labelNewIds() {
	const manager = Container.get(ProjectRepository).manager;
	const tables: Array<[string, string, string]> = [
		['promotion_provider', 'name', 'provider'],
		['promotion_connection', 'name', 'connection'],
	];
	for (const [table, column, prefix] of tables) {
		const rows = await manager.query<Array<Record<string, string>>>(`SELECT * FROM "${table}"`);
		for (const row of rows) {
			if (!rec.labels.has(row.id)) rec.label(row.id, `${prefix} ${row[column]}`);
		}
	}
	const configs = await manager.query<Array<Record<string, string>>>(
		'SELECT c.id, c.direction, n.name FROM "promotion_config" c JOIN "promotion_connection" n ON n.id = c."connectionId"',
	);
	for (const row of configs) {
		if (!rec.labels.has(row.id)) rec.label(row.id, `config ${row.name} ${row.direction}`);
	}
}

/** The expected source of Continue, from the answer of an apply. */
function sourceOf(
	body: { configId?: string; git?: { branchName?: string; commitSha?: string } },
	configId: string,
) {
	return {
		configId: body.configId ?? configId,
		branchName: body.git?.branchName ?? 'main',
		commitSha: body.git?.commitSha ?? 'b'.repeat(40),
	};
}

const idOf = (label: string) => {
	for (const [value, name] of rec.labels) if (name === label) return value;
	throw new Error(`No id with the label ${label}`);
};

let lastBranches = '';
let lastInstance = '';

/** One request: the answer, and what changed on the branches and on the instance. */
async function step(
	name: string,
	method: 'get' | 'post' | 'put' | 'delete',
	url: string,
	body?: unknown,
	as: SuperAgentTest = agent,
) {
	await new Promise((resolve) => setTimeout(resolve, 20));
	let request = as[method](url);
	if (body !== undefined) request = request.send(body as object);
	const response = await request;
	await labelNewIds();
	const entry: Record<string, unknown> = {
		step: name,
		request: `${method.toUpperCase()} ${rec.labelString(url)}`,
		...(body !== undefined ? { body: normalize(body) } : {}),
		status: response.status,
		response: normalize(response.body),
	};
	await sideEffects(entry);
	transcript.push(entry);
	return response;
}

/** A change that the test makes on the instance or on the branch, as another user would. */
async function change(name: string, action: () => Promise<void> | void) {
	await action();
	const entry: Record<string, unknown> = { change: name };
	await sideEffects(entry);
	transcript.push(entry);
}

async function sideEffects(entry: Record<string, unknown>) {
	for (const repo of REPOS) {
		const [repoOwner, repoName] = repo.split('/');
		for (const branchName of remote.branches(repoOwner, repoName))
			BRANCHES_SEEN.add(`${repo} ${branchName}`);
	}
	const branches = Object.fromEntries(
		[...BRANCHES_SEEN].sort().map((key) => {
			const [repo, branchName] = key.split(' ');
			return [branchKey(repo, branchName), branchState(repo, branchName)];
		}),
	);
	const branchText = JSON.stringify(branches);
	if (branchText !== lastBranches) {
		entry.branches = branches;
		lastBranches = branchText;
	}
	const instance = await instanceState();
	const instanceText = JSON.stringify(instance);
	if (instanceText !== lastInstance) {
		entry.instance = instance;
		lastInstance = instanceText;
	}
}

beforeAll(async () => {
	await server.start();
	process.env.GIT_SSL_CAINFO = server.certFile;
	await utils.initCredentialsTypes();
	await utils.initNodeTypes();
	owner = await createOwnerWithApiKey();
	rec.label(owner.id, 'owner');
	rec.label(`${owner.firstName} ${owner.lastName} <${owner.email}>`, 'owner');
	rec.label(`${owner.firstName} ${owner.lastName}`, 'owner name');
	agent = testServer.publicApiAgentFor(owner);
	remote.createRepo('acme', 'flows');
	remote.seed('acme', 'flows', 'main', { 'README.md': '# Flows\n' }, 'Initial commit');
});

afterAll(async () => {
	await server.stop();
	remote.uninstall();
});

const node = (parameters: INodeParameters, extra: Partial<INode> = {}): INode => ({
	id: 'node-1',
	name: 'HTTP Request',
	type: 'n8n-nodes-base.httpRequest',
	typeVersion: 1,
	position: [0, 0],
	parameters,
	...extra,
});

/** A team project with a fixed id, administered by the owner. */
async function teamProject(id: string, name: string) {
	const repository = Container.get(ProjectRepository);
	const project = await repository.save(
		repository.create({ id, name, type: 'team', creatorId: owner.id }),
	);
	await linkUserToProject(owner, project, 'project:admin');
	return project;
}

/** A credential with a fixed id, owned by a project. The encryption clears the id, so it is set after. */
async function credential(
	id: string,
	name: string,
	type: string,
	data: ICredentialDataDecryptedObject,
	project: Project,
) {
	const entity = Object.assign(new CredentialsEntity(), { name, type, data });
	await encryptCredentialData(entity);
	entity.id = id;
	const saved = await Container.get(CredentialsRepository).save(entity);
	await Container.get(SharedCredentialsRepository).save({
		credentials: saved,
		role: 'credential:owner',
		project,
	});
	return saved;
}

/** A variable with a fixed id. Expressions and exports read variables from the cache. */
async function variable(id: string, key: string, value: string, project?: Project) {
	const row = await Container.get(VariablesRepository).save({ id, key, value, project });
	await Container.get(VariablesService).updateCache();
	return row;
}

test('the operations of Git connections', async () => {
	// #region Data
	const teamA = await teamProject('projTeamA0000001', 'Team A');
	const teamB = await teamProject('projTeamB0000002', 'Team B');
	const personal = await getPersonalProject(owner);
	rec.label(teamA.id, 'Team A');
	rec.label(teamB.id, 'Team B');
	rec.label(personal.id, 'personal owner');
	const folderRepository = Container.get(FolderRepository);
	const folder = await folderRepository.save(
		folderRepository.create({
			id: 'folder1000000001',
			name: 'Folder 1',
			homeProject: teamA,
			parentFolder: null,
		}),
	);
	rec.label(folder.id, 'Folder 1');
	const credentialA = await credential(
		'credA00000000001',
		'Cred A',
		'httpBasicAuth',
		{ user: 'alice', password: 'secret' },
		teamA,
	);
	rec.label(credentialA.id, 'Cred A');
	const tag = await createTag({ id: 'tagProd000000001', name: 'prod' });
	rec.label(tag.id, 'tag prod');
	const globalVariable = await variable('varGlobal0000001', 'GLOBAL_VAR', 'hello');
	rec.label(globalVariable.id, 'GLOBAL_VAR');
	const projectVariable = await variable('varTeam000000002', 'TEAM_VAR', 'team value', teamA);
	rec.label(projectVariable.id, 'TEAM_VAR');
	const table = await createDataTable(teamA, {
		name: 'Table A',
		columns: [{ name: 'city', type: 'string' }],
	});
	rec.label(table.id, 'Table A');
	const flow1 = await createWorkflow(
		{
			id: 'wf01Flow10000001',
			name: 'Flow 1',
			parentFolder: folder,
			tags: [tag],
			nodes: [
				node(
					{ url: '={{ $vars.GLOBAL_VAR }}' },
					{ credentials: { httpBasicAuth: { id: credentialA.id, name: 'Cred A' } } },
				),
			],
		},
		teamA,
	);
	rec.label(flow1.id, 'Flow 1');
	const flow2 = await createWorkflow(
		{ id: 'wf02Flow20000002', name: 'Flow 2', nodes: [node({ url: '={{ $vars.TEAM_VAR }}' })] },
		teamA,
	);
	rec.label(flow2.id, 'Flow 2');
	const old = await createWorkflow(
		{
			id: 'wf03Old000000003',
			name: 'Old flow',
			isArchived: true,
			nodes: [node({ url: 'https://old.example.com' })],
		},
		teamA,
	);
	rec.label(old.id, 'Old flow');
	const flowB = await createWorkflow(
		{ id: 'wf04FlowB0000004', name: 'Flow B', nodes: [node({ url: 'https://example.com' })] },
		teamB,
	);
	rec.label(flowB.id, 'Flow B');
	const mine = await createWorkflow(
		{
			id: 'wf00Personal0000',
			name: 'Personal flow',
			nodes: [node({ url: 'https://me.example.com' })],
		},
		personal,
	);
	rec.label(mine.id, 'Personal flow');
	await change('the data of the instance', () => {});
	// #endregion

	// #region Set-up
	const provider = await step('create the provider', 'post', '/promotions/providers', {
		name: 'Bot user',
		type: 'git',
		auth: { authType: 'token', ...server.credentials },
	});
	await step('create the instance connection', 'post', '/promotions/connections', {
		name: 'Deployments',
		scope: 'instance',
		providerId: provider.body.provider.id,
		target: { schemaVersion: 1, remoteUrl: `${server.origin}/acme/flows.git` },
		configs: {
			apply: { settings: { schemaVersion: 1, branchName: 'main' } },
			promote: {
				settings: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion: false },
			},
		},
	});
	const conn = idOf('connection Deployments');
	const applyConfigId = idOf('config Deployments apply');
	// #endregion

	// #region Promote
	await step('promote before the clone', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'First',
	});
	await step('changes before the clone', 'get', `/promotions/projects/${teamA.id}/changes/promote`);
	await step('clone promote', 'post', `/promotions/connections/${conn}/promote/clone`);
	await step(
		'changes to promote for Team A',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step(
		'changes to promote for Team B',
		'get',
		`/promotions/projects/${teamB.id}/changes/promote`,
	);
	await step(
		'changes to promote for the personal project',
		'get',
		`/promotions/projects/${personal.id}/changes/promote`,
	);
	await step(
		'changes to promote for an unknown project',
		'get',
		'/promotions/projects/unknown1/changes/promote',
	);
	await step(
		'changes to promote sorted by status',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote?sort=status&order=desc`,
	);
	await step(
		'changes to promote that match Flow',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote?search=flow%201`,
	);
	await step(
		'changes to apply before the clone',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	await step('promote without a message', 'post', `/promotions/connections/${conn}/promote`, {});
	await step('promote', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Promote team projects',
	});
	await step(
		'changes to promote after the promote',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step('promote with no change', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Nothing new',
	});
	await change(
		'change the instance: rename Flow 2, edit Flow 1, archive Flow B, delete Old flow, add Flow 3',
		async () => {
			await Container.get(WorkflowRepository).update(flow2.id, { name: 'Flow 2 renamed' });
			await Container.get(WorkflowRepository).update(flow1.id, {
				nodes: [
					node(
						{ url: '={{ $vars.GLOBAL_VAR }}/v2' },
						{ credentials: { httpBasicAuth: { id: credentialA.id, name: 'Cred A' } } },
					),
				],
			});
			await Container.get(WorkflowRepository).update(flowB.id, { isArchived: true });
			await Container.get(WorkflowRepository).delete(old.id);
			const flow3 = await createWorkflow(
				{
					id: 'wf05Flow30000005',
					name: 'Flow 3',
					nodes: [node({ url: 'https://three.example.com' })],
				},
				teamA,
			);
			rec.label(flow3.id, 'Flow 3');
			await createWorkflowHistory(flow3, owner);
		},
	);
	await step(
		'changes to promote for Team A after the changes',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step(
		'changes to promote for Team B after the changes',
		'get',
		`/promotions/projects/${teamB.id}/changes/promote`,
	);
	await step(
		'changes sorted by name descending',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote?sort=name&order=desc`,
	);
	await step(
		'promote a selection without workflows',
		'post',
		`/promotions/projects/${teamA.id}/promote`,
		{
			workflowIds: [],
		},
	);
	await step(
		'promote a selection with an unknown workflow',
		'post',
		`/promotions/projects/${teamA.id}/promote`,
		{
			workflowIds: ['unknownWf1'],
		},
	);
	await step('promote Flow 1 only', 'post', `/promotions/projects/${teamA.id}/promote`, {
		workflowIds: [flow1.id],
		commitMessage: 'Promote Flow 1',
	});
	await step('promote Flow 3, a new workflow', 'post', `/promotions/projects/${teamA.id}/promote`, {
		workflowIds: ['wf05Flow30000005'],
		commitMessage: 'Promote Flow 3',
	});
	await step(
		'promote Flow 2, a renamed workflow',
		'post',
		`/promotions/projects/${teamA.id}/promote`,
		{
			workflowIds: [flow2.id],
			commitMessage: 'Promote Flow 2',
		},
	);
	await step(
		'changes to promote after the selection',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step(
		'promote the deletion of Old flow',
		'post',
		`/promotions/projects/${teamA.id}/promote`,
		{
			workflowIds: [old.id],
		},
	);
	await step('promote Flow B from Team A', 'post', `/promotions/projects/${teamA.id}/promote`, {
		workflowIds: [flowB.id],
	});
	await step(
		'promote the personal project',
		'post',
		`/promotions/projects/${personal.id}/promote`,
		{
			workflowIds: [mine.id],
		},
	);
	const limited = await addApiKey(owner, { scopes: ['gitConnection:push'] });
	const limitedAgent = testServer.publicApiAgentWithApiKey(limited.apiKey);
	await step(
		'promote without the variable scope',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'No variables',
		},
		limitedAgent,
	);
	await step(
		'set a branch for each promotion',
		'put',
		`/promotions/connections/${conn}/configs/promote`,
		{
			settings: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion: true },
		},
	);
	await step(
		'promote to a new branch without a new clone',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'To a new branch',
		},
	);
	await step(
		'clone the promote branch again',
		'post',
		`/promotions/connections/${conn}/promote/clone`,
	);
	await step('promote to a new branch', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'To a new branch',
	});
	await step(
		'push to the base branch again',
		'put',
		`/promotions/connections/${conn}/configs/promote`,
		{
			settings: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion: false },
		},
	);
	await step(
		'clone the base branch again',
		'post',
		`/promotions/connections/${conn}/promote/clone`,
	);
	await change('another instance changes main', () => {
		remote.seed(
			'acme',
			'flows',
			'main',
			{ 'README.md': '# Flows, edited elsewhere\n' },
			'Edit elsewhere',
		);
	});
	await step('promote to a diverged branch', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Diverged',
	});
	await step(
		'promote to a diverged branch with force',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'Diverged with force',
			force: true,
		},
	);
	// #endregion

	// #region Apply
	await step('apply before the clone', 'post', `/promotions/connections/${conn}/apply`);
	await step('clone apply', 'post', `/promotions/connections/${conn}/apply/clone`);
	await step(
		'changes to apply for Team A',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	await change(
		'change the instance after the promote: rename Flow 3, delete Flow 2, add Flow 4 and Team C',
		async () => {
			const flow3 = [...rec.labels].find(([, label]) => label === 'Flow 3')?.[0] ?? '';
			await Container.get(WorkflowRepository).update(flow3, { name: 'Flow 3 local' });
			await Container.get(WorkflowRepository).delete(flow2.id);
			const flow4 = await createWorkflow(
				{
					id: 'wf06Flow40000006',
					name: 'Flow 4',
					nodes: [node({ url: 'https://four.example.com' })],
				},
				teamA,
			);
			rec.label(flow4.id, 'Flow 4');
			const teamC = await teamProject('projTeamC0000003', 'Team C');
			rec.label(teamC.id, 'Team C');
			await createWorkflow(
				{ id: 'wf07FlowC0000007', name: 'Flow C', nodes: [node({ url: 'https://c.example.com' })] },
				teamC,
			);
			await Container.get(VariablesRepository).update(globalVariable.id, { value: 'changed here' });
			await Container.get(VariablesService).updateCache();
		},
	);
	await step(
		'changes to apply after the local changes',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	const reviewed = await step(
		'changes to apply with the commit',
		'get',
		`/promotions/projects/${teamB.id}/changes/apply`,
	);
	await step('apply another commit', 'post', `/promotions/connections/${conn}/apply`, {
		expectedSource: { configId: applyConfigId, branchName: 'main', commitSha: 'a'.repeat(40) },
	});
	await step('apply another branch', 'post', `/promotions/connections/${conn}/apply`, {
		expectedSource: {
			configId: applyConfigId,
			branchName: 'dev',
			commitSha: reviewed.body.commitSha,
		},
	});
	await step('apply another config', 'post', `/promotions/connections/${conn}/apply`, {
		expectedSource: {
			configId: 'otherConfig1',
			branchName: 'main',
			commitSha: reviewed.body.commitSha,
		},
	});
	await step('apply the reviewed commit', 'post', `/promotions/connections/${conn}/apply`, {
		expectedSource: {
			configId: applyConfigId,
			branchName: 'main',
			commitSha: reviewed.body.commitSha,
		},
	});
	await step(
		'changes to apply after the apply',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	await step('apply again', 'post', `/promotions/connections/${conn}/apply`);
	// #endregion

	// #region Blocked apply
	await change('a credential and a variable that the branch needs are missing', async () => {
		const credB = await credential(
			'credB00000000002',
			'Cred B',
			'httpHeaderAuth',
			{ name: 'x', value: 'y' },
			teamB,
		);
		rec.label(credB.id, 'Cred B');
		await Container.get(WorkflowRepository).update(flowB.id, {
			isArchived: false,
			nodes: [
				node(
					{ url: '={{ $vars.NEW_VAR }}' },
					{ credentials: { httpHeaderAuth: { id: credB.id, name: 'Cred B' } } },
				),
			],
		});
		rec.label((await variable('varNew0000000003', 'NEW_VAR', 'new value')).id, 'NEW_VAR');
	});
	await step(
		'promote the new credential and variable',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'Use Cred B and NEW_VAR',
		},
	);
	await change('delete the credential and the variable on the instance', async () => {
		await Container.get(CredentialsRepository).delete('credB00000000002');
		await Container.get(VariablesRepository).delete({ key: 'NEW_VAR' });
		await Container.get(VariablesService).updateCache();
	});
	const blocked = await step(
		'apply with missing bindings',
		'post',
		`/promotions/connections/${conn}/apply`,
	);
	const source = sourceOf(blocked.body, applyConfigId);
	await step(
		'continue while still blocked',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		{
			expectedSource: source,
		},
	);
	await change('create the missing credential with its id', async () => {
		await credential(
			'credB00000000002',
			'Cred B',
			'httpHeaderAuth',
			{ name: 'x', value: 'y' },
			teamB,
		);
	});
	await step(
		'continue without the variable',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		{
			expectedSource: source,
		},
	);
	await change('create the missing variable', async () => {
		rec.label(
			(await variable('varNew0000000004', 'NEW_VAR', 'value on this instance')).id,
			'NEW_VAR 2',
		);
	});
	await step(
		'continue after the set-up',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		{
			expectedSource: source,
		},
	);
	await step(
		'changes to apply after the continue',
		'get',
		`/promotions/projects/${teamB.id}/changes/apply`,
	);
	await step(
		'continue with another commit',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		{
			expectedSource: { ...source, commitSha: 'c'.repeat(40) },
		},
	);
	// #endregion

	// #region Preflight
	await change(
		'a credential of another project, a node without a credential id, an undefined variable and a project variable with the name of a global one',
		async () => {
			const credX = await credential(
				'credX00000000003',
				'Cred X',
				'httpHeaderAuth',
				{ name: 'x', value: 'x' },
				teamB,
			);
			rec.label(credX.id, 'Cred X');
			await createWorkflow(
				{
					id: 'wf09Flow50000009',
					name: 'Flow 5',
					nodes: [
						node(
							{ url: '={{ $vars.UNDEFINED_VAR }}' },
							{ credentials: { httpHeaderAuth: { id: credX.id, name: 'Cred X' } } },
						),
						{
							...node(
								{ url: 'https://five.example.com' },
								{ credentials: { httpBasicAuth: { id: null, name: 'No id' } } },
							),
							id: 'node-2',
							name: 'HTTP Request 2',
						},
					],
				},
				teamA,
			);
			rec.label('wf09Flow50000009', 'Flow 5');
			rec.label(
				(await variable('varShadow0000005', 'GLOBAL_VAR', 'team b value', teamB)).id,
				'GLOBAL_VAR of Team B',
			);
			await createWorkflow(
				{
					id: 'wf10Flow60000010',
					name: 'Flow 6',
					nodes: [node({ url: '={{ $vars.GLOBAL_VAR }}' })],
				},
				teamB,
			);
			rec.label('wf10Flow60000010', 'Flow 6');
		},
	);
	await step(
		'promote the cases of the preflight',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'Preflight cases',
		},
	);
	await change('change the type of Cred A on the instance', async () => {
		await Container.get(CredentialsRepository).update(credentialA.id, { type: 'httpHeaderAuth' });
	});
	const preflight = await step(
		'apply the cases of the preflight',
		'post',
		`/promotions/connections/${conn}/apply`,
	);
	await change('give Team A access to Cred X and restore the type of Cred A', async () => {
		await Container.get(SharedCredentialsRepository).save({
			credentialsId: 'credX00000000003',
			projectId: teamA.id,
			role: 'credential:user',
		});
		await Container.get(CredentialsRepository).update(credentialA.id, { type: 'httpBasicAuth' });
	});
	await step(
		'continue after the changes on the instance',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		{
			expectedSource: sourceOf(preflight.body, applyConfigId),
		},
	);
	await change('define UNDEFINED_VAR and give the node a credential with an id', async () => {
		rec.label((await variable('varUndef00000006', 'UNDEFINED_VAR', 'defined')).id, 'UNDEFINED_VAR');
		await Container.get(WorkflowRepository).update('wf09Flow50000009', {
			nodes: [
				node(
					{ url: '={{ $vars.UNDEFINED_VAR }}' },
					{ credentials: { httpHeaderAuth: { id: 'credX00000000003', name: 'Cred X' } } },
				),
				{
					...node(
						{ url: 'https://five.example.com' },
						{ credentials: { httpBasicAuth: { id: credentialA.id, name: 'Cred A' } } },
					),
					id: 'node-2',
					name: 'HTTP Request 2',
				},
			],
		});
	});
	await step('promote the fixed cases', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Fix the preflight cases',
	});
	await step('apply the fixed cases', 'post', `/promotions/connections/${conn}/apply`);
	// #endregion

	// #region Publishing
	await change('publish Flow P', async () => {
		await createActiveWorkflow({ id: 'wf11FlowP0000011', name: 'Flow P' }, teamA);
		rec.label('wf11FlowP0000011', 'Flow P');
	});
	await step(
		'changes to promote with Flow P',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step('promote the published workflow', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Publish Flow P',
	});
	await change('unpublish Flow P on the instance', async () => {
		await Container.get(WorkflowPublishedVersionRepository).removePublishedVersion(
			'wf11FlowP0000011',
		);
		await Container.get(WorkflowRepository).update('wf11FlowP0000011', {
			activeVersionId: null,
			active: false,
		});
	});
	await step('apply the published workflow', 'post', `/promotions/connections/${conn}/apply`);
	await step('apply the published workflow again', 'post', `/promotions/connections/${conn}/apply`);
	// #endregion

	// #region A project that the instance does not have
	await change('add Team D with Flow D', async () => {
		const teamD = await teamProject('projTeamD0000004', 'Team D');
		rec.label(teamD.id, 'Team D');
		await createWorkflow(
			{ id: 'wf12FlowD0000012', name: 'Flow D', nodes: [node({ url: 'https://d.example.com' })] },
			teamD,
		);
		rec.label('wf12FlowD0000012', 'Flow D');
	});
	await step('promote Team D', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Add Team D',
	});
	await change('delete Team D on the instance', async () => {
		await Container.get(WorkflowRepository).delete('wf12FlowD0000012');
		await Container.get(ProjectRepository).delete('projTeamD0000004');
	});
	const missingProject = await step(
		'apply with a missing project',
		'post',
		`/promotions/connections/${conn}/apply`,
	);
	await step(
		'continue with a missing project',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		{
			expectedSource: sourceOf(missingProject.body, applyConfigId),
		},
	);
	// #endregion

	// #region Reconcile
	await change(
		'Flow T uses Table A, Flow 6 is archived, and Team B has no GLOBAL_VAR of its own',
		async () => {
			await createWorkflow(
				{
					id: 'wf13FlowT0000013',
					name: 'Flow T',
					nodes: [
						{
							id: 'node-1',
							name: 'Data table',
							type: 'n8n-nodes-base.dataTable',
							typeVersion: 1,
							position: [0, 0],
							parameters: { dataTableId: { __rl: true, mode: 'id', value: table.id } },
						},
					],
				},
				teamA,
			);
			rec.label('wf13FlowT0000013', 'Flow T');
			await Container.get(WorkflowRepository).update('wf10Flow60000010', { isArchived: true });
			await Container.get(VariablesRepository).delete({ id: 'varShadow0000005' });
			await Container.get(VariablesService).updateCache();
		},
	);
	await step(
		'promote the table and the archived workflow',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'Table and archive',
		},
	);
	await change(
		'rename Team A and the tag, add an empty folder, restore Flow 6, delete Table A and give Team B a GLOBAL_VAR on the instance',
		async () => {
			await Container.get(ProjectRepository).update(teamA.id, { name: 'Team A local' });
			await Container.get(TagRepository).update(tag.id, { name: 'production' });
			await folderRepository.save(
				folderRepository.create({
					id: 'folder2000000002',
					name: 'Folder 2',
					homeProject: teamA,
					parentFolder: null,
				}),
			);
			rec.label('folder2000000002', 'Folder 2');
			await Container.get(WorkflowRepository).update('wf10Flow60000010', { isArchived: false });
			await Container.get(DataTableRepository).deleteDataTable(table.id);
			rec.label(
				(await variable('varShadow0000007', 'GLOBAL_VAR', 'team b again', teamB)).id,
				'GLOBAL_VAR of Team B 2',
			);
		},
	);
	await step(
		'changes to apply for Team A before the reconcile',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	await step('apply the reconcile cases', 'post', `/promotions/connections/${conn}/apply`);
	// #endregion

	// #region A project connection
	await change('a repository for Team B', () => {
		remote.createRepo('acme', 'team-b');
		remote.seed('acme', 'team-b', 'main', { 'README.md': '# Team B\n' }, 'Initial commit');
		REPOS.push('acme/team-b');
	});
	await step('create a project connection', 'post', '/promotions/connections', {
		name: 'Team B deployments',
		scope: 'projects',
		providerId: provider.body.provider.id,
		target: { schemaVersion: 1, remoteUrl: `${server.origin}/acme/team-b.git` },
		configs: {
			apply: { settings: { schemaVersion: 1, branchName: 'main' } },
			promote: {
				settings: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion: false },
			},
		},
	});
	const teamConn = idOf('connection Team B deployments');
	await step('link Team B', 'post', `/promotions/connections/${teamConn}/projects/${teamB.id}`);
	await step(
		'promote on the project connection',
		'post',
		`/promotions/connections/${teamConn}/promote`,
		{
			commitMessage: 'All projects',
		},
	);
	await step(
		'apply on the project connection',
		'post',
		`/promotions/connections/${teamConn}/apply`,
	);
	await step(
		'continue on the project connection',
		'post',
		`/promotions/connections/${teamConn}/apply/continue`,
		{
			expectedSource: { configId: applyConfigId, branchName: 'main', commitSha: 'd'.repeat(40) },
		},
	);
	await step(
		'changes to promote for Team B before the clone',
		'get',
		`/promotions/projects/${teamB.id}/changes/promote`,
	);
	await step(
		'clone promote on the project connection',
		'post',
		`/promotions/connections/${teamConn}/promote/clone`,
	);
	await step(
		'changes to promote for Team B',
		'get',
		`/promotions/projects/${teamB.id}/changes/promote`,
	);
	await step(
		'changes to promote for Team A',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step(
		'promote Flow B to the project connection',
		'post',
		`/promotions/projects/${teamB.id}/promote`,
		{
			workflowIds: [flowB.id],
			commitMessage: 'Promote Flow B',
		},
	);
	await step(
		'changes to promote for Team B after the promote',
		'get',
		`/promotions/projects/${teamB.id}/changes/promote`,
	);
	await step(
		'changes to apply for Team B before the clone',
		'get',
		`/promotions/projects/${teamB.id}/changes/apply`,
	);
	await step(
		'clone apply on the project connection',
		'post',
		`/promotions/connections/${teamConn}/apply/clone`,
	);
	await step(
		'changes to apply for Team B',
		'get',
		`/promotions/projects/${teamB.id}/changes/apply`,
	);
	await step('unlink Team B', 'delete', `/promotions/connections/${teamConn}/projects/${teamB.id}`);
	await step(
		'changes to promote for Team B without the link',
		'get',
		`/promotions/projects/${teamB.id}/changes/promote`,
	);
	// #endregion

	expect(transcript).toMatchSnapshot();
}, 900_000);
