// Fork test (not in upstream n8n): a golden test of the change list of Git connections
// (promotions) through the public API. After a promotion, it changes one dependency of the
// workflows at a time on the instance: a credential, a data table, a tag, a variable, a
// sub-workflow, a folder or the project. Then it records the change list for promote and for
// apply. The snapshot was recorded against the original module, and the fork module gives the
// same snapshot. See `packages/cli/src/modules/promotions/README.md`.
import {
	createWorkflow,
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
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type {
	ICredentialDataDecryptedObject,
	INode,
	INodeCredentials,
	INodeParameters,
} from 'n8n-workflow';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { DataTableColumnRepository } from '@/modules/data-table/data-table-column.repository';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import { encryptCredentialData } from '@test-integration/db/credentials';
import { createDataTable } from '@test-integration/db/data-tables';
import { createTag } from '@test-integration/db/tags';
import { createOwnerWithApiKey } from '@test-integration/db/users';
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

const httpNode = (url: string, credentials?: INodeCredentials) =>
	node({ url }, credentials ? { credentials } : {});

test('the dependencies in the change list of Git connections', async () => {
	// #region Data
	const teamA = await teamProject('projTeamA0000001', 'Team A');
	const teamB = await teamProject('projTeamB0000002', 'Team B');
	rec.label(teamA.id, 'Team A');
	rec.label(teamB.id, 'Team B');
	rec.label((await getPersonalProject(owner)).id, 'personal owner');
	const credentialA = await credential(
		'credA00000000001',
		'Cred A',
		'httpBasicAuth',
		{ user: 'alice', password: 'secret' },
		teamA,
	);
	rec.label(credentialA.id, 'Cred A');
	const credentialX = await credential(
		'credX00000000003',
		'Cred X',
		'httpHeaderAuth',
		{ name: 'x', value: 'x' },
		teamB,
	);
	rec.label(credentialX.id, 'Cred X');
	await Container.get(SharedCredentialsRepository).save({
		credentialsId: credentialX.id,
		projectId: teamA.id,
		role: 'credential:user',
	});
	const tag = await createTag({ id: 'tagProd000000001', name: 'prod' });
	rec.label(tag.id, 'tag prod');
	rec.label((await variable('varGlobal0000001', 'GV', 'one')).id, 'GV');
	rec.label((await variable('varTeam000000002', 'PV', 'team one', teamA)).id, 'PV');
	const table = await createDataTable(teamA, {
		name: 'Table A',
		columns: [{ name: 'city', type: 'string' }],
	});
	rec.label(table.id, 'Table A');
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
	const flows: Array<[string, string, Parameters<typeof createWorkflow>[0]]> = [
		[
			'wfW1CredA0000001',
			'W1 cred A',
			{
				nodes: [
					httpNode('https://one.example.com', {
						httpBasicAuth: { id: credentialA.id, name: 'Cred A' },
					}),
				],
			},
		],
		['wfW2GlobVar00002', 'W2 global var', { nodes: [httpNode('={{ $vars.GV }}')] }],
		['wfW3ProjVar00003', 'W3 project var', { nodes: [httpNode('={{ $vars.PV }}')] }],
		['wfW4Tag000000004', 'W4 tag', { tags: [tag], nodes: [httpNode('https://four.example.com')] }],
		[
			'wfW5Table0000005',
			'W5 table',
			{
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
		],
		[
			'wfW6CredX0000006',
			'W6 cred X',
			{
				nodes: [
					httpNode('https://six.example.com', {
						httpHeaderAuth: { id: credentialX.id, name: 'Cred X' },
					}),
				],
			},
		],
		['wfW7Plain0000007', 'W7 plain', { nodes: [httpNode('https://seven.example.com')] }],
		[
			'wfW8Parent000008',
			'W8 parent',
			{
				nodes: [
					{
						id: 'node-1',
						name: 'Execute Workflow',
						type: 'n8n-nodes-base.executeWorkflow',
						typeVersion: 1.2,
						position: [0, 0],
						parameters: {
							source: 'database',
							workflowId: { __rl: true, mode: 'id', value: 'wfW9Child0000009' },
						},
					},
				],
			},
		],
		['wfW9Child0000009', 'W9 child', { nodes: [httpNode('https://nine.example.com')] }],
		[
			'wfW10InFolder0010',
			'W10 in folder',
			{ parentFolder: folder, nodes: [httpNode('https://ten.example.com')] },
		],
	];
	for (const [id, name, data] of flows) {
		await createWorkflow({ id, name, ...data }, teamA);
		rec.label(id, name);
	}
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
	await step('clone promote', 'post', `/promotions/connections/${conn}/promote/clone`);
	await step('clone apply', 'post', `/promotions/connections/${conn}/apply/clone`);
	await step('promote', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'All projects',
	});
	const changes = async (name: string) => {
		await step(
			`${name}: changes to promote`,
			'get',
			`/promotions/projects/${teamA.id}/changes/promote`,
		);
		await step(
			`${name}: changes to apply`,
			'get',
			`/promotions/projects/${teamA.id}/changes/apply`,
		);
	};
	await changes('after the promote');
	// #endregion

	// #region Changes on the instance
	const credentials = Container.get(CredentialsRepository);
	const workflows = Container.get(WorkflowRepository);
	const variables = Container.get(VariablesRepository);
	const updateVariable = async (id: string, values: { key?: string; value?: string }) => {
		await variables.update(id, values);
		await Container.get(VariablesService).updateCache();
	};
	const removeVariable = async (id: string) => {
		await variables.delete({ id });
		await Container.get(VariablesService).updateCache();
	};
	const encrypted = async (type: string, data: ICredentialDataDecryptedObject) => {
		const entity = Object.assign(new CredentialsEntity(), { name: 'Cred A', type, data });
		await encryptCredentialData(entity);
		return entity.data;
	};
	const credentialData = (await credentials.findOneByOrFail({ id: credentialA.id })).data;
	const childNodes = (await workflows.findOneByOrFail({ id: 'wfW9Child0000009' })).nodes;
	const plainVersionId = (await workflows.findOneByOrFail({ id: 'wfW7Plain0000007' })).versionId;

	const cases: Array<[string, () => Promise<void>, () => Promise<void>]> = [
		[
			'the value of GV',
			async () => await updateVariable('varGlobal0000001', { value: 'two' }),
			async () => await updateVariable('varGlobal0000001', { value: 'one' }),
		],
		[
			'the value of PV',
			async () => await updateVariable('varTeam000000002', { value: 'team two' }),
			async () => await updateVariable('varTeam000000002', { value: 'team one' }),
		],
		[
			'GV with another name',
			async () => await updateVariable('varGlobal0000001', { key: 'GV_RENAMED' }),
			async () => await updateVariable('varGlobal0000001', { key: 'GV' }),
		],
		[
			'GV deleted',
			async () => await removeVariable('varGlobal0000001'),
			async () => {
				await variable('varGlobal0000001', 'GV', 'one');
			},
		],
		[
			'GV made again with another id',
			async () => {
				await removeVariable('varGlobal0000001');
				rec.label((await variable('varGlobal0000009', 'GV', 'one')).id, 'GV 2');
			},
			async () => {
				await removeVariable('varGlobal0000009');
				await variable('varGlobal0000001', 'GV', 'one');
			},
		],
		[
			'PV made again with another id',
			async () => {
				await removeVariable('varTeam000000002');
				rec.label((await variable('varTeam000000009', 'PV', 'team one', teamA)).id, 'PV 2');
			},
			async () => {
				await removeVariable('varTeam000000009');
				await variable('varTeam000000002', 'PV', 'team one', teamA);
			},
		],
		[
			'a variable of Team A with the name GV',
			async () => {
				rec.label((await variable('varShadow0000005', 'GV', 'team', teamA)).id, 'GV of Team A');
			},
			async () => await removeVariable('varShadow0000005'),
		],
		[
			'PV as a global variable',
			async () => {
				await removeVariable('varTeam000000002');
				rec.label((await variable('varTeam000000008', 'PV', 'team one')).id, 'PV global');
			},
			async () => {
				await removeVariable('varTeam000000008');
				await variable('varTeam000000002', 'PV', 'team one', teamA);
			},
		],
		[
			'the name of Cred A',
			async () => {
				await credentials.update(credentialA.id, { name: 'Cred A renamed' });
			},
			async () => {
				await credentials.update(credentialA.id, { name: 'Cred A' });
			},
		],
		[
			'an expression in the data of Cred A',
			async () => {
				await credentials.update(credentialA.id, {
					data: await encrypted('httpBasicAuth', { user: '={{ $vars.GV }}', password: 'secret' }),
				});
			},
			async () => {
				await credentials.update(credentialA.id, { data: credentialData });
			},
		],
		[
			'the password of Cred A',
			async () => {
				await credentials.update(credentialA.id, {
					data: await encrypted('httpBasicAuth', { user: 'alice', password: 'other' }),
				});
			},
			async () => {
				await credentials.update(credentialA.id, { data: credentialData });
			},
		],
		[
			'the type of Cred A',
			async () => {
				await credentials.update(credentialA.id, { type: 'httpHeaderAuth' });
			},
			async () => {
				await credentials.update(credentialA.id, { type: 'httpBasicAuth' });
			},
		],
		[
			'the name of Cred X',
			async () => {
				await credentials.update(credentialX.id, { name: 'Cred X renamed' });
			},
			async () => {
				await credentials.update(credentialX.id, { name: 'Cred X' });
			},
		],
		[
			'the name of the tag',
			async () => {
				await Container.get(TagRepository).update(tag.id, { name: 'production' });
			},
			async () => {
				await Container.get(TagRepository).update(tag.id, { name: 'prod' });
			},
		],
		[
			'the name of the table',
			async () => {
				await Container.get(DataTableRepository).update(table.id, { name: 'Table A renamed' });
			},
			async () => {
				await Container.get(DataTableRepository).update(table.id, { name: 'Table A' });
			},
		],
		[
			'the nodes of the child',
			async () => {
				await workflows.update('wfW9Child0000009', {
					nodes: [httpNode('https://child.example.com')],
				});
			},
			async () => {
				await workflows.update('wfW9Child0000009', { nodes: childNodes });
			},
		],
		[
			'the name of the child',
			async () => {
				await workflows.update('wfW9Child0000009', { name: 'W9 child renamed' });
			},
			async () => {
				await workflows.update('wfW9Child0000009', { name: 'W9 child' });
			},
		],
		[
			'the version id of W7',
			async () => {
				await workflows.update('wfW7Plain0000007', {
					versionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				});
			},
			async () => {
				await workflows.update('wfW7Plain0000007', { versionId: plainVersionId });
			},
		],
		[
			'the name of W7',
			async () => {
				await workflows.update('wfW7Plain0000007', { name: 'W7 renamed' });
			},
			async () => {
				await workflows.update('wfW7Plain0000007', { name: 'W7 plain' });
			},
		],
		[
			'the name of the folder',
			async () => {
				await folderRepository.update(folder.id, { name: 'Folder renamed' });
			},
			async () => {
				await folderRepository.update(folder.id, { name: 'Folder 1' });
			},
		],
		[
			'the name of the project',
			async () => {
				await Container.get(ProjectRepository).update(teamA.id, { name: 'Team A local' });
			},
			async () => {
				await Container.get(ProjectRepository).update(teamA.id, { name: 'Team A' });
			},
		],
	];
	for (const [name, make, revert] of cases) {
		await change(`change ${name}`, make);
		await changes(name);
		await change(`revert ${name}`, revert);
	}
	await changes('after the reverts');
	await change('add a column to the table', async () => {
		await Container.get(DataTableColumnRepository).addColumn(table.id, {
			name: 'country',
			type: 'string',
		});
	});
	await changes('a new column of the table');
	// #endregion

	expect(transcript).toMatchSnapshot();
}, 900_000);
