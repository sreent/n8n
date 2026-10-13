import {
	createTeamProject,
	getPersonalProject,
	linkUserToProject,
	testDb,
} from '@n8n/backend-test-utils';
import type { Project, User } from '@n8n/db';
import { generateNanoId, VariablesRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type { MockInstance } from 'vitest';

import { VariablesService } from '@/environments/variables/variables.service';
import { EventService } from '@n8n/backend-services';

import { createAdmin, createMember, createOwner } from './shared/db/users';
import type { SuperAgentTest } from './shared/types';
import * as utils from './shared/utils/';

/**
 * Fork test (not in upstream n8n): the REST API of variables and the variables service that
 * ordinary code calls. The snapshots record the behaviour of the original code as a black box.
 * See `packages/cli/src/environments/variables/FORK.md`.
 */
const testServer = utils.setupTestServer({ endpointGroups: ['variables'] });

const FEATURE = 'feat:variables';
const QUOTA = 'quota:maxVariables';

let owner: User;
let admin: User;
let member: User;
let projectAdmin: User;
let projectEditor: User;
let projectViewer: User;
let projectA: Project;
let projectB: Project;
let agents: Record<string, SuperAgentTest>;
let labels: Map<string, string>;
let emit: MockInstance<EventService['emit']>;

beforeAll(async () => {
	owner = await createOwner();
	admin = await createAdmin();
	member = await createMember();
	projectAdmin = await createMember();
	projectEditor = await createMember();
	projectViewer = await createMember();
	projectA = await createTeamProject('Project A');
	projectB = await createTeamProject('Project B');
	await linkUserToProject(projectAdmin, projectA, 'project:admin');
	await linkUserToProject(projectEditor, projectA, 'project:editor');
	await linkUserToProject(projectViewer, projectA, 'project:viewer');

	agents = {
		owner: testServer.authAgentFor(owner),
		admin: testServer.authAgentFor(admin),
		member: testServer.authAgentFor(member),
		projectAdmin: testServer.authAgentFor(projectAdmin),
		projectEditor: testServer.authAgentFor(projectEditor),
		projectViewer: testServer.authAgentFor(projectViewer),
	};
});

afterEach(() => {
	emit.mockRestore();
});

beforeEach(async () => {
	testServer.license.reset();
	await testDb.truncate(['Variables']);
	await Container.get(VariablesService).updateCache();
	emit = vi.spyOn(Container.get(EventService), 'emit');
	labels = new Map<string, string>([
		[owner.id, '<owner>'],
		[admin.id, '<admin>'],
		[member.id, '<member>'],
		[projectAdmin.id, '<project admin>'],
		[projectEditor.id, '<project editor>'],
		[projectViewer.id, '<project viewer>'],
		[projectA.id, '<project A>'],
		[projectB.id, '<project B>'],
	]);
	for (const [user, name] of [
		[owner, 'owner'],
		[member, 'member'],
		[projectViewer, 'project viewer'],
	] as const) {
		labels.set((await getPersonalProject(user)).id, `<personal project of ${name}>`);
	}
	// A personal project has the random name and email of its user as its name.
	for (const [user, name] of [
		[owner, 'owner'],
		[admin, 'admin'],
		[member, 'member'],
		[projectAdmin, 'project admin'],
		[projectEditor, 'project editor'],
		[projectViewer, 'project viewer'],
	] as const) {
		labels.set(`${user.firstName} ${user.lastName} <${user.email}>`, `<name of ${name}>`);
	}
});

/** Gives a stable label to each ID that the test did not name. */
function label(id: string) {
	if (!labels.has(id)) labels.set(id, `<id ${labels.size + 1} (${id.length} chars)>`);
	return labels.get(id);
}

/** Replaces IDs and timestamps, so that a snapshot is stable. */
function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value instanceof Date) return '<date>';
	if (typeof value === 'string') {
		let text = value;
		for (const [id, name] of labels) text = text.split(id).join(name ?? id);
		return text;
	}
	if (value === null || typeof value !== 'object') return value;

	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => {
			if ((key === 'id' || key.endsWith('Id')) && typeof entry === 'string') {
				return [key, label(entry)];
			}
			if ((key === 'createdAt' || key === 'updatedAt') && entry !== null) return [key, '<date>'];
			if (key === 'user' && entry !== null && typeof entry === 'object' && 'id' in entry) {
				return [key, label(String(entry.id))];
			}
			return [key, normalize(entry)];
		}),
	);
}

