// Fork test (not in upstream n8n): the public API of source control (`/api/v1/source-control`)
// with the fork module. The golden tests of this folder cover the REST API.
import { createWorkflow, mockInstance, testDb } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { createMemberWithApiKey, createOwnerWithApiKey } from '@test-integration/db/users';
import * as utils from '@test-integration/utils';

import { LocalGitHttpServer } from './git-http-server';
import { LocalGitRemote } from './git-remote';

// Git must reach the local server directly, also when the environment names a proxy.
for (const name of Object.keys(process.env)) {
	if (/proxy/i.test(name)) delete process.env[name];
}

mockInstance(ActiveWorkflowManager);

const remote = new LocalGitRemote();
remote.install();
const server = new LocalGitHttpServer(remote.repos);

const testServer = utils.setupTestServer({
	endpointGroups: ['publicApi', 'sourceControl'],
	enabledFeatures: ['feat:sourceControl'],
	modules: ['source-control'],
});

let owner: User;
let member: User;

const workflowFile = (id: string, name: string, versionId: string) =>
	JSON.stringify(
		{
			id,
			name,
			description: null,
			nodes: [],
			connections: {},
			settings: {},
			triggerCount: 0,
			versionId,
			owner: { type: 'personal', personalEmail: 'nobody@example.com' },
			parentFolderId: null,
			isArchived: false,
			nodeGroups: [],
		},
		null,
		2,
	);

beforeAll(async () => {
	await server.start();
	process.env.GIT_SSL_CAINFO = server.certFile;
	owner = await createOwnerWithApiKey();
	member = await createMemberWithApiKey();
	remote.createRepo('owner', 'repo');
	remote.seed('owner', 'repo', 'main', { 'README.md': '# n8n\n' }, 'Initial commit');
});

afterAll(async () => {
	remote.uninstall();
	await server.stop();
	await testDb.terminate();
});

describe('Source control in the public API', () => {
	test('the routes need a connection', async () => {
		const api = testServer.publicApiAgentFor(owner);

		const status = await api.get('/source-control/status').query({ direction: 'push' });
		expect(status.status).toBe(400);
		expect(status.body.message).toBe('Source Control is not connected to a repository');

		const pull = await api.post('/source-control/pull').send({ force: true });
		expect(pull.status).toBe(400);
		expect(pull.body).toEqual({
			status: 'Error',
			message: 'Source Control is not connected to a repository',
		});
	});

	test('status, push and pull with a connected branch', async () => {
		const connect = await testServer
			.authAgentFor(owner)
			.post('/source-control/preferences')
			.send({
				repositoryUrl: `${server.origin}/owner/repo.git`,
				connectionType: 'https',
				httpsUsername: 'git-user',
				httpsPassword: 'git-token',
			});
		expect(connect.status).toBe(200);
		expect(connect.body.data.connected).toBe(true);

		const api = testServer.publicApiAgentFor(owner);
		const workflow = await createWorkflow({ name: 'API workflow' }, owner);

		// The status of a push lists the new workflow.
		const status = await api.get('/source-control/status').query({ direction: 'push' });
		expect(status.status).toBe(200);
		expect(status.body.data).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: workflow.id, type: 'workflow', status: 'created' }),
			]),
		);

		// A push of the workflow writes its file to the branch.
		const push = await api.post('/source-control/push').send({
			commitMessage: 'Push from the public API',
			fileNames: [{ id: workflow.id, type: 'workflow' }],
		});
		expect(push.status).toBe(200);
		expect(push.body.data).toEqual([
			expect.objectContaining({ id: workflow.id, type: 'workflow', pushed: true }),
		]);
		const files = remote.readBranch('owner', 'repo', 'main') ?? {};
		expect(Object.keys(files)).toContain(`workflows/${workflow.id}.json`);
		expect(remote.log('owner', 'repo', 'main')[0]).toMatch(/^Push from the public API\|/);

		// A change in Git and in the instance is a conflict: the push needs `force`.
		remote.seed(
			'owner',
			'repo',
			'main',
			{
				[`workflows/${workflow.id}.json`]: workflowFile(
					workflow.id,
					'Changed in Git',
					'11111111-1111-4111-8111-111111111111',
				),
			},
			'Change in Git',
		);
		await Container.get(WorkflowRepository).update(workflow.id, {
			name: 'Changed locally',
			versionId: '22222222-2222-4222-8222-222222222222',
		});
		const conflict = await api.post('/source-control/push').send({
			commitMessage: 'Conflict',
			fileNames: [{ id: workflow.id, type: 'workflow' }],
		});
		expect(conflict.status).toBe(409);
		expect(conflict.body.message).toBe(
			'Push blocked by conflicting files. Pass `force: true` to push anyway.',
		);

		// A pull with force takes the version of Git, and a new workflow of Git.
		remote.seed(
			'owner',
			'repo',
			'main',
			{
				'workflows/wfFromGit0000001.json': workflowFile(
					'wfFromGit0000001',
					'Workflow from Git',
					'33333333-3333-4333-8333-333333333333',
				),
			},
			'New workflow in Git',
		);
		const blocked = await api.post('/source-control/pull').send({ force: false });
		expect(blocked.status).toBe(409);

		const pull = await api.post('/source-control/pull').send({ force: true });
		expect(pull.status).toBe(200);
		expect(pull.body).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: workflow.id, status: 'modified' }),
				expect.objectContaining({ id: 'wfFromGit0000001', status: 'created' }),
			]),
		);
		const workflows = Container.get(WorkflowRepository);
		expect((await workflows.findOneByOrFail({ id: workflow.id })).name).toBe('Changed in Git');
		expect((await workflows.findOneByOrFail({ id: 'wfFromGit0000001' })).name).toBe(
			'Workflow from Git',
		);

		// The status of a pull is empty now.
		const after = await api.get('/source-control/status').query({ direction: 'pull' });
		expect(after.status).toBe(200);
		expect(after.body.data).toEqual([]);
	});

	test('a member without source control scopes is refused', async () => {
		const api = testServer.publicApiAgentFor(member);
		expect((await api.get('/source-control/status').query({ direction: 'push' })).status).toBe(403);
		expect(
			(
				await api
					.post('/source-control/push')
					.send({ commitMessage: 'x', fileNames: [{ id: 'x', type: 'workflow' }] })
			).status,
		).toBe(403);
		expect((await api.post('/source-control/pull').send({ force: true })).status).toBe(403);
	});
});
