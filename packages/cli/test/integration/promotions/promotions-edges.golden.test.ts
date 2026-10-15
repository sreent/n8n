// Fork test (not in upstream n8n): a golden test of the edge cases of the operations of Git
// connections (promotions) through the public API: no connection, a direction without a
// configuration, a project connection without configurations, and a checkout that no longer
// matches its configuration. It records the status and the body of each answer. The snapshot was
// recorded against the original module, and the fork module gives the same snapshot. See
// `packages/cli/src/modules/promotions/README.md`.
import {
	createWorkflow,
	createWorkflowHistory,
	linkUserToProject,
	mockInstance,
} from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { ProjectRepository, VariablesRepository, WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
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
	enabledFeatures: ['feat:gitConnections', 'feat:sharing', 'feat:projectRole:admin'],
	quotas: { 'quota:maxTeamProjects': -1 },
	modules: ['promotions'],
});

const rec = new GoldenRecorder();
let owner: User;
let agent: SuperAgentTest;
const transcript: unknown[] = [];

function mask(text: string): string {
	return text
		.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
		.replace(/\b[0-9a-f]{40}\b/g, '<sha>');
}

function normalize(value: unknown): unknown {
	return rec.normalize(JSON.parse(mask(JSON.stringify(deepCopy(value as object)))));
}

/** Gives each new row of the promotion tables a label. */
async function labelNewIds() {
	const manager = Container.get(ProjectRepository).manager;
	for (const [table, prefix] of [
		['promotion_provider', 'provider'],
		['promotion_connection', 'connection'],
	]) {
		const rows = await manager.query<Array<Record<string, string>>>(`SELECT * FROM "${table}"`);
		for (const row of rows) {
			if (!rec.labels.has(row.id)) rec.label(row.id, `${prefix} ${row.name}`);
		}
	}
	const configs = await manager.query<Array<Record<string, string>>>(
		'SELECT c.id, c.direction, n.name FROM "promotion_config" c JOIN "promotion_connection" n ON n.id = c."connectionId"',
	);
	for (const row of configs) {
		if (!rec.labels.has(row.id)) rec.label(row.id, `config ${row.name} ${row.direction}`);
	}
}

async function step(
	name: string,
	method: 'get' | 'post' | 'put' | 'delete',
	url: string,
	body?: unknown,
) {
	await new Promise((resolve) => setTimeout(resolve, 20));
	let request = agent[method](url);
	if (body !== undefined) request = request.send(body as object);
	const response = await request;
	await labelNewIds();
	transcript.push({
		step: name,
		request: `${method.toUpperCase()} ${rec.labelString(url)}`,
		...(body !== undefined ? { body: normalize(body) } : {}),
		status: response.status,
		response: normalize(response.body),
	});
	return response;
}

const idOf = (label: string) => {
	for (const [value, name] of rec.labels) if (name === label) return value;
	throw new Error(`No id with the label ${label}`);
};

async function teamProject(id: string, name: string) {
	const repository = Container.get(ProjectRepository);
	const project = await repository.save(
		repository.create({ id, name, type: 'team', creatorId: owner.id }),
	);
	await linkUserToProject(owner, project, 'project:admin');
	rec.label(project.id, name);
	return project;
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
	rec.label(owner.email, 'owner email');
	agent = testServer.publicApiAgentFor(owner);
	remote.createRepo('acme', 'flows');
	remote.seed('acme', 'flows', 'main', { 'README.md': '# Flows\n' }, 'Initial commit');
	remote.seed('acme', 'flows', 'dev', { 'README.md': '# Flows on dev\n' }, 'Dev branch');
});

afterAll(async () => {
	await server.stop();
	remote.uninstall();
});

const promoteSettings = (baseBranchName: string) => ({
	settings: { schemaVersion: 1, baseBranchName, createBranchOnPromotion: false },
});
const applySettings = (branchName: string) => ({ settings: { schemaVersion: 1, branchName } });
const someSource = (configId: string) => ({
	expectedSource: { configId, branchName: 'main', commitSha: 'a'.repeat(40) },
});