function byKey(items: unknown): unknown {
	if (!Array.isArray(items)) return items;
	const key = (item: unknown) =>
		item !== null && typeof item === 'object' && 'key' in item ? String(item.key) : '';
	const project = (item: unknown) =>
		item !== null && typeof item === 'object' && 'project' in item && item.project
			? JSON.stringify(normalize(item.project))
			: '';
	return [...items].sort(
		(a, b) => key(a).localeCompare(key(b)) || project(a).localeCompare(project(b)),
	);
}

async function call(request: Promise<{ status: number; body: unknown }>) {
	const response = await request;
	const body =
		response.body !== null && typeof response.body === 'object' && 'data' in response.body
			? { ...response.body, data: byKey(response.body.data) }
			: response.body;
	return { status: response.status, body: normalize(body) };
}

/** Runs a call, and records its result or the class and the message of its error. */
async function outcome(run: () => Promise<unknown>) {
	try {
		return { result: normalize(byKey(await run())) };
	} catch (error) {
		return error instanceof Error
			? { error: error.constructor.name, message: normalize(error.message) }
			: { error: String(error) };
	}
}

async function cache() {
	return normalize(byKey(await Container.get(VariablesService).getAllCached()));
}

/** The variable events since the last call. */
function takeEvents() {
	const taken = emit.mock.calls
		.filter(([name]) => name.startsWith('variable-'))
		.map(([name, payload]) => [name, normalize(payload)]);
	emit.mockClear();
	return taken;
}

async function seed() {
	const repository = Container.get(VariablesRepository);
	const save = async (key: string, value: string, project?: Project) =>
		await repository.save({ id: generateNanoId(), key, value, project: project ?? null });
	const variables = {
		global: await save('GLOBAL', 'global value'),
		empty: await save('EMPTY', ''),
		shared: await save('SHARED', 'global shared'),
		inA: await save('IN_A', 'value in A', projectA),
		sharedInA: await save('SHARED', 'shared in A', projectA),
		inB: await save('IN_B', 'value in B', projectB),
	};
	await Container.get(VariablesService).updateCache();
	for (const [name, variable] of Object.entries(variables)) labels.set(variable.id, `<${name}>`);
	return variables;
}

describe('without the licence feature', () => {
	test('answers each route', async () => {
		const { global } = await seed();

		const responses = {
			list: await call(agents.owner.get('/variables')),
			get: await call(agents.owner.get(`/variables/${global.id}`)),
			create: await call(agents.owner.post('/variables').send({ key: 'NEW', value: 'new' })),
			update: await call(agents.owner.patch(`/variables/${global.id}`).send({ value: 'changed' })),
			delete: await call(agents.owner.delete(`/variables/${global.id}`)),
			events: takeEvents(),
			cache: await cache(),
		};

		expect(responses).toMatchSnapshot();
	});
});

