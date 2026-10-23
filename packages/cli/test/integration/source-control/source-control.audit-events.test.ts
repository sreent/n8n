// Fork test (not in upstream n8n): the audit events of source control (`ForkGovernanceEventRelay`).
// It connects to a local Git server over HTTPS, pushes, pulls, changes the preferences and
// disconnects, and checks the audit event of each step. See
// `packages/cli/src/modules/source-control/README.md`.
import { createWorkflow, mockInstance } from '@n8n/backend-test-utils';
import { EventService } from '@n8n/backend-services';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { createOwner } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { LocalGitHttpServer } from './git-http-server';
import { LocalGitRemote } from './git-remote';

// Git must reach the local server directly, as in the golden tests of this folder.
for (const name of Object.keys(process.env)) {
	if (/proxy/i.test(name)) delete process.env[name];
}

mockInstance(ActiveWorkflowManager);

const remote = new LocalGitRemote();
remote.install();
const server = new LocalGitHttpServer(remote.repos);

const testServer = utils.setupTestServer({
	endpointGroups: ['sourceControl', 'workflows'],
	enabledFeatures: ['feat:sourceControl', 'feat:sharing'],
	modules: ['source-control'],
});

const AUDIT_EVENTS = new Set([
	'source-control-settings-saved',
	'source-control-disconnected',
	'source-control-pushed',
	'source-control-pulled',
]);

let events: Array<{ name: string; payload: unknown }> = [];
let owner: User;
let agent: SuperAgentTest;

/** The payloads of one audit event since the last call, with the id of the user. */
function take(name: string): Array<Record<string, unknown>> {
	const taken = events
		.filter((event) => event.name === name)
		.map(({ payload }) => {
			const { user, ...rest } = payload as { user: User } & Record<string, unknown>;
			return { userId: user.id, ...rest };
		});
	events = [];
	return taken;
}

beforeAll(async () => {
	await server.start();
	process.env.GIT_SSL_CAINFO = server.certFile;
	// A direct hook: the test setup restores the spies of `vi.spyOn` before each test.
	const eventService = Container.get(EventService);
	const emit = eventService.emit.bind(eventService);
	eventService.emit = ((name: string, ...rest: unknown[]) => {
		if (AUDIT_EVENTS.has(name)) events.push({ name, payload: rest[0] });
		return emit(name as never, ...(rest as never[]));
	}) as typeof eventService.emit;

	owner = await createOwner();
	agent = testServer.authAgentFor(owner);
	remote.createRepo('owner', 'repo');
	remote.seed('owner', 'repo', 'main', { 'README.md': '# n8n\n' }, 'Initial commit');
});

afterAll(async () => {
	remote.uninstall();
	await server.stop();
});

test('each action of source control sends its audit event', { timeout: 120_000 }, async () => {
	const repositoryUrl = `${server.origin}/owner/repo.git`;

	await agent
		.post('/source-control/preferences')
		.send({
			repositoryUrl,
			connectionType: 'https',
			httpsUsername: 'git-user',
			httpsPassword: 'git-token',
		})
		.expect(200);
	expect(take('source-control-settings-saved')).toEqual([
		{
			userId: owner.id,
			repositoryUrl,
			branchName: 'main',
			branchReadOnly: false,
			connectionType: 'https',
			connected: true,
			isNew: true,
		},
	]);

	await createWorkflow({ name: 'Audited workflow' }, owner);
	await agent
		.post('/source-control/push-workfolder')
		.send({ commitMessage: 'Audit', fileNames: [] })
		.expect(200);
	const [pushed] = take('source-control-pushed');
	expect(pushed).toEqual({
		userId: owner.id,
		repositoryUrl,
		branchName: 'main',
		commit: expect.any(String),
		changedFiles: expect.any(Number),
		forced: false,
		publicApi: false,
	});
	expect(pushed.changedFiles).toBeGreaterThan(0);

	await agent.post('/source-control/pull-workfolder').send({ force: true }).expect(200);
	expect(take('source-control-pulled')).toEqual([
		{
			userId: owner.id,
			repositoryUrl,
			branchName: 'main',
			changedFiles: expect.any(Number),
			forced: true,
			publicApi: false,
		},
	]);

	await agent.patch('/source-control/preferences').send({ branchReadOnly: true }).expect(200);
	expect(take('source-control-settings-saved')).toEqual([
		expect.objectContaining({ userId: owner.id, branchReadOnly: true, isNew: false }),
	]);

	await agent.post('/source-control/disconnect').send({}).expect(200);
	expect(take('source-control-disconnected')).toEqual([{ userId: owner.id, repositoryUrl }]);
});
