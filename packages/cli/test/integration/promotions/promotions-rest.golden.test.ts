// Fork test (not in upstream n8n): a golden test of the REST route of the change list of Git
// connections (promotions), `GET /rest/promotions/:projectId/changes/:direction`, that the editor
// calls with the session of the user. It records the answers next to the answers of the public
// API route, and the answers for a member, an unknown project, a personal project and a wrong
// direction. The snapshot was recorded against the original module, and the fork module gives
// the same snapshot. See `packages/cli/src/modules/promotions/README.md`.
import {
	createWorkflow,
	getPersonalProject,
	linkUserToProject,
	mockInstance,
} from '@n8n/backend-test-utils';
import type { Project, User } from '@n8n/db';
import {
	CredentialsRepository,
	FolderRepository,
	ProjectRepository,
	TagRepository,
	VariablesRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type { INode, INodeParameters } from 'n8n-workflow';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import { createMember, createOwnerWithApiKey } from '@test-integration/db/users';
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

/** A variable with a fixed id. Expressions and exports read variables from the cache. */
async function variable(id: string, key: string, value: string, project?: Project) {
	const row = await Container.get(VariablesRepository).save({ id, key, value, project });
	await Container.get(VariablesService).updateCache();
	return row;
}

const httpNode = (url: string) => node({ url });

test('the REST route of the change list of Git connections', async () => {
	// #region Data
	const teamA = await teamProject('projTeamA0000001', 'Team A');
	rec.label(teamA.id, 'Team A');
	const personal = await getPersonalProject(owner);
	rec.label(personal.id, 'personal owner');
	rec.label((await variable('varGlobal0000001', 'GV', 'one')).id, 'GV');
	await createWorkflow(
		{ id: 'wfFlow1000000001', name: 'Flow 1', nodes: [httpNode('={{ $vars.GV }}')] },
		teamA,
	);
	rec.label('wfFlow1000000001', 'Flow 1');
	await createWorkflow(
		{ id: 'wfFlow2000000002', name: 'Flow 2', nodes: [httpNode('https://two.example.com')] },
		teamA,
	);
	rec.label('wfFlow2000000002', 'Flow 2');
	const member = await createMember();
	rec.label(member.id, 'member');
	rec.label(`${member.firstName} ${member.lastName} <${member.email}>`, 'member name');
	rec.label((await getPersonalProject(member)).id, 'personal member');
	await linkUserToProject(member, teamA, 'project:admin');
	const ownerSession = testServer.authAgentFor(owner);
	const memberSession = testServer.authAgentFor(member);
	await change('the data of the instance', () => {});
	// #endregion

	const changes = async (name: string, projectId: string, direction: string, query = '') => {
		await step(
			`${name}: REST`,
			'get',
			`/promotions/${projectId}/changes/${direction}${query}`,
			undefined,
			ownerSession,
		);
		await step(
			`${name}: public API`,
			'get',
			`/promotions/projects/${projectId}/changes/${direction}${query}`,
		);
	};

	// #region Set-up
	await changes('before a connection', teamA.id, 'promote');
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
	await changes('before the clone', teamA.id, 'promote');
	await step('clone promote', 'post', `/promotions/connections/${conn}/promote/clone`);
	await step('clone apply', 'post', `/promotions/connections/${conn}/apply/clone`);
	await changes('before the promote', teamA.id, 'promote');
	await changes('before the promote', teamA.id, 'apply');
	await step('promote', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'All projects',
	});
	// #endregion

	// #region Changes
	await changes('after the promote', teamA.id, 'promote');
	await changes('after the promote', teamA.id, 'apply');
	await change('rename Flow 2 and edit Flow 1', async () => {
		await Container.get(WorkflowRepository).update('wfFlow2000000002', { name: 'Flow 2 renamed' });
		await Container.get(WorkflowRepository).update('wfFlow1000000001', {
			nodes: [httpNode('={{ $vars.GV }}/v2')],
		});
	});
	await changes('after the changes', teamA.id, 'promote');
	await changes('after the changes', teamA.id, 'apply');
	await changes('sorted by status', teamA.id, 'promote', '?sort=status&order=desc');
	await changes('sorted by update', teamA.id, 'apply', '?sort=updatedAt&order=asc');
	await changes('with a search', teamA.id, 'promote', '?search=flow%202');
	await changes('with a wrong sort', teamA.id, 'promote', '?sort=size');
	await changes('with a wrong direction', teamA.id, 'sideways');
	await changes('for an unknown project', 'unknown1', 'promote');
	await changes('for the personal project', personal.id, 'promote');
	await step(
		'as a member',
		'get',
		`/promotions/${teamA.id}/changes/promote`,
		undefined,
		memberSession,
	);
	await step(
		'as a member for apply',
		'get',
		`/promotions/${teamA.id}/changes/apply`,
		undefined,
		memberSession,
	);
	await step(
		'without a session',
		'get',
		`/promotions/${teamA.id}/changes/promote`,
		undefined,
		testServer.authlessAgent,
	);
	// #endregion

	expect(transcript).toMatchSnapshot();
}, 900_000);