describe('with the licence feature', () => {
	beforeEach(() => {
		testServer.license.enable(FEATURE);
	});

	test('creates variables, and checks the input', async () => {
		const results: Record<string, unknown> = {};
		const create = async (body: object) => await call(agents.owner.post('/variables').send(body));

		results.global = await create({ key: 'GOOD', value: 'good value' });
		results.withType = await create({ key: 'TYPED', value: 'typed', type: 'string' });
		results.emptyValue = await create({ key: 'EMPTY_VALUE', value: '' });
		results.inProject = await create({ key: 'IN_A', value: 'in A', projectId: projectA.id });
		results.sameKeyInProject = await create({ key: 'GOOD', value: 'in A', projectId: projectA.id });
		results.eventsOfCreates = takeEvents();
		results.duplicateGlobal = await create({ key: 'GOOD', value: 'again' });
		results.duplicateInProject = await create({
			key: 'IN_A',
			value: 'again',
			projectId: projectA.id,
		});
		results.globalKeyOfProjectVariable = await create({ key: 'IN_A', value: 'global' });
		results.invalidCharacter = await create({ key: 'BAD$KEY', value: 'x' });
		results.startsWithNumber = await create({ key: '1KEY', value: 'x' });
		results.longKey = await create({ key: 'K'.repeat(51), value: 'x' });
		results.maxKey = await create({ key: 'M'.repeat(50), value: 'x' });
		results.emptyKey = await create({ key: '', value: 'x' });
		results.missingKey = await create({ value: 'x' });
		results.missingValue = await create({ key: 'NO_VALUE' });
		results.longValue = await create({ key: 'LONG_VALUE', value: 'v'.repeat(1001) });
		results.maxValue = await create({ key: 'MAX_VALUE', value: 'v'.repeat(1000) });
		results.otherType = await create({ key: 'NUMBER', value: '1', type: 'number' });
		results.unknownProject = await create({ key: 'UNKNOWN', value: 'x', projectId: 'unknown' });
		results.personalProject = await create({
			key: 'PERSONAL',
			value: 'x',
			projectId: (await getPersonalProject(owner)).id,
		});
		results.longProjectId = await create({ key: 'LONG_ID', value: 'x', projectId: 'p'.repeat(37) });
		results.nullProjectId = await create({ key: 'NULL_ID', value: 'x', projectId: null });
		results.events = takeEvents();
		results.cache = await cache();

		expect(results).toMatchSnapshot();
	});

	test('lists and reads variables', async () => {
		const { global, empty, inA, inB } = await seed();
		const results: Record<string, unknown> = {};

		for (const [name, agent] of Object.entries(agents)) {
			results[name] = {
				list: await call(agent.get('/variables')),
				listEmpty: await call(agent.get('/variables?state=empty')),
				listInA: await call(agent.get(`/variables?projectId=${projectA.id}`)),
				listInB: await call(agent.get(`/variables?projectId=${projectB.id}`)),
				getGlobal: await call(agent.get(`/variables/${global.id}`)),
				getEmpty: await call(agent.get(`/variables/${empty.id}`)),
				getInA: await call(agent.get(`/variables/${inA.id}`)),
				getInB: await call(agent.get(`/variables/${inB.id}`)),
				getUnknown: await call(agent.get('/variables/unknown')),
			};
		}
		results.listUnknownProject = await call(agents.owner.get('/variables?projectId=unknown'));
		results.listNullProject = await call(agents.owner.get('/variables?projectId=null'));
		results.listOtherState = await call(agents.owner.get('/variables?state=full'));
		results.events = takeEvents();

		expect(results).toMatchSnapshot();
	});

	test('updates variables, and checks the input', async () => {
		const { global, empty, inA } = await seed();
		const results: Record<string, unknown> = {};
		const update = async (id: string, body: object) =>
			await call(agents.owner.patch(`/variables/${id}`).send(body));

		results.value = await update(global.id, { value: 'new global value' });
		results.key = await update(global.id, { key: 'RENAMED' });
		results.keyStartsWithNumber = await update(global.id, { key: '1RENAMED' });
		results.keyAndValue = await update(empty.id, { key: 'FILLED', value: 'filled' });
		results.nothing = await update(empty.id, {});
		results.toProject = await update(global.id, { projectId: projectA.id });
		results.toGlobal = await update(global.id, { projectId: null });
		results.toOtherProject = await update(inA.id, { projectId: projectB.id });
		results.eventsOfUpdates = takeEvents();
		results.duplicateGlobalKey = await update(global.id, { key: 'SHARED' });
		results.duplicateKeyInProject = await update(inA.id, { key: 'SHARED', projectId: projectA.id });
		results.toProjectWithSameKey = await update(empty.id, {
			key: 'SHARED',
			projectId: projectA.id,
		});
		results.invalidKey = await update(global.id, { key: 'BAD-KEY' });
		results.longValue = await update(global.id, { value: 'v'.repeat(1001) });
		results.otherType = await update(global.id, { type: 'number' });
		results.unknownProject = await update(global.id, { projectId: 'unknown' });
		results.unknownVariable = await update('unknown', { value: 'x' });
		results.events = takeEvents();
		results.cache = await cache();

		expect(results).toMatchSnapshot();
	});

	test('deletes variables', async () => {
		const { global, inA } = await seed();

		const results = {
			global: await call(agents.owner.delete(`/variables/${global.id}`)),
			inProject: await call(agents.owner.delete(`/variables/${inA.id}`)),
			again: await call(agents.owner.delete(`/variables/${global.id}`)),
			unknown: await call(agents.owner.delete('/variables/unknown')),
			events: takeEvents(),
			cache: await cache(),
		};

		expect(results).toMatchSnapshot();
	});

	test('lets each role create, update and delete', async () => {
		const results: Record<string, unknown> = {};

		for (const [name, agent] of Object.entries(agents)) {
			await testDb.truncate(['Variables']);
			const { global, inA, inB } = await seed();
			results[name] = {
				createGlobal: await call(agent.post('/variables').send({ key: 'NEW', value: 'x' })),
				createInA: await call(
					agent.post('/variables').send({ key: 'NEW_A', value: 'x', projectId: projectA.id }),
				),
				createInB: await call(
					agent.post('/variables').send({ key: 'NEW_B', value: 'x', projectId: projectB.id }),
				),
				updateGlobal: await call(agent.patch(`/variables/${global.id}`).send({ value: 'y' })),
				updateInA: await call(agent.patch(`/variables/${inA.id}`).send({ value: 'y' })),
				updateInB: await call(agent.patch(`/variables/${inB.id}`).send({ value: 'y' })),
				moveInAToGlobal: await call(agent.patch(`/variables/${inA.id}`).send({ projectId: null })),
				moveGlobalToA: await call(
					agent.patch(`/variables/${global.id}`).send({ projectId: projectA.id }),
				),
				deleteGlobal: await call(agent.delete(`/variables/${global.id}`)),
				deleteInA: await call(agent.delete(`/variables/${inA.id}`)),
				deleteInB: await call(agent.delete(`/variables/${inB.id}`)),
				events: takeEvents(),
				cache: await cache(),
			};
		}

		expect(results).toMatchSnapshot();
	});

	test('counts the variables against the quota', async () => {
		const service = Container.get(VariablesService);
		const results: Record<string, unknown> = {};

		results.unlimited = await outcome(async () => await service.getRemainingVariableQuota());
		testServer.license.setQuota(QUOTA, 3);
		results.emptyQuota = await outcome(async () => await service.getRemainingVariableQuota());
		results.first = await call(agents.owner.post('/variables').send({ key: 'FIRST', value: 'x' }));
		results.second = await call(
			agents.owner.post('/variables').send({ key: 'SECOND', value: 'x', projectId: projectA.id }),
		);
		results.afterTwo = await outcome(async () => await service.getRemainingVariableQuota());
		results.third = await call(agents.owner.post('/variables').send({ key: 'THIRD', value: 'x' }));
		results.fourth = await call(
			agents.owner.post('/variables').send({ key: 'FOURTH', value: 'x' }),
		);
		results.fourthInProject = await call(
			agents.owner.post('/variables').send({ key: 'FOURTH', value: 'x', projectId: projectA.id }),
		);
		results.full = await outcome(async () => await service.getRemainingVariableQuota());
		const first = await Container.get(VariablesRepository).findOneByOrFail({ key: 'FIRST' });
		results.updateWhenFull = await call(
			agents.owner.patch(`/variables/${first.id}`).send({ value: 'y' }),
		);
		testServer.license.setQuota(QUOTA, 2);
		results.overQuota = await outcome(async () => await service.getRemainingVariableQuota());
		testServer.license.setQuota(QUOTA, 0);
		results.zeroQuota = await outcome(async () => await service.getRemainingVariableQuota());
		results.createWithZero = await call(
			agents.owner.post('/variables').send({ key: 'ZERO', value: 'x' }),
		);
		results.events = takeEvents();

		expect(results).toMatchSnapshot();
	});
});

