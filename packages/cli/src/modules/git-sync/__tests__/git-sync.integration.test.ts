import { createWorkflow, mockInstance, testDb } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import {
	CredentialsRepository,
	ProjectRepository,
	SettingsRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { RESPONSE_ERROR_MESSAGES } from '@/constants';
import { CredentialTypes } from '@/credential-types';
import { saveCredential } from '@test-integration/db/credentials';
import { createCustomRoleWithScopeSlugs } from '@test-integration/db/roles';
import { createAdmin, createMember, createOwner, createUser } from '@test-integration/db/users';
import { initNodeTypes, setupTestServer } from '@test-integration/utils';

import { GIT_SYNC_CONNECTION_KEY } from '../git-sync.constants';

// The config reads these when the module starts. Only tests may allow the file protocol.
const scratchDir = mkdtempSync(path.join(tmpdir(), 'git-sync-it-'));
process.env.N8N_GIT_SYNC_DIR = path.join(scratchDir, 'instance');
process.env.N8N_GIT_SYNC_ALLOWED_PROTOCOLS = 'file,https';

// The import checks credential types. Mock them before the module creates its services.
mockInstance(CredentialTypes).recognizes.mockReturnValue(true);

// A non-empty endpoint group makes the test server initialize the modules.
const testServer = setupTestServer({ endpointGroups: ['me'], modules: ['git-sync'] });

/** Environment for the Git commands that play a colleague. It ignores the machine configuration. */
const colleagueEnv = {
	PATH: process.env.PATH,
	HOME: scratchDir,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Colleague',
	GIT_AUTHOR_EMAIL: 'colleague@example.com',
	GIT_COMMITTER_NAME: 'Colleague',
	GIT_COMMITTER_EMAIL: 'colleague@example.com',
};

const git = (args: string[], cwd = scratchDir) =>
	execFileSync('git', args, { cwd, env: colleagueEnv, encoding: 'utf8' });

let owner: User;
let remoteDir: string;

const createRemote = () => {
	const dir = mkdtempSync(path.join(scratchDir, 'remote-'));
	git(['init', '--bare', '--quiet', '--initial-branch=main', dir]);
	return dir;
};

const remoteFiles = () =>
	git(['--git-dir', remoteDir, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean);

const readRemoteFile = (file: string) => git(['--git-dir', remoteDir, 'show', `main:${file}`]);

const remoteWorkflowFile = (id: string) => {
	const file = remoteFiles().find((name) => name.endsWith(`-${id}/workflow.json`));
	if (!file) throw new Error(`Workflow ${id} is not in the remote`);
	return file;
};

/** Commits a change in a separate clone and pushes it, as a colleague would. */
const commitAsColleague = (change: (cloneDir: string) => void) => {
	const cloneDir = mkdtempSync(path.join(scratchDir, 'clone-'));
	try {
		git(['clone', '--quiet', remoteDir, cloneDir]);
		change(cloneDir);
		git(['add', '--all'], cloneDir);
		git(['commit', '--quiet', '-m', 'Change from a colleague'], cloneDir);
		git(['push', '--quiet', 'origin', 'HEAD:main'], cloneDir);
	} finally {
		rmSync(cloneDir, { recursive: true, force: true });
	}
};

const editRemoteWorkflow = (id: string, edit: (workflow: Record<string, unknown>) => void) => {
	commitAsColleague((cloneDir) => {
		const file = path.join(cloneDir, remoteWorkflowFile(id));
		const workflow = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
		edit(workflow);
		writeFileSync(file, JSON.stringify(workflow, null, '\t'));
	});
};

const settings = () => ({
	repositoryUrl: pathToFileURL(remoteDir).href,
	branch: 'main',
	authorName: 'n8n Git sync',
	authorEmail: 'git-sync@example.com',
});

const connect = async () => {
	await testServer.authAgentFor(owner).put('/git-sync/settings').send(settings()).expect(200);
};

const push = (message = 'Update workflows') =>
	testServer.authAgentFor(owner).post('/git-sync/push').send({ message });

const pull = (body: Record<string, unknown> = {}) =>
	testServer.authAgentFor(owner).post('/git-sync/pull').send(body);

const status = async () => {
	const response = await testServer.authAgentFor(owner).get('/git-sync/status').expect(200);
	return response.body.data;
};

const simpleWorkflow = async (name: string, credentialId?: string) =>
	await createWorkflow(
		{
			name,
			nodes: [
				{
					id: 'trigger',
					name: 'Start',
					type: 'n8n-nodes-base.manualTrigger',
					typeVersion: 1,
					position: [0, 0],
					parameters: {},
				},
				{
					id: 'request',
					name: 'Request',
					type: 'n8n-nodes-base.httpRequest',
					typeVersion: 1,
					position: [200, 0],
					parameters: { url: 'https://example.com' },
					...(credentialId
						? { credentials: { httpBasicAuth: { id: credentialId, name: 'Basic auth' } } }
						: {}),
				},
			],
			connections: { Start: { main: [[{ node: 'Request', type: 'main', index: 0 }]] } },
		},
		owner,
	);

/** Changes a workflow the way a save in the editor does: new content and a new version ID. */
const editLocalWorkflow = async (id: string, name: string) => {
	await Container.get(WorkflowRepository).update(id, { name, versionId: crypto.randomUUID() });
};

beforeAll(async () => {
	owner = await createOwner();
	await initNodeTypes();
});

beforeEach(async () => {
	await testServer.authAgentFor(owner).delete('/git-sync/settings').expect(200);
	await testDb.truncate([
		'SharedWorkflow',
		'WorkflowEntity',
		'SharedCredentials',
		'CredentialsEntity',
	]);
	remoteDir = createRemote();
});

afterAll(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

describe('access', () => {
	it('refuses members', async () => {
		const member = await createMember();

		const response = await testServer.authAgentFor(member).get('/git-sync/status').expect(403);
		await testServer.authAgentFor(member).put('/git-sync/settings').send(settings()).expect(403);

		expect(response.body.message).toBe(RESPONSE_ERROR_MESSAGES.MISSING_SCOPE);
	});

	it('lets a custom role with the scope sourceControl:manage in', async () => {
		const gitSyncRole = await createCustomRoleWithScopeSlugs(['sourceControl:manage'], {
			roleType: 'global',
		});
		const user = await createUser({ role: gitSyncRole });

		const response = await testServer.authAgentFor(user).get('/git-sync/settings').expect(200);

		expect(response.body.data).toBeNull();
	});

	it('lets admins in', async () => {
		const admin = await createAdmin();

		const response = await testServer.authAgentFor(admin).get('/git-sync/settings').expect(200);

		expect(response.body.data).toBeNull();
	});
});

describe('settings', () => {
	it('uses the personal project of the user by default and never returns the token', async () => {
		const agent = testServer.authAgentFor(owner);
		const personalProject = await Container.get(ProjectRepository).getPersonalProjectForUserOrFail(
			owner.id,
		);

		const saved = await agent
			.put('/git-sync/settings')
			.send({ ...settings(), accessToken: 'secret-token' })
			.expect(200);

		expect(saved.body.data).toMatchObject({
			branch: 'main',
			directory: 'n8n',
			projectId: personalProject.id,
			accessToken: CREDENTIAL_BLANKING_VALUE,
		});
		const row = await Container.get(SettingsRepository).findByKey(GIT_SYNC_CONNECTION_KEY);
		expect(row?.value).not.toContain('secret-token');
		const { encryptedToken } = JSON.parse(row?.value ?? '{}') as { encryptedToken: string };

		// The blanking value keeps the stored token.
		await agent
			.put('/git-sync/settings')
			.send({ ...settings(), accessToken: CREDENTIAL_BLANKING_VALUE })
			.expect(200);
		const kept = await Container.get(SettingsRepository).findByKey(GIT_SYNC_CONNECTION_KEY);
		expect(JSON.parse(kept?.value ?? '{}')).toMatchObject({ encryptedToken });

		// An empty value removes it.
		const removed = await agent
			.put('/git-sync/settings')
			.send({ ...settings(), accessToken: '' })
			.expect(200);
		expect(removed.body.data.accessToken).toBe('');
	});

	it('refuses a URL with credentials in it', async () => {
		const response = await testServer
			.authAgentFor(owner)
			.put('/git-sync/settings')
			.send({ ...settings(), repositoryUrl: 'https://user:pass@example.com/flows.git' })
			.expect(400);

		expect(response.body.meta.code).toBe('GIT_SYNC_INVALID_SETTINGS');
	});

	it('tests the connection without saving it', async () => {
		const agent = testServer.authAgentFor(owner);

		const empty = await agent.post('/git-sync/test-connection').send(settings()).expect(200);
		expect(empty.body.data).toEqual({ defaultBranch: null, branchExists: false, branchHead: null });

		commitAsColleague((cloneDir) => writeFileSync(path.join(cloneDir, 'README.md'), '# Flows\n'));
		const filled = await agent.post('/git-sync/test-connection').send(settings()).expect(200);
		expect(filled.body.data).toMatchObject({ defaultBranch: 'main', branchExists: true });

		await agent.get('/git-sync/settings').expect(200, { data: null });
	});

	it('reports a missing connection', async () => {
		const response = await pull().expect(400);

		expect(response.body.meta.code).toBe('GIT_SYNC_NOT_CONFIGURED');
	});
});

describe('push', () => {
	it('writes the workflows of the project to the branch', async () => {
		const credential = await saveCredential(
			{ name: 'Basic auth', type: 'httpBasicAuth', data: { user: 'admin', password: 'hunter2' } },
			{ user: owner, role: 'credential:owner' },
		);
		const first = await simpleWorkflow('First flow', credential.id);
		const second = await simpleWorkflow('Second flow');
		await connect();

		expect(await status()).toMatchObject({
			remoteHead: null,
			incoming: [],
			outgoing: [
				{ id: first.id, name: 'First flow', change: 'created' },
				{ id: second.id, name: 'Second flow', change: 'created' },
			],
		});

		const response = await push('Add flows').expect(200);

		expect(response.body.data).toMatchObject({ result: 'pushed', changedFiles: 5 });
		expect(remoteFiles()).toEqual(
			expect.arrayContaining([
				'n8n/manifest.json',
				`n8n/workflows/first-flow-${first.id}/workflow.json`,
				`n8n/workflows/first-flow-${first.id}/workflow-metadata.json`,
				`n8n/workflows/second-flow-${second.id}/workflow.json`,
				`n8n/credentials/basic-auth-${credential.id}/credential.json`,
			]),
		);
		const credentialFile = JSON.parse(
			readRemoteFile(`n8n/credentials/basic-auth-${credential.id}/credential.json`),
		) as Record<string, unknown>;
		expect(Object.keys(credentialFile).sort()).toEqual(['id', 'name', 'type']);
		expect(readRemoteFile('n8n/manifest.json')).not.toContain('hunter2');

		const commitLine = git([
			'--git-dir',
			remoteDir,
			'log',
			'-1',
			'--format=%an|%ae|%cn|%ce|%s',
			'main',
		]);
		expect(commitLine.trim()).toBe(
			`${owner.firstName} ${owner.lastName}|${owner.email}|n8n Git sync|git-sync@example.com|Add flows`,
		);

		expect(await status()).toMatchObject({ outgoing: [], incoming: [], remoteChanged: false });
		await expect(push().then(({ body }) => body.data)).resolves.toEqual({
			result: 'up-to-date',
			commit: response.body.data.commit,
		});
	});

	it('pushes local edits and keeps files that the package does not own', async () => {
		const workflow = await simpleWorkflow('Report');
		await connect();
		await push().expect(200);
		commitAsColleague((cloneDir) => writeFileSync(path.join(cloneDir, 'README.md'), '# Flows\n'));

		await editLocalWorkflow(workflow.id, 'Weekly report');
		expect((await status()).outgoing).toEqual([
			{ id: workflow.id, name: 'Weekly report', change: 'modified' },
		]);

		// The README commit does not touch the package, so no pull is needed.
		const response = await push('Rename report').expect(200);

		expect(response.body.data.result).toBe('pushed');
		expect(remoteFiles()).toContain('README.md');
		expect(remoteFiles()).toContain(`n8n/workflows/weekly-report-${workflow.id}/workflow.json`);
		expect(remoteFiles()).not.toContain(`n8n/workflows/report-${workflow.id}/workflow.json`);
	});

	it('reports a push that the Git server rejects', async () => {
		await simpleWorkflow('Report');
		await connect();
		const hook = path.join(remoteDir, 'hooks', 'pre-receive');
		writeFileSync(hook, '#!/bin/sh\necho "the branch is protected" >&2\nexit 1\n', { mode: 0o755 });

		const response = await push().expect(409);

		expect(response.body.meta.code).toBe('GIT_SYNC_PUSH_REJECTED');
		expect(response.body.meta.detail).toContain('pre-receive hook declined');
		expect(git(['--git-dir', remoteDir, 'for-each-ref'])).toBe('');
	});

	it('asks for a pull when the branch has new package changes', async () => {
		const workflow = await simpleWorkflow('Report');
		await connect();
		await push().expect(200);
		editRemoteWorkflow(workflow.id, (content) => {
			content.name = 'Report from Git';
		});

		const response = await push().expect(409);

		expect(response.body.meta.code).toBe('GIT_SYNC_PULL_FIRST');
	});
});

describe('pull', () => {
	it('imports the workflows that changed in Git', async () => {
		const changed = await simpleWorkflow('Report');
		const unchanged = await simpleWorkflow('Cleanup');
		const removed = await simpleWorkflow('Old flow');
		await connect();
		await push().expect(200);

		editRemoteWorkflow(changed.id, (content) => {
			content.name = 'Report from Git';
		});
		commitAsColleague((cloneDir) => {
			const manifestFile = path.join(cloneDir, 'n8n/manifest.json');
			const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
				workflows: Array<{ id: string }>;
			};
			manifest.workflows = manifest.workflows.filter(({ id }) => id !== removed.id);
			writeFileSync(manifestFile, JSON.stringify(manifest, null, '\t'));
			rmSync(path.join(cloneDir, `n8n/workflows/old-flow-${removed.id}`), { recursive: true });
		});

		const before = await status();
		expect(before.remoteChanged).toBe(true);
		expect(before.incoming).toEqual([
			{ id: changed.id, name: 'Report', change: 'modified' },
			{ id: removed.id, name: 'Old flow', change: 'deleted' },
		]);

		const response = await pull().expect(200);

		expect(response.body.data).toMatchObject({
			result: 'pulled',
			created: [],
			updated: ['Report from Git'],
			removedUpstream: [{ id: removed.id, change: 'deleted' }],
		});
		const workflowRepository = Container.get(WorkflowRepository);
		expect((await workflowRepository.findOneByOrFail({ id: changed.id })).name).toBe(
			'Report from Git',
		);
		expect((await workflowRepository.findOneByOrFail({ id: unchanged.id })).name).toBe('Cleanup');
		// A pull never deletes a workflow.
		expect(await workflowRepository.findOneBy({ id: removed.id })).not.toBeNull();

		const after = await status();
		expect(after.incoming).toEqual([]);
		expect(after.remoteChanged).toBe(false);
	});

	it('stops on workflows that changed on both sides until the user overwrites them', async () => {
		const workflow = await simpleWorkflow('Report');
		await connect();
		await push().expect(200);
		editRemoteWorkflow(workflow.id, (content) => {
			content.name = 'Report from Git';
		});
		await editLocalWorkflow(workflow.id, 'Report from n8n');

		expect((await status()).conflicts).toEqual([
			{ id: workflow.id, name: 'Report from n8n', change: 'modified' },
		]);
		const refused = await pull().expect(409);
		expect(refused.body.meta).toMatchObject({
			code: 'GIT_SYNC_LOCAL_CHANGES',
			conflicts: [{ id: workflow.id }],
		});

		await pull({ overwriteLocalChanges: true }).expect(200);

		const stored = await Container.get(WorkflowRepository).findOneByOrFail({ id: workflow.id });
		expect(stored.name).toBe('Report from Git');
	});

	it('restores the project on an empty instance with the same IDs and credential stubs', async () => {
		const credential = await saveCredential(
			{ name: 'Basic auth', type: 'httpBasicAuth', data: { user: 'admin', password: 'hunter2' } },
			{ user: owner, role: 'credential:owner' },
		);
		const workflow = await simpleWorkflow('Report', credential.id);
		await connect();
		await push().expect(200);

		// A second instance: no workflows, no credentials, no Git sync state.
		await testServer.authAgentFor(owner).delete('/git-sync/settings').expect(200);
		expect(existsSync(path.join(scratchDir, 'instance', 'repo'))).toBe(false);
		await testDb.truncate([
			'SharedWorkflow',
			'WorkflowEntity',
			'SharedCredentials',
			'CredentialsEntity',
		]);
		await connect();

		const response = await pull().expect(200);

		expect(response.body.data).toMatchObject({
			result: 'pulled',
			created: ['Report'],
			stubbedCredentials: ['Basic auth'],
		});
		const restored = await Container.get(WorkflowRepository).findOneByOrFail({ id: workflow.id });
		const stub = await Container.get(CredentialsRepository).findOneByOrFail({
			name: 'Basic auth',
			type: 'httpBasicAuth',
		});
		expect(restored.nodes[1].credentials).toEqual({
			httpBasicAuth: { id: stub.id, name: 'Basic auth' },
		});
		expect((await status()).outgoing).toEqual([]);
	});

	it('does not rewrite pulled workflows when the other instance pushes', async () => {
		const workflow = await simpleWorkflow('Report');
		await connect();
		const first = await push().expect(200);

		// A second instance pulls the workflow. The import gives it new version IDs.
		await testServer.authAgentFor(owner).delete('/git-sync/settings').expect(200);
		await testDb.truncate(['SharedWorkflow', 'WorkflowEntity']);
		await connect();
		await pull().expect(200);
		const stored = await Container.get(WorkflowRepository).findOneByOrFail({ id: workflow.id });
		expect(stored.versionId).not.toBe(workflow.versionId);

		expect((await status()).outgoing).toEqual([]);
		const second = await push().expect(200);

		expect(second.body.data).toEqual({ result: 'up-to-date', commit: first.body.data.commit });
	});

	it('reports a branch that does not exist yet', async () => {
		await connect();

		const response = await pull().expect(200);

		expect(response.body.data).toEqual({ result: 'no-remote-branch' });
	});
});