test('the edge cases of the operations of Git connections', async () => {
	const teamA = await teamProject('projTeamA0000001', 'Team A');
	const teamB = await teamProject('projTeamB0000002', 'Team B');
	await createWorkflow(
		{
			id: 'wf01Flow10000001',
			name: 'Flow 1',
			nodes: [
				{
					id: 'node-1',
					name: 'HTTP Request',
					type: 'n8n-nodes-base.httpRequest',
					typeVersion: 1,
					position: [0, 0],
					parameters: { url: 'https://one.example.com' },
				},
			],
		},
		teamA,
	);
	rec.label('wf01Flow10000001', 'Flow 1');

	// #region No connection
	await step(
		'changes to promote without a connection',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step(
		'changes to apply without a connection',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	await step(
		'promote a selection without a connection',
		'post',
		`/promotions/projects/${teamA.id}/promote`,
		{
			workflowIds: ['wf01Flow10000001'],
		},
	);
	await step(
		'promote with an unknown connection',
		'post',
		'/promotions/connections/unknown1/promote',
		{
			commitMessage: 'Unknown',
		},
	);
	await step('apply with an unknown connection', 'post', '/promotions/connections/unknown1/apply');
	await step(
		'clone with an unknown connection',
		'post',
		'/promotions/connections/unknown1/apply/clone',
	);
	await step(
		'disconnect with an unknown connection',
		'post',
		'/promotions/connections/unknown1/apply/disconnect',
	);
	// #endregion

	// #region A connection without configurations
	const provider = await step('create the provider', 'post', '/promotions/providers', {
		name: 'Bot user',
		type: 'git',
		auth: { authType: 'token', ...server.credentials },
	});
	await step(
		'create the instance connection without configurations',
		'post',
		'/promotions/connections',
		{
			name: 'Deployments',
			scope: 'instance',
			providerId: provider.body.provider.id,
			target: { schemaVersion: 1, remoteUrl: `${server.origin}/acme/flows.git` },
		},
	);
	const conn = idOf('connection Deployments');
	await step(
		'promote without a promote configuration',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'No configuration',
		},
	);
	await step(
		'apply without an apply configuration',
		'post',
		`/promotions/connections/${conn}/apply`,
	);
	await step(
		'continue without an apply configuration',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		someSource('config1'),
	);
	await step(
		'clone without a promote configuration',
		'post',
		`/promotions/connections/${conn}/promote/clone`,
	);
	await step(
		'disconnect without an apply configuration',
		'post',
		`/promotions/connections/${conn}/apply/disconnect`,
	);
	await step(
		'delete a configuration that does not exist',
		'delete',
		`/promotions/connections/${conn}/configs/apply`,
	);
	await step(
		'changes to promote without a promote configuration',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step(
		'changes to apply without an apply configuration',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	await step(
		'promote a selection without a promote configuration',
		'post',
		`/promotions/projects/${teamA.id}/promote`,
		{
			workflowIds: ['wf01Flow10000001'],
		},
	);
	// #endregion

	// #region A project connection without configurations
	await step(
		'create a project connection without configurations',
		'post',
		'/promotions/connections',
		{
			name: 'Team B repository',
			scope: 'projects',
			providerId: provider.body.provider.id,
			target: { schemaVersion: 1, remoteUrl: `${server.origin}/acme/flows.git` },
		},
	);
	const teamConn = idOf('connection Team B repository');
	await step('link Team B', 'post', `/promotions/connections/${teamConn}/projects/${teamB.id}`);
	await step(
		'set the promote configuration of the instance connection',
		'put',
		`/promotions/connections/${conn}/configs/promote`,
		promoteSettings('main'),
	);
	await step(
		'clone promote on the instance connection',
		'post',
		`/promotions/connections/${conn}/promote/clone`,
	);
	await step(
		'changes to promote for Team B with a project connection without configurations',
		'get',
		`/promotions/projects/${teamB.id}/changes/promote`,
	);
	await step(
		'changes to promote for Team A on the instance connection',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step(
		'promote a selection for Team B with a project connection without configurations',
		'post',
		`/promotions/projects/${teamB.id}/promote`,
		{
			workflowIds: ['wf01Flow10000001'],
		},
	);
	// #endregion

	// #region A checkout that no longer matches its configuration
	await step(
		'set the apply configuration',
		'put',
		`/promotions/connections/${conn}/configs/apply`,
		applySettings('main'),
	);
	await step('clone apply', 'post', `/promotions/connections/${conn}/apply/clone`);
	await step('changes to apply on main', 'get', `/promotions/projects/${teamA.id}/changes/apply`);
	await step(
		'move the apply branch to dev',
		'put',
		`/promotions/connections/${conn}/configs/apply`,
		applySettings('dev'),
	);
	await step(
		'changes to apply after the branch change',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	await step('apply after the branch change', 'post', `/promotions/connections/${conn}/apply`);
	await step(
		'continue after the branch change',
		'post',
		`/promotions/connections/${conn}/apply/continue`,
		someSource(idOf('config Deployments apply')),
	);
	await step(
		'move the promote branch to dev',
		'put',
		`/promotions/connections/${conn}/configs/promote`,
		promoteSettings('dev'),
	);
	await step(
		'changes to promote after the branch change',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step('promote after the branch change', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'After the branch change',
	});
	await step(
		'promote a selection after the branch change',
		'post',
		`/promotions/projects/${teamA.id}/promote`,
		{
			workflowIds: ['wf01Flow10000001'],
		},
	);
	await step('clone promote on dev', 'post', `/promotions/connections/${conn}/promote/clone`);
	await step(
		'point the connection at another repository',
		'put',
		`/promotions/connections/${conn}`,
		{
			target: { schemaVersion: 1, remoteUrl: `${server.origin}/acme/other.git` },
		},
	);
	await step('promote after the remote change', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'After the remote change',
	});
	await step(
		'changes to promote after the remote change',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	await step('apply after the remote change', 'post', `/promotions/connections/${conn}/apply`);
	await step(
		'clone promote after the remote change',
		'post',
		`/promotions/connections/${conn}/promote/clone`,
	);
	await step(
		'get the connection after the remote change',
		'get',
		`/promotions/connections/${conn}`,
	);
	// #endregion

	// #region Which commit a change list and an apply read
	await step('point the connection back', 'put', `/promotions/connections/${conn}`, {
		target: { schemaVersion: 1, remoteUrl: `${server.origin}/acme/flows.git` },
	});
	await step(
		'set the promote configuration to main',
		'put',
		`/promotions/connections/${conn}/configs/promote`,
		promoteSettings('main'),
	);
	await step(
		'set the apply configuration to main',
		'put',
		`/promotions/connections/${conn}/configs/apply`,
		applySettings('main'),
	);
	await step('clone promote on main', 'post', `/promotions/connections/${conn}/promote/clone`);
	await step('promote the package', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Package',
	});
	await step('clone apply on main', 'post', `/promotions/connections/${conn}/apply/clone`);
	remote.seed(
		'acme',
		'flows',
		'main',
		{ 'README.md': '# Flows, changed elsewhere\n' },
		'Elsewhere',
	);
	const flow2 = await createWorkflow(
		{
			id: 'wf02Flow20000002',
			name: 'Flow 2',
			nodes: [
				{
					id: 'node-1',
					name: 'HTTP Request',
					type: 'n8n-nodes-base.httpRequest',
					typeVersion: 1,
					position: [0, 0],
					parameters: { url: 'https://two.example.com' },
				},
			],
		},
		teamA,
	);
	await createWorkflowHistory(flow2, owner, { event: 'activated', userId: owner.id });
	rec.label('wf02Flow20000002', 'Flow 2');
	const tip = execFileSync('git', [
		'--git-dir',
		path.join(remote.repos, 'acme', 'flows.git'),
		'rev-parse',
		'main',
	])
		.toString()
		.trim();
	const commitRead = (sha: unknown) =>
		sha === tip ? 'the newest commit of the remote' : 'an older commit';
	const applyChanges = await step(
		'changes to apply after a commit elsewhere',
		'get',
		`/promotions/projects/${teamA.id}/changes/apply`,
	);
	const promoteChanges = await step(
		'changes to promote after a commit elsewhere',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote`,
	);
	const applied = await step(
		'apply after a commit elsewhere',
		'post',
		`/promotions/connections/${conn}/apply`,
	);
	transcript.push({
		check: 'the commit that each operation reads',
		changesToApply: commitRead(applyChanges.body?.commitSha),
		changesToPromote: commitRead(promoteChanges.body?.commitSha),
		apply: commitRead(applied.body?.git?.commitSha),
	});
	await step(
		'promote after a commit elsewhere',
		'post',
		`/promotions/connections/${conn}/promote`,
		{
			commitMessage: 'After a commit elsewhere',
		},
	);
	// #endregion

	// #region The order of the change lists
	const httpWorkflow = async (id: string, name: string, url: string) => {
		await createWorkflow(
			{
				id,
				name,
				nodes: [
					{
						id: 'node-1',
						name: 'HTTP Request',
						type: 'n8n-nodes-base.httpRequest',
						typeVersion: 1,
						position: [0, 0],
						parameters: { url },
					},
				],
			},
			teamA,
		);
		rec.label(id, name);
	};
	await step(
		'clone promote for the order',
		'post',
		`/promotions/connections/${conn}/promote/clone`,
	);
	await httpWorkflow('wf04Flow40000004', 'Flow 4', 'https://four.example.com');
	await httpWorkflow('wf05Flow50000005', 'Flow 5', 'https://five.example.com');
	await step('promote Flow 4 and Flow 5', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Flow 4 and Flow 5',
	});
	await Container.get(WorkflowRepository).delete('wf05Flow50000005');
	await new Promise((resolve) => setTimeout(resolve, 20));
	await httpWorkflow('wf06Flow60000006', 'Flow 6', 'https://six.example.com');
	await new Promise((resolve) => setTimeout(resolve, 20));
	await Container.get(WorkflowRepository).update('wf01Flow10000001', {
		nodes: [
			{
				id: 'node-1',
				name: 'HTTP Request',
				type: 'n8n-nodes-base.httpRequest',
				typeVersion: 1,
				position: [0, 0],
				parameters: { url: 'https://one.example.com/v2' },
			},
		],
	});
	for (const direction of ['promote', 'apply']) {
		for (const [sort, order] of [
			['name', 'asc'],
			['name', 'desc'],
			['status', 'asc'],
			['status', 'desc'],
			['updatedAt', 'asc'],
			['updatedAt', 'desc'],
		]) {
			await step(
				`changes to ${direction} sorted by ${sort} ${order}`,
				'get',
				`/promotions/projects/${teamA.id}/changes/${direction}?sort=${sort}&order=${order}`,
			);
		}
	}
	await step(
		'changes to promote that match FLOW',
		'get',
		`/promotions/projects/${teamA.id}/changes/promote?search=%20FLOW%20`,
	);
	// #endregion

	// #region A project that is missing in a blocked apply
	await Container.get(VariablesRepository).save({
		id: 'varEdge000000001',
		key: 'EDGE_VAR',
		value: 'edge',
	});
	await Container.get(VariablesService).updateCache();
	const teamC = await teamProject('projTeamC0000003', 'Team C');
	await Container.get(ProjectRepository).update(teamC.id, {
		description: 'The team C',
		icon: { type: 'emoji', value: '🚀' },
	});
	await createWorkflow(
		{
			id: 'wf03FlowC0000003',
			name: 'Flow C',
			nodes: [
				{
					id: 'node-1',
					name: 'HTTP Request',
					type: 'n8n-nodes-base.httpRequest',
					typeVersion: 1,
					position: [0, 0],
					parameters: { url: '={{ $vars.EDGE_VAR }}' },
				},
			],
		},
		teamC,
	);
	rec.label('wf03FlowC0000003', 'Flow C');
	await step('clone promote again', 'post', `/promotions/connections/${conn}/promote/clone`);
	await step('promote Team C', 'post', `/promotions/connections/${conn}/promote`, {
		commitMessage: 'Team C',
	});
	await Container.get(WorkflowRepository).delete('wf03FlowC0000003');
	await Container.get(ProjectRepository).delete(teamC.id);
	await Container.get(VariablesRepository).delete({ id: 'varEdge000000001' });
	await Container.get(VariablesService).updateCache();
	await step(
		'apply with a missing project and a missing variable',
		'post',
		`/promotions/connections/${conn}/apply`,
	);
	await step('get the connection at the end', 'get', `/promotions/connections/${conn}`);
	// #endregion

	expect(transcript).toMatchSnapshot();
}, 600_000);