describe('edge cases', () => {
	beforeEach(() => {
		testServer.license.enable(FEATURE);
	});

	test('deletes unknown variables, and orders the checks', async () => {
		const { global, inA } = await seed();
		const results: Record<string, unknown> = {};

		results.memberDeletesUnknown = await call(agents.member.delete('/variables/unknown'));
		results.projectAdminDeletesUnknown = await call(
			agents.projectAdmin.delete('/variables/unknown'),
		);
		results.memberGetsUnknown = await call(agents.member.get('/variables/unknown'));
		results.memberUpdatesUnknown = await call(
			agents.member.patch('/variables/unknown').send({ value: 'x' }),
		);
		testServer.license.setQuota(QUOTA, 0);
		results.memberCreatesGlobalWithZeroQuota = await call(
			agents.member.post('/variables').send({ key: 'NEW', value: 'x' }),
		);
		results.duplicateWithZeroQuota = await call(
			agents.owner.post('/variables').send({ key: 'GLOBAL', value: 'x' }),
		);
		results.duplicateInProjectWithZeroQuota = await call(
			agents.owner.post('/variables').send({ key: 'IN_A', value: 'x', projectId: projectA.id }),
		);
		results.unknownProjectWithZeroQuota = await call(
			agents.owner.post('/variables').send({ key: 'NEW', value: 'x', projectId: 'unknown' }),
		);
		testServer.license.setQuota(QUOTA, -1);
		results.moveGlobalIntoProjectWithItsKey = await call(
			agents.owner.patch(`/variables/${global.id}`).send({ key: 'IN_A', projectId: projectA.id }),
		);
		results.renameInProjectToGlobalKey = await call(
			agents.owner.patch(`/variables/${inA.id}`).send({ key: 'SHARED' }),
		);
		results.events = takeEvents();

		expect(results).toMatchSnapshot();
	});

	test('keeps an old key that starts with a number, and checks keys in the service', async () => {
		const repository = Container.get(VariablesRepository);
		const old = await repository.save({ id: generateNanoId(), key: '1OLD', value: 'old' });
		labels.set(old.id, '<old>');
		await Container.get(VariablesService).updateCache();
		const service = Container.get(VariablesService);
		const results: Record<string, unknown> = {};

		results.keepKey = await call(
			agents.owner.patch(`/variables/${old.id}`).send({ key: '1OLD', value: 'kept' }),
		);
		results.valueOnly = await call(agents.owner.patch(`/variables/${old.id}`).send({ value: 'v' }));
		results.renameToNumber = await call(
			agents.owner.patch(`/variables/${old.id}`).send({ key: '2NEW' }),
		);
		results.renameToValid = await call(
			agents.owner.patch(`/variables/${old.id}`).send({ key: 'VALID' }),
		);
		results.serviceCreatesInvalidKey = await outcome(
			async () => await service.create(owner, { key: 'BAD-KEY', value: 'x', type: 'string' }),
		);
		results.serviceCreatesNumberKey = await outcome(
			async () => await service.create(owner, { key: '1KEY', value: 'x', type: 'string' }),
		);
		results.serviceCreatesLongKey = await outcome(
			async () => await service.create(owner, { key: 'K'.repeat(51), value: 'x', type: 'string' }),
		);
		results.serviceUpdatesInvalidKey = await outcome(
			async () => await service.update(owner, old.id, { key: 'BAD-KEY' }),
		);
		results.cache = await cache();

		expect(results).toMatchSnapshot();
	});
});

