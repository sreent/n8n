// Fork test (not in upstream n8n): a golden test of the settings of source control. It reads and
// changes the preferences, makes key pairs, connects to a local Git server over HTTPS, lists and
// changes branches, turns on the protected instance, disconnects, and calls each route as users
// with each role and without the licence. It records the status and the body of each answer, the
// rows of the settings table, the events, the Git requests and the ssh calls of each step. The
// snapshot was recorded against the original module of source control, and the fork module gives
// the same snapshot. See `packages/cli/src/modules/source-control/README.md`.
import { createTeamProject, linkUserToProject, mockInstance } from '@n8n/backend-test-utils';
import { EventService, InstanceWriteAccessService } from '@n8n/backend-services';
import type { User } from '@n8n/db';
import {
	GLOBAL_ADMIN_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRepository,
	SettingsRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { InstanceSettings } from 'n8n-core';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { ConnectProxy } from './connect-proxy';
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
const proxy = new ConnectProxy();

const testServer = utils.setupTestServer({
	endpointGroups: ['sourceControl', 'workflows', 'data-table'],
	enabledFeatures: ['feat:sourceControl', 'feat:sharing'],
	quotas: { 'quota:maxTeamProjects': -1 },
	modules: ['source-control', 'data-table'],
});

const rec = new GoldenRecorder();

// The audit events of the fork (`ForkGovernanceEventRelay`). The original module does not send
// them, so the record leaves them out.
const FORK_AUDIT_EVENTS = new Set([
	'source-control-settings-saved',
	'source-control-disconnected',
	'source-control-pushed',
	'source-control-pulled',
]);

type Who = 'owner' | 'admin' | 'member' | 'projAdmin';

const USER_IDS: Record<Who, string> = {
	owner: '00000000-0000-4000-8000-000000000001',
	admin: '00000000-0000-4000-8000-000000000002',
	member: '00000000-0000-4000-8000-000000000003',
	projAdmin: '00000000-0000-4000-8000-000000000004',
};

const users = {} as Record<Who, User>;
const agents = {} as Record<Who, SuperAgentTest>;
let projectId = '';
let transcript: unknown[] = [];
let events: Array<{ name: string; payload: unknown }> = [];

/** Public keys get a number in the order in which they come, so that a snapshot shows a new key. */
const keyLabels = new Map<string, string>();

function keyLabel(key: string) {
	let label = keyLabels.get(key);
	if (!label) {
		label = `<key ${keyLabels.size + 1}, ${key.length} characters>`;
		keyLabels.set(key, label);
	}
	return label;
}

/** Masks the parts of a text that change from run to run: ports, paths, keys and hashes. */
function mask(text: string): string {
	return (
		text
			.split(remote.root)
			.join('<remote>')
			.replace(/\/tmp\/n8n-tests\/[^/\s'"]+\/\.n8n/g, '<n8n>')
			.replace(/\/tmp\/[^\s'"]+/g, '<tmp>')
			.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
			.replace(/localhost:\d+/g, 'localhost:<port>')
			// The time of a failed connection that git reports changes from run to run.
			.replace(/ after \d+ ms:/g, ' after <n> ms:')
			.replace(
				/(ssh-(?:ed25519|rsa)) ([A-Za-z0-9+/=]+)/g,
				(_match, type: string, key: string) => `${type} ${keyLabel(key)}`,
			)
			.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----\n?/g, '<private key>')
	);
}

/** Masks each string first, so that the labels of the recorder do not cut a key in two. */
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

/** The rows of the settings table that source control wrote, with masked secrets. */
async function settingsRows() {
	const rows = await Container.get(SettingsRepository).find();
	return rows
		.filter((row) => row.key.toLowerCase().includes('sourcecontrol'))
		.map((row) => {
			let value: unknown = row.value;
			try {
				value = JSON.parse(row.value);
			} catch {}
			const masked = JSON.stringify(value, (_key, entry: unknown) =>
				typeof entry === 'string' && entry.length > 40 && !entry.includes(' ')
					? `<${entry.length > 200 ? 'long' : 'short'} secret>`
					: entry,
			);
			return `${row.key} = ${mask(masked)} (loadOnStartup ${String(row.loadOnStartup)})`;
		})
		.sort();
}

/** The distinct Git requests of a step: path, service, authentication and status. */
function gitRequests() {
	const counts = new Map<string, number>();
	for (const request of server.takeRequests()) {
		const line = `${request.method} ${request.path}${request.service ? `?service=${request.service}` : ''} auth=${request.auth} -> ${request.status}`;
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return [...counts].map(([line, count]) => `${line} x${count}`).sort();
}

function sshCalls() {
	return [...new Set(remote.takeSshCalls().map(mask))].sort();
}

/** The state of the Git work folder of n8n: the branch, the remote, the commits and the files. */
function workFolder() {
	const folder = path.join(Container.get(InstanceSettings).n8nFolder, 'git');
	if (!existsSync(folder)) return { exists: false };
	const git = (...args: string[]) => {
		try {
			return mask(execFileSync('git', args, { cwd: folder, encoding: 'utf-8' }).trim());
		} catch (error) {
			return `<error: ${mask(String((error as { stderr?: string }).stderr ?? error)).trim()}>`;
		}
	};
	return {
		exists: true,
		branch: git('branch', '--show-current'),
		branches: git('branch', '-a', '--format=%(refname)'),
		remotes: git('remote', '-v'),
		config: git('config', '--local', '--list'),
		log: git('log', '--format=%s|%an <%ae>|%cn <%ce>'),
		files: git('ls-files'),
		status: git('status', '--porcelain'),
		entries: readdirSync(folder).sort(),
	};
}

async function step(
	name: string,
	run: () => Promise<{ status: number; body: unknown }>,
	extra: () => Record<string, unknown> = () => ({}),
) {
	events = [];
	const response = await run();
	// A workflow that a step creates gets a label, because its id is random.
	const created = (response.body as { data?: { id?: unknown; name?: unknown } } | undefined)?.data;
	if (created && typeof created.id === 'string' && typeof created.name === 'string') {
		if (!rec.labels.has(created.id)) rec.label(created.id, `created ${created.name}`);
	}
	transcript.push({
		step: name,
		status: response.status,
		body: normalize(response.body),
		...(events.length > 0 ? { events: normalize(events) } : {}),
		git: gitRequests(),
		ssh: sshCalls(),
		...extra(),
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
}

beforeAll(async () => {
	await server.start();
	process.env.GIT_SSL_CAINFO = server.certFile;
	// A direct hook: the test setup restores the spies of `vi.spyOn` before each test.
	const eventService = Container.get(EventService);
	const emit = eventService.emit.bind(eventService);
	eventService.emit = ((name: string, ...rest: unknown[]) => {
		if (!FORK_AUDIT_EVENTS.has(String(name)) && String(name).startsWith('source-control')) {
			events.push({ name: String(name), payload: deepCopy(rest[0] ?? null) });
		}
		return emit(name as never, ...(rest as never[]));
	}) as typeof eventService.emit;
	await makeUser('owner', 'Olivia', GLOBAL_OWNER_ROLE);
	await makeUser('admin', 'Adam', GLOBAL_ADMIN_ROLE);
	await makeUser('member', 'Mia', GLOBAL_MEMBER_ROLE);
	await makeUser('projAdmin', 'Paul', GLOBAL_MEMBER_ROLE);
	const project = await createTeamProject('Golden project', users.owner);
	rec.label(project.id, 'project');
	projectId = project.id;
	await linkUserToProject(users.projAdmin, project, 'project:admin');
	// The remote starts with one commit on `main` and one on `develop`. A second remote is empty.
	remote.createRepo('owner', 'empty');
	remote.createRepo('owner', 'repo');
	remote.seed('owner', 'repo', 'main', { 'README.md': '# n8n\n' }, 'Initial commit');
	remote.seed('owner', 'repo', 'develop', { 'README.md': '# n8n develop\n' }, 'Develop commit');
});

afterAll(async () => {
	remote.uninstall();
	await server.stop();
});

const repositoryUrl = () => `${server.origin}/owner/repo.git`;

const credentials = { httpsUsername: 'git-user', httpsPassword: 'git-token' };

test('the settings of source control', { timeout: 300_000 }, async () => {
	transcript = [];
	const owner = agents.owner;

	// The preferences and the key pair before a connection.
	for (const who of ['owner', 'admin', 'member', 'projAdmin'] as const) {
		await step(
			`${who}: get preferences`,
			async () => await agents[who].get('/source-control/preferences'),
		);
	}
	await step('settings rows at the start', async () => ({ status: 0, body: await settingsRows() }));

	// The routes that need a connection, before the first connection.
	await step(
		'not connected: status for push',
		async () => await owner.get('/source-control/get-status').query({ direction: 'push' }),
	);
	await step('not connected: status', async () => await owner.get('/source-control/status'));
	await step(
		'not connected: branches',
		async () => await owner.get('/source-control/get-branches'),
	);
	await step(
		'not connected: push',
		async () =>
			await owner
				.post('/source-control/push-workfolder')
				.send({ commitMessage: 'x', fileNames: [] }),
	);
	await step(
		'not connected: pull',
		async () => await owner.post('/source-control/pull-workfolder').send({ force: false }),
	);
	await step(
		'not connected: reset',
		async () => await owner.get('/source-control/reset-workfolder'),
	);
	await step(
		'not connected: remote content',
		async () => await owner.get('/source-control/remote-content/workflow/missing'),
	);
	await step(
		'not connected: member status',
		async () => await agents.member.get('/source-control/get-status').query({ direction: 'push' }),
	);
	await step(
		'not connected: disconnect',
		async () => await owner.post('/source-control/disconnect').send({ keepKeyPair: true }),
	);
	await step(
		'preferences after a disconnection without a connection',
		async () => await owner.get('/source-control/preferences'),
	);
	await step(
		'generate an RSA key pair',
		async () =>
			await owner.post('/source-control/generate-key-pair').send({ keyGeneratorType: 'rsa' }),
	);
	await step(
		'preferences after the RSA key pair',
		async () => await owner.get('/source-control/preferences'),
	);
	await step(
		'generate a key pair without a type',
		async () => await owner.post('/source-control/generate-key-pair').send({}),
	);
	await step(
		'generate a key pair of an unknown type',
		async () =>
			await owner.post('/source-control/generate-key-pair').send({ keyGeneratorType: 'dsa' }),
	);
	await step(
		'generate an ed25519 key pair',
		async () =>
			await owner.post('/source-control/generate-key-pair').send({ keyGeneratorType: 'ed25519' }),
	);
	await step('settings rows after the key pairs', async () => ({
		status: 0,
		body: await settingsRows(),
	}));

	// Invalid connections. None of them reaches the Git server, or the Git server refuses them.
	const invalid: Array<[string, Record<string, unknown>]> = [
		['an empty body', {}],
		['no repository URL', { connectionType: 'https', ...credentials }],
		['an unknown connection type', { repositoryUrl: repositoryUrl(), connectionType: 'ftp' }],
		[
			'an HTTPS URL without credentials',
			{ repositoryUrl: repositoryUrl(), connectionType: 'https' },
		],
		[
			'a wrong password',
			{
				repositoryUrl: repositoryUrl(),
				connectionType: 'https',
				httpsUsername: 'git-user',
				httpsPassword: 'wrong',
			},
		],
		[
			'a missing repository',
			{
				repositoryUrl: `${server.origin}/owner/missing.git`,
				connectionType: 'https',
				...credentials,
			},
		],
		[
			'a closed port',
			{
				repositoryUrl: 'https://127.0.0.1:9/owner/repo.git',
				connectionType: 'https',
				...credentials,
			},
		],
		[
			'a URL that is not a URL',
			{ repositoryUrl: 'not a url', connectionType: 'https', ...credentials },
		],
		[
			'an invalid branch color',
			{
				repositoryUrl: repositoryUrl(),
				connectionType: 'https',
				...credentials,
				branchColor: 'red',
			},
		],
	];
	for (const [name, body] of invalid) {
		await step(
			`connect with ${name}`,
			async () => await owner.post('/source-control/preferences').send(body),
		);
		await step(
			`preferences after ${name}`,
			async () => await owner.get('/source-control/preferences'),
		);
	}
	await step(
		'connect as an admin',
		async () =>
			await agents.admin
				.post('/source-control/preferences')
				.send({ repositoryUrl: repositoryUrl(), connectionType: 'https', ...credentials }),
	);
	await step('the work folder after the connection of the admin', async () => ({
		status: 0,
		body: workFolder(),
	}));
	await step(
		'admin: disconnect',
		async () => await agents.admin.post('/source-control/disconnect').send({ keepKeyPair: true }),
	);
	await step('the work folder after the disconnection of the admin', async () => ({
		status: 0,
		body: workFolder(),
	}));
	await step(
		'connect as a member',
		async () =>
			await agents.member
				.post('/source-control/preferences')
				.send({ repositoryUrl: repositoryUrl(), connectionType: 'https', ...credentials }),
	);

	// A connection to an empty repository.
	await step(
		'connect to an empty repository',
		async () =>
			await owner.post('/source-control/preferences').send({
				repositoryUrl: `${server.origin}/owner/empty.git`,
				connectionType: 'https',
				...credentials,
			}),
	);
	await step('the work folder of the empty repository', async () => ({
		status: 0,
		body: workFolder(),
	}));
	await step('the empty repository after the connection', async () => ({
		status: 0,
		body: {
			branches: remote.branches('owner', 'empty'),
			log: remote.log('owner', 'empty', 'main'),
			files: remote.readBranch('owner', 'empty', 'main'),
		},
	}));
	await step(
		'get branches of the empty repository',
		async () => await owner.get('/source-control/get-branches'),
	);
	await step(
		'disconnect from the empty repository',
		async () => await owner.post('/source-control/disconnect').send({ keepKeyPair: true }),
	);
	await step(
		'connect without initializing the repository',
		async () =>
			await owner.post('/source-control/preferences').send({
				repositoryUrl: repositoryUrl(),
				connectionType: 'https',
				...credentials,
				branchName: 'main',
				branchColor: '#123456',
				initRepo: false,
			}),
	);
	await step(
		'preferences after a connection without initializing',
		async () => await owner.get('/source-control/preferences'),
	);
	await step('the work folder after a connection without initializing', async () => ({
		status: 0,
		body: workFolder(),
	}));
	await step(
		'disconnect after a connection without initializing',
		async () => await owner.post('/source-control/disconnect').send({ keepKeyPair: true }),
	);

	// A connection over HTTPS.
	await step(
		'connect over HTTPS',
		async () =>
			await owner
				.post('/source-control/preferences')
				.send({ repositoryUrl: repositoryUrl(), connectionType: 'https', ...credentials }),
	);
	await step('settings rows after the connection', async () => ({
		status: 0,
		body: await settingsRows(),
	}));
	for (const who of ['owner', 'admin', 'member', 'projAdmin'] as const) {
		await step(
			`${who}: get preferences when connected`,
			async () => await agents[who].get('/source-control/preferences'),
		);
	}
	await step(
		'connect again',
		async () =>
			await owner
				.post('/source-control/preferences')
				.send({ repositoryUrl: repositoryUrl(), connectionType: 'https', ...credentials }),
	);
	await step('the work folder after the connection', async () => ({
		status: 0,
		body: workFolder(),
	}));

	// Branches.
	for (const who of ['owner', 'admin', 'member', 'projAdmin'] as const) {
		await step(
			`${who}: get branches`,
			async () => await agents[who].get('/source-control/get-branches'),
		);
	}
	// Git over HTTPS uses the proxy of the environment.
	await proxy.start();
	process.env.npm_config_https_proxy = proxy.url;
	await step(
		'get branches through a proxy',
		async () => await owner.get('/source-control/get-branches'),
		() => ({ proxy: proxy.takeSummary() }),
	);
	process.env.npm_config_no_proxy = '127.0.0.1';
	await step(
		'get branches with the host in no_proxy',
		async () => await owner.get('/source-control/get-branches'),
		() => ({ proxy: proxy.takeSummary() }),
	);
	delete process.env.npm_config_https_proxy;
	delete process.env.npm_config_no_proxy;
	await proxy.stop();

	await step(
		'switch to develop',
		async () => await owner.patch('/source-control/preferences').send({ branchName: 'develop' }),
	);
	await step('the work folder on develop', async () => ({
		status: 0,
		body: workFolder(),
	}));
	await step(
		'switch to a missing branch',
		async () => await owner.patch('/source-control/preferences').send({ branchName: 'missing' }),
	);
	await step(
		'preferences after the missing branch',
		async () => await owner.get('/source-control/preferences'),
	);
	await step(
		'change the color',
		async () => await owner.patch('/source-control/preferences').send({ branchColor: '#00ff00' }),
	);
	await step(
		'change to an invalid color',
		async () => await owner.patch('/source-control/preferences').send({ branchColor: 'green' }),
	);
	await step(
		'change the repository URL with a patch',
		async () =>
			await owner
				.patch('/source-control/preferences')
				.send({ repositoryUrl: `${server.origin}/owner/other.git` }),
	);
	await step(
		'admin: change the color',
		async () =>
			await agents.admin.patch('/source-control/preferences').send({ branchColor: '#0000ff' }),
	);
	await step(
		'member: change the color',
		async () =>
			await agents.member.patch('/source-control/preferences').send({ branchColor: '#ff00ff' }),
	);
	await step(
		'switch back to main',
		async () => await owner.patch('/source-control/preferences').send({ branchName: 'main' }),
	);

	// The protected instance.
	await step(
		'protect the instance',
		async () => await owner.patch('/source-control/preferences').send({ branchReadOnly: true }),
	);
	await step('the write access flag when protected', async () => ({
		status: 0,
		body: { readOnly: Container.get(InstanceWriteAccessService).isReadOnly() },
	}));
	await step(
		'create a data table when protected',
		async () =>
			await owner
				.post(`/projects/${projectId}/data-tables`)
				.send({ name: 'Protected table', columns: [{ name: 'name', type: 'string' }] }),
	);
	await step(
		'create a workflow when protected',
		async () =>
			await owner
				.post('/workflows')
				.send({ name: 'Protected workflow', nodes: [], connections: {} }),
	);
	await step('settings rows when protected', async () => ({
		status: 0,
		body: await settingsRows(),
	}));
	await step(
		'unprotect the instance',
		async () => await owner.patch('/source-control/preferences').send({ branchReadOnly: false }),
	);
	await step('the write access flag when not protected', async () => ({
		status: 0,
		body: { readOnly: Container.get(InstanceWriteAccessService).isReadOnly() },
	}));

	// The other routes as each user.
	for (const who of ['owner', 'admin', 'member', 'projAdmin'] as const) {
		const agent = agents[who];
		await step(
			`${who}: get status for push`,
			async () =>
				await agent
					.get('/source-control/get-status')
					.query({ direction: 'push', preferLocalVersion: true, verbose: false }),
		);
		await step(
			`${who}: get status for pull`,
			async () =>
				await agent
					.get('/source-control/get-status')
					.query({ direction: 'pull', preferLocalVersion: false, verbose: false }),
		);
		await step(
			`${who}: verbose status`,
			async () =>
				await agent
					.get('/source-control/get-status')
					.query({ direction: 'push', preferLocalVersion: true, verbose: true }),
		);
		await step(`${who}: status`, async () => await agent.get('/source-control/status'));
		await step(
			`${who}: remote content of a missing workflow`,
			async () => await agent.get('/source-control/remote-content/workflow/missing'),
		);
		await step(
			`${who}: push nothing`,
			async () =>
				await agent
					.post('/source-control/push-workfolder')
					.send({ commitMessage: 'Nothing', fileNames: [] }),
		);
		await step(
			`${who}: pull`,
			async () => await agent.post('/source-control/pull-workfolder').send({ force: false }),
		);
		await step(
			`${who}: generate a key pair`,
			async () =>
				await agent.post('/source-control/generate-key-pair').send({ keyGeneratorType: 'ed25519' }),
		);
		await step(
			`${who}: reset the work folder`,
			async () => await agent.get('/source-control/reset-workfolder'),
		);
	}
	await step(
		'status with an invalid direction',
		async () => await owner.get('/source-control/get-status').query({ direction: 'sideways' }),
	);
	await step(
		'remote content of an unknown type',
		async () => await owner.get('/source-control/remote-content/credential/missing'),
	);

	// Without the licence.
	testServer.license.disable('feat:sourceControl');
	await step(
		'no licence: get preferences',
		async () => await owner.get('/source-control/preferences'),
	);
	await step(
		'no licence: get branches',
		async () => await owner.get('/source-control/get-branches'),
	);
	await step(
		'no licence: status',
		async () => await owner.get('/source-control/get-status').query({ direction: 'push' }),
	);
	await step(
		'no licence: pull',
		async () => await owner.post('/source-control/pull-workfolder').send({ force: false }),
	);
	await step(
		'no licence: disconnect',
		async () => await owner.post('/source-control/disconnect').send({ keepKeyPair: true }),
	);
	testServer.license.enable('feat:sourceControl');

	// Disconnect.
	await step(
		'member: disconnect',
		async () => await agents.member.post('/source-control/disconnect').send({ keepKeyPair: true }),
	);
	await step(
		'disconnect and keep the key pair',
		async () => await owner.post('/source-control/disconnect').send({ keepKeyPair: true }),
	);
	await step(
		'preferences after the disconnection',
		async () => await owner.get('/source-control/preferences'),
	);
	await step('the work folder after the disconnection', async () => ({
		status: 0,
		body: workFolder(),
	}));
	await step('settings rows after the disconnection', async () => ({
		status: 0,
		body: await settingsRows(),
	}));
	await step(
		'get branches when not connected',
		async () => await owner.get('/source-control/get-branches'),
	);
	await step(
		'connect over HTTPS again',
		async () =>
			await owner
				.post('/source-control/preferences')
				.send({ repositoryUrl: repositoryUrl(), connectionType: 'https', ...credentials }),
	);
	await step(
		'disconnect without the key pair',
		async () => await owner.post('/source-control/disconnect').send({ keepKeyPair: false }),
	);
	await step(
		'preferences after the second disconnection',
		async () => await owner.get('/source-control/preferences'),
	);
	await step('settings rows at the end', async () => ({ status: 0, body: await settingsRows() }));

	expect(transcript).toMatchSnapshot();
});
