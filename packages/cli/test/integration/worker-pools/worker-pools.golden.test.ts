// Fork test (not in upstream n8n): the worker pools as a black box. The test calls the REST
// routes of the pool settings of a project (`/projects/:projectId/pool-settings`) as several
// users, with the pools on and off and with and without the licence, and resolves the queue of
// executions. It records the answers, the rows that each step changes, the calls to the cache and
// to the instance registry, and the queue of each execution. The snapshot was recorded against
// the enterprise files, and the fork files give the same snapshot. See
// `packages/cli/src/scaling/FORK.md`.
import { createTeamProject, getPersonalProject, linkUserToProject } from '@n8n/backend-test-utils';
import { CacheService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import type { Project, User } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type { IWorkflowExecutionDataProcess } from 'n8n-workflow';

import { InstanceRegistryService } from '@/modules/instance-registry/instance-registry.service';
import { createMember, createOwner } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { PoolConfigService } from './subject';

const testServer = utils.setupTestServer({
	endpointGroups: ['project'],
	enabledFeatures: [
		'feat:workerPools',
		'feat:projectRole:admin',
		'feat:projectRole:editor',
		'feat:projectRole:viewer',
	],
	quotas: { 'quota:maxTeamProjects': -1 },
});

const rec = new GoldenRecorder();

// #region Fakes

let calls: unknown[][] = [];

const record = (...entry: unknown[]) => calls.push(entry.map((value) => rec.normalize(value)));

type Registration = { hostId: string; instanceType: string; poolName?: string };

let registry: { instances: Registration[]; failure?: string } = { instances: [] };

/** The instance registry that the server injected: answers from `registry`, and records each call. */
function spyOnRegistry() {
	const service = Container.get(InstanceRegistryService);
	vi.spyOn(service, 'getAllInstances').mockImplementation(async () => {
		record('instanceRegistry', 'getAllInstances');
		if (registry.failure) throw new Error(registry.failure);
		return registry.instances.map((instance) => ({
			schemaVersion: 1 as const,
			instanceKey: `key-${instance.hostId}`,
			instanceRole: 'unset' as const,
			version: '1.0.0',
			registeredAt: 1,
			lastSeen: 2,
			...instance,
			instanceType: instance.instanceType as 'main' | 'worker',
		}));
	});
}

function spyOnCache() {
	const cache = Container.get(CacheService);
	for (const method of [
		'get',
		'getMany',
		'set',
		'setMany',
		'delete',
		'deleteMany',
		'exists',
		'take',
		'getHash',
		'getHashValue',
		'setHash',
		'deleteFromHash',
		'expire',
	] as const) {
		const original = cache[method].bind(cache) as (...args: unknown[]) => Promise<unknown>;
		vi.spyOn(cache, method).mockImplementation((async (...args: unknown[]) => {
			const result = await original(...args);
			// Other services also use the cache. Only the keys of the pools belong to this test.
			if (typeof args[0] !== 'string' || !args[0].startsWith('projectPool:')) return result;
			record(
				'cache',
				method,
				...args.map((arg) => (typeof arg === 'object' && arg !== null ? Object.keys(arg) : arg)),
				{ result },
			);
			return result;
		}) as never);
	}
}

// #endregion

let owner: User;
let viewer: User;
let editor: User;
let outsider: User;
let teamA: Project;
let teamB: Project;
let personal: Project;
const agents: Record<string, SuperAgentTest> = {};

beforeAll(async () => {
	owner = await createOwner();
	viewer = await createMember();
	editor = await createMember();
	outsider = await createMember();
	rec.label(owner.id, 'owner');
	rec.label(viewer.id, 'viewer');
	rec.label(editor.id, 'editor');
	rec.label(outsider.id, 'outsider');
	teamA = await createTeamProject('Team A', owner);
	teamB = await createTeamProject('Team B', owner);
	personal = await getPersonalProject(owner);
	rec.label(teamA.id, 'Team A');
	rec.label(teamB.id, 'Team B');
	rec.label(personal.id, 'personal owner');
	for (const user of [viewer, editor, outsider]) {
		rec.label((await getPersonalProject(user)).id, `personal ${rec.labelString(user.id)}`);
		rec.label(
			`${user.firstName} ${user.lastName} <${user.email}>`,
			`name ${rec.labelString(user.id)}`,
		);
	}
	rec.label(`${owner.firstName} ${owner.lastName} <${owner.email}>`, 'name owner');
	await linkUserToProject(viewer, teamA, 'project:viewer');
	await linkUserToProject(editor, teamA, 'project:editor');
	agents.owner = testServer.authAgentFor(owner);
	agents.viewer = testServer.authAgentFor(viewer);
	agents.editor = testServer.authAgentFor(editor);
	agents.outsider = testServer.authAgentFor(outsider);
});

beforeEach(() => {
	spyOnCache();
	spyOnRegistry();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const transcript: Array<Record<string, unknown>> = [];

async function step(name: string, action: () => Promise<unknown>) {
	const before = await rec.dumpDb();
	calls = [];
	let outcome: unknown;
	try {
		outcome = rec.normalize(await action());
	} catch (error) {
		outcome = { threw: rec.describeError(error) };
	}
	const changes = rec.diffDumps(before, await rec.dumpDb());
	transcript.push({ step: name, outcome, changes, calls });
}

const request = async (who: string, method: 'get' | 'patch', projectId: string, body?: unknown) => {
	let call = agents[who][method](`/projects/${projectId}/pool-settings`);
	if (body !== undefined) call = call.send(body as object);
	const response = await call;
	return { status: response.status, body: response.body as unknown };
};

const resolve = async (data: Partial<IWorkflowExecutionDataProcess>) =>
	await Container.get(PoolConfigService).resolvePoolForExecution(
		data as IWorkflowExecutionDataProcess,
	);

const setPools = (enabled: boolean) => {
	Container.get(GlobalConfig).queue.workerPool.enabled = enabled;
};

test('the worker pools', async () => {
	setPools(true);
	registry = {
		instances: [
			{ hostId: 'main-a', instanceType: 'main' },
			{ hostId: 'worker-1', instanceType: 'worker', poolName: 'gpu' },
			{ hostId: 'worker-2', instanceType: 'worker', poolName: 'gpu' },
			{ hostId: 'worker-3', instanceType: 'worker', poolName: 'cpu' },
			{ hostId: 'worker-4', instanceType: 'worker', poolName: '' },
			{ hostId: 'worker-5', instanceType: 'worker' },
			{ hostId: 'worker-6', instanceType: 'worker', poolName: 'big-mem' },
		],
	};

	// #region The settings of a project
	await step(
		'the settings of a project without a pool',
		async () => await request('owner', 'get', teamA.id),
	);
	await step(
		'choose a pool',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'gpu' }),
	);
	await step('the settings with a pool', async () => await request('owner', 'get', teamA.id));
	await step(
		'choose another pool',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'cpu' }),
	);
	await step(
		'choose the same pool again',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'cpu' }),
	);
	await step(
		'clear the pool with an empty name',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: '' }),
	);
	await step('the settings after the clear', async () => await request('owner', 'get', teamA.id));
	await step(
		'choose a pool that no worker has',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'not-registered' }),
	);
	await step(
		'clear the pool with null',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: null }),
	);
	await step(
		'a name with capitals',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'GPU' }),
	);
	await step(
		'a name with a space',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'gpu pool' }),
	);
	await step(
		'a name that starts with a hyphen',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: '-gpu' }),
	);
	await step(
		'a name of 63 characters',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'a'.repeat(63) }),
	);
	await step(
		'a name of 64 characters',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'a'.repeat(64) }),
	);
	await step('a body without the pool', async () => await request('owner', 'patch', teamA.id, {}));
	await step(
		'a pool that is a number',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 7 }),
	);
	await step(
		'extra fields',
		async () => await request('owner', 'patch', teamA.id, { defaultPool: 'gpu', other: true }),
	);
	// #endregion

	// #region Users and projects
	await step('a viewer reads the settings', async () => await request('viewer', 'get', teamA.id));
	await step(
		'a viewer changes the pool',
		async () => await request('viewer', 'patch', teamA.id, { defaultPool: 'cpu' }),
	);
	await step('an editor reads the settings', async () => await request('editor', 'get', teamA.id));
	await step(
		'an editor changes the pool',
		async () => await request('editor', 'patch', teamA.id, { defaultPool: 'cpu' }),
	);
	await step(
		'a user outside the project reads the settings',
		async () => await request('outsider', 'get', teamA.id),
	);
	await step(
		'a user outside the project changes the pool',
		async () => await request('outsider', 'patch', teamA.id, { defaultPool: 'cpu' }),
	);
	await step('an unknown project', async () => await request('owner', 'get', 'unknownProject0001'));
	await step(
		'a pool for an unknown project',
		async () => await request('owner', 'patch', 'unknownProject0001', { defaultPool: 'gpu' }),
	);
	await step('a personal project', async () => await request('owner', 'get', personal.id));
	await step(
		'a pool for a personal project',
		async () => await request('owner', 'patch', personal.id, { defaultPool: 'big-mem' }),
	);
	await step(
		'a pool for a second team project',
		async () => await request('owner', 'patch', teamB.id, { defaultPool: 'gpu' }),
	);
	// #endregion

	// #region The queue of an execution
	await step(
		'an execution of a project with a pool',
		async () => await resolve({ projectId: teamA.id }),
	);
	await step('the same execution again', async () => await resolve({ projectId: teamA.id }));
	await step(
		'an execution of a project of a personal space',
		async () => await resolve({ projectId: personal.id }),
	);
	await step('an execution without a project', async () => await resolve({}));
	await step(
		'an execution of an unknown project',
		async () => await resolve({ projectId: 'unknownProject0001' }),
	);
	await step('a pool that no worker has', async () => {
		await request('owner', 'patch', teamB.id, { defaultPool: 'not-registered' });
		return await resolve({ projectId: teamB.id });
	});
	await step('a change of the row without the service', async () => {
		await Container.get(ProjectRepository).manager.query(
			'UPDATE project_pool_settings SET "defaultPool" = ? WHERE "projectId" = ?',
			['cpu', teamA.id],
		);
		return await resolve({ projectId: teamA.id });
	});
	await step('a change of the pool through the routes', async () => {
		await request('owner', 'patch', teamA.id, { defaultPool: 'big-mem' });
		return await resolve({ projectId: teamA.id });
	});
	await step('a cleared pool', async () => {
		await request('owner', 'patch', teamA.id, { defaultPool: null });
		return await resolve({ projectId: teamA.id });
	});
	await step('a deleted project', async () => {
		const project = await createTeamProject('Team C', owner);
		rec.label(project.id, 'Team C');
		await request('owner', 'patch', project.id, { defaultPool: 'gpu' });
		await resolve({ projectId: project.id });
		await Container.get(ProjectRepository).delete(project.id);
		return await resolve({ projectId: project.id });
	});
	// #endregion

	// #region Pools off, no licence, a failing registry
	setPools(false);
	await step(
		'the settings while pools are off',
		async () => await request('owner', 'get', teamB.id),
	);
	await step(
		'a change while pools are off',
		async () => await request('owner', 'patch', teamB.id, { defaultPool: 'gpu' }),
	);
	await step(
		'an execution while pools are off',
		async () => await resolve({ projectId: teamB.id }),
	);
	setPools(true);

	testServer.license.disable('feat:workerPools');
	await step('the settings without a licence', async () => await request('owner', 'get', teamB.id));
	await step(
		'a change without a licence',
		async () => await request('owner', 'patch', teamB.id, { defaultPool: 'cpu' }),
	);
	await step('an execution without a licence', async () => await resolve({ projectId: teamB.id }));
	testServer.license.enable('feat:workerPools');

	registry = { ...registry, failure: 'Redis is down' };
	await step(
		'the settings with a failing registry',
		async () => await request('owner', 'get', teamB.id),
	);
	await step(
		'a change with a failing registry',
		async () => await request('owner', 'patch', teamB.id, { defaultPool: 'cpu' }),
	);
	await step(
		'an execution with a failing registry',
		async () => await resolve({ projectId: teamB.id }),
	);
	registry = { instances: [] };
	await step('the settings without workers', async () => await request('owner', 'get', teamB.id));
	// #endregion

	expect(transcript).toMatchSnapshot();
}, 120_000);