describe('the variables service', () => {
	beforeEach(() => {
		testServer.license.enable(FEATURE);
	});

	test('reads the variables from the cache', async () => {
		const service = Container.get(VariablesService);
		const { global, inA } = await seed();
		const results: Record<string, unknown> = {};

		results.allCached = await outcome(async () => await service.getAllCached());
		results.cachedGlobal = await outcome(async () => await service.getCached(global.id));
		results.cachedInA = await outcome(async () => await service.getCached(inA.id));
		results.cachedUnknown = await outcome(async () => await service.getCached('unknown'));

		const repository = Container.get(VariablesRepository);
		const direct = await repository.save({ id: generateNanoId(), key: 'DIRECT', value: 'direct' });
		labels.set(direct.id, '<direct>');
		results.beforeUpdateCache = await outcome(async () => await service.getAllCached());
		await service.updateCache();
		results.afterUpdateCache = await outcome(async () => await service.getAllCached());
		results.events = takeEvents();

		expect(results).toMatchSnapshot();
	});

	test('lists the variables of a user', async () => {
		const service = Container.get(VariablesService);
		await seed();
		const results: Record<string, unknown> = {};

		for (const [name, user] of Object.entries({
			owner,
			admin,
			member,
			projectAdmin,
			projectEditor,
			projectViewer,
		})) {
			results[name] = {
				all: await outcome(async () => await service.getAllForUser(user)),
				empty: await outcome(async () => await service.getAllForUser(user, { state: 'empty' })),
				inA: await outcome(
					async () => await service.getAllForUser(user, { projectId: projectA.id }),
				),
				global: await outcome(async () => await service.getAllForUser(user, { projectId: null })),
			};
		}

		expect(results).toMatchSnapshot();
	});

	test('creates, updates and deletes variables', async () => {
		const service = Container.get(VariablesService);
		const { global, inA, inB } = await seed();
		const results: Record<string, unknown> = {};

		results.create = await outcome(
			async () => await service.create(owner, { key: 'CREATED', value: 'x', type: 'string' }),
		);
		results.createInA = await outcome(
			async () =>
				await service.create(projectEditor, {
					key: 'CREATED_A',
					value: 'x',
					type: 'string',
					projectId: projectA.id,
				}),
		);
		results.createAsMember = await outcome(
			async () => await service.create(member, { key: 'MEMBER', value: 'x', type: 'string' }),
		);
		results.createDuplicate = await outcome(
			async () => await service.create(owner, { key: 'GLOBAL', value: 'x', type: 'string' }),
		);
		results.update = await outcome(
			async () => await service.update(owner, global.id, { value: 'updated' }),
		);
		results.updateAsViewer = await outcome(
			async () => await service.update(projectViewer, inA.id, { value: 'updated' }),
		);
		results.updateUnknown = await outcome(
			async () => await service.update(owner, 'unknown', { value: 'updated' }),
		);
		results.deleteForUser = await outcome(async () => await service.deleteForUser(owner, inB.id));
		results.deleteAsEditor = await outcome(
			async () => await service.deleteForUser(projectEditor, global.id),
		);
		results.deleteUnknown = await outcome(
			async () => await service.deleteForUser(owner, 'unknown'),
		);
		results.deleteByIds = await outcome(
			async () => await service.deleteByIds([global.id, 'unknown']),
		);
		results.events = takeEvents();
		results.cache = await cache();

		expect(results).toMatchSnapshot();
	});
});
