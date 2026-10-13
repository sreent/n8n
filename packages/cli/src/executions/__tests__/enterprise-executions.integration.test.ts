// The behaviour of `EnterpriseExecutionsService.findOne`, which `GET /executions/:id` uses with the
// sharing licence: for a fixed set of users, projects, shares, credentials and executions, what it
// returns and which error it throws. The snapshot records what n8n does, so a change in behaviour
// shows up as a snapshot diff. packages/cli/src/executions/FORK.md tells how the fork made the
// snapshot.
import { LicenseState } from '@n8n/backend-common';
import { WorkflowSharingService } from '@n8n/backend-services';
import {
	createTeamProject,
	createWorkflow,
	linkUserToProject,
	mockInstance,
	shareWorkflowWithProjects,
	shareWorkflowWithUsers,
	testDb,
} from '@n8n/backend-test-utils';
import type { BooleanLicenseFeature } from '@n8n/constants';
import type { CredentialsEntity, Project, Role, User, WorkflowEntity } from '@n8n/db';
import {
	GLOBAL_ADMIN_ROLE,
	GLOBAL_CHAT_USER_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type { ExecutionSnapshot } from '@n8n/engine';
import { parse, stringify } from 'flatted';
import type { INode } from 'n8n-workflow';

import { ConcurrencyControlService } from '@/concurrency/concurrency-control.service';
import type { ExecutionRequest } from '@/executions/execution.types';
import { License } from '@/license';
import { EngineDataPlaneProxyService } from '@/services/engine-data-plane-proxy.service';
import { WaitTracker } from '@/wait-tracker';

import {
	saveCredential,
	shareCredentialWithProjects,
	shareCredentialWithUsers,
} from '@test-integration/db/credentials';
import { createExecution } from '@test-integration/db/executions';
import { createCustomRoleWithScopeSlugs } from '@test-integration/db/roles';
import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import { LicenseMocker } from '@test-integration/license';
import { initNodeTypes } from '@test-integration/utils';

// The module under test. To record the snapshot against the original service in a checkout of
// upstream n8n, point this import at `@/executions/execution.service.ee`.
import { EnterpriseExecutionsService } from '@/executions/enterprise-execution.service';

mockInstance(WaitTracker);
mockInstance(ConcurrencyControlService, {
	// @ts-expect-error Private property
	isEnabled: false,
});

const FEATURES: BooleanLicenseFeature[] = [
	'feat:sharing',
	'feat:folders',
	'feat:advancedPermissions',
	'feat:projectRole:admin',
	'feat:projectRole:editor',
	'feat:projectRole:viewer',
];
const license = new LicenseMocker();

const recorder = new GoldenRecorder();
const { label, labelString, normalize, describeError, dumpDb, diffDumps } = recorder;

// #region Fixture

const USER_LABELS = [
	'owner',
	'admin',
	'memberA',
	'memberB',
	'memberC',
	'memberD',
	'chatUser',
	'globalViewer',
] as const;
type UserLabel = (typeof USER_LABELS)[number];

const V2_EXECUTION_ID = '01a038ae-c4a8-7799-8a3e-e3c2ca055cfa';
const UNKNOWN_V2_EXECUTION_ID = '01a038ae-c4a8-7799-8a3e-e3c2ca055cfb';
/** An engine v2 execution of a workflow that the database does not have. */
const ORPHAN_V2_EXECUTION_ID = '01a038ae-c4a8-7799-8a3e-e3c2ca055cfc';
const MISSING_WORKFLOW_ID = 'missing-workflow';

type Fixture = {
	users: Record<UserLabel, User>;
	/** Execution ids by label. */
	executions: Record<string, string>;
};

let fixture: Fixture;
const roles: Record<string, Role> = {};

const trigger: INode = {
	id: 'trigger',
	name: 'Manual Trigger',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** An HTTP Request node that uses a credential. */
function httpNode(nodeId: string, credential: Pick<CredentialsEntity, 'id' | 'name'>): INode {
	return {
		id: nodeId,
		name: `HTTP ${nodeId}`,
		type: 'n8n-nodes-base.httpRequest',
		typeVersion: 4.2,
		position: [200, 0],
		parameters: {
			url: 'https://a.example',
			authentication: 'genericCredentialType',
			genericAuthType: 'httpHeaderAuth',
		},
		credentials: { httpHeaderAuth: { id: credential.id, name: credential.name } },
	};
}

/** Run data of a run of the trigger node, flatted as the database keeps it. */
const runData = (value: string) =>
	stringify({
		version: 1,
		resultData: {
			runData: {
				'Manual Trigger': [
					{
						startTime: 1_000,
						executionIndex: 0,
						executionTime: 1,
						executionStatus: 'success',
						source: [],
						data: { main: [[{ json: { value } }]] },
					},
				],
			},
			lastNodeExecuted: 'Manual Trigger',
		},
	});

/** The workflow of the engine v2 execution, as the data plane keeps it from the start of the run. */
function v2Snapshot(workflowId: string, executionId = V2_EXECUTION_ID): ExecutionSnapshot {
	return {
		id: executionId,
		workflowId,
		status: 'completed',
		mode: 'manual',
		hostMode: 'manual',
		graph: { nodes: [{ id: 'trigger', name: 'Manual Trigger', type: 'trigger' }], edges: [] },
		workflow: {
			id: workflowId,
			name: 'As it ran',
			nodes: [{ name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger' }],
			connections: {},
			settings: {},
			nodeGroups: [],
		},
		createdAt: '2026-08-25T10:00:00.000Z',
		updatedAt: '2026-08-25T10:00:05.000Z',
		finishedAt: '2026-08-25T10:00:05.000Z',
		steps: [
			{
				id: 'step-1',
				nodeId: 'trigger',
				iteration: 0,
				status: 'completed',
				outputs: [[{ json: { value: 'v2' } }]],
				error: null,
				createdAt: '2026-08-25T10:00:00.000Z',
				updatedAt: '2026-08-25T10:00:00.250Z',
			},
		],
	} as ExecutionSnapshot;
}

async function seed(): Promise<Fixture> {
	await testDb.truncate([
		'ExecutionEntity',
		'SharedWorkflow',
		'SharedCredentials',
		'WorkflowEntity',
		'CredentialsEntity',
		'ProjectRelation',
		'Project',
		'User',
	]);
	recorder.reset();

	const roleOf: Record<UserLabel, Role> = {
		owner: GLOBAL_OWNER_ROLE,
		admin: GLOBAL_ADMIN_ROLE,
		memberA: GLOBAL_MEMBER_ROLE,
		memberB: GLOBAL_MEMBER_ROLE,
		memberC: GLOBAL_MEMBER_ROLE,
		memberD: GLOBAL_MEMBER_ROLE,
		chatUser: GLOBAL_CHAT_USER_ROLE,
		globalViewer: roles.globalViewer,
	};
	const users = {} as Record<UserLabel, User>;
	const projects: Record<string, Project> = {};
	for (const name of USER_LABELS) {
		users[name] = await createUser({
			email: `${name.toLowerCase()}@example.com`,
			firstName: name,
			lastName: 'Test',
			role: roleOf[name],
		});
		label(users[name].id, name);
		const personal = await Container.get(ProjectRepository).getPersonalProjectForUser(
			users[name].id,
		);
		if (!personal) throw new Error(`No personal project for ${name}`);
		projects[`personal:${name}`] = personal;
	}
	projects.alpha = await createTeamProject('Alpha', users.memberA);
	projects.beta = await createTeamProject('Beta', users.memberB);
	for (const [project, member, role] of [
		['alpha', 'memberB', 'project:editor'],
		['alpha', 'memberC', 'project:viewer'],
		['alpha', 'memberD', roles.workflowReader.slug],
		['beta', 'memberD', roles.executionReader.slug],
	] as const) {
		await linkUserToProject(users[member], projects[project], role);
	}
	for (const [name, project] of Object.entries(projects)) label(project.id, name);

	const payload = (name: string) => ({
		name,
		type: 'httpHeaderAuth',
		data: { name: 'X-Header', value: `${name} value` },
	});
	const credentials: Record<string, CredentialsEntity> = {
		memberA: await saveCredential(payload('memberA credential'), {
			user: users.memberA,
			role: 'credential:owner',
		}),
		owner: await saveCredential(payload('owner credential'), {
			user: users.owner,
			role: 'credential:owner',
		}),
		alpha: await saveCredential(payload('alpha credential'), {
			project: projects.alpha,
			role: 'credential:owner',
		}),
		beta: await saveCredential(payload('beta credential'), {
			project: projects.beta,
			role: 'credential:owner',
		}),
		global: await saveCredential(
			{ ...payload('global credential'), isGlobal: true },
			{ user: users.owner, role: 'credential:owner' },
		),
	};
	await shareCredentialWithUsers(credentials.memberA, [users.memberB]);
	await shareCredentialWithProjects(credentials.beta, [projects.alpha]);
	for (const [name, credential] of Object.entries(credentials)) {
		label(credential.id, `${name}Credential`);
	}

	const workflow = async (
		name: string,
		nodes: INode[],
		owner: Project,
		extra: Partial<WorkflowEntity> = {},
	) => {
		const created = await createWorkflow({ name, nodes, connections: {}, ...extra }, owner);
		label(created.id, name);
		return created;
	};
	const workflows = {
		wfA: await workflow(
			'wfA',
			[trigger, httpNode('a1', credentials.memberA), httpNode('a2', credentials.owner)],
			projects['personal:memberA'],
		),
		wfAlpha: await workflow(
			'wfAlpha',
			[
				trigger,
				httpNode('t1', credentials.alpha),
				httpNode('t2', credentials.beta),
				httpNode('t3', credentials.global),
			],
			projects.alpha,
		),
		wfOwner: await workflow(
			'wfOwner',
			[trigger, httpNode('o1', credentials.owner)],
			projects['personal:owner'],
		),
		wfArchived: await workflow('wfArchived', [trigger], projects['personal:memberA'], {
			isArchived: true,
		}),
		wfChanged: await workflow(
			'wfChanged',
			[trigger, httpNode('c1', credentials.memberA)],
			projects['personal:memberA'],
		),
		wfNoCredentials: await workflow('wfNoCredentials', [trigger], projects['personal:memberB']),
		wfOddCredentials: await workflow(
			'wfOddCredentials',
			[
				trigger,
				httpNode('x1', { id: 'deleted-credential', name: 'deleted credential' }),
				httpNode('x2', credentials.memberA),
				httpNode('x3', credentials.memberA),
			],
			projects['personal:memberA'],
		),
	};
	await shareWorkflowWithUsers(workflows.wfA, [users.memberB]);
	await shareWorkflowWithProjects(workflows.wfA, [{ project: projects.beta }]);
	await shareWorkflowWithProjects(workflows.wfNoCredentials, [{ project: projects.alpha }]);

	const executions: Record<string, string> = {};
	const execution = async (
		name: string,
		ran: WorkflowEntity,
		attributes: Parameters<typeof createExecution>[0] = {},
	) => {
		const created = await createExecution({ data: runData(name), ...attributes }, ran);
		executions[name] = created.id;
		executionLabels.set(created.id, name);
	};
	await execution('wfA success', workflows.wfA, { status: 'success', finished: true });
	await execution('wfA error', workflows.wfA, { status: 'error', finished: false });
	await execution('wfA waiting', workflows.wfA, {
		status: 'waiting',
		finished: false,
		waitTill: new Date('2030-01-01T00:00:00.000Z'),
	});
	await execution('wfA too large to display', workflows.wfA, { jsonSizeBytes: 2 ** 40 });
	await execution('wfA deleted', workflows.wfA, { deletedAt: new Date() });
	await execution('wfAlpha success', workflows.wfAlpha);
	await execution('wfOwner success', workflows.wfOwner);
	await execution('wfArchived success', workflows.wfArchived);
	await execution('wfChanged before the change', workflows.wfChanged);
	await execution('wfNoCredentials success', workflows.wfNoCredentials);
	await execution('wfOddCredentials success', workflows.wfOddCredentials);
	// The workflow changes after its run: a new name and another credential.
	await Container.get(WorkflowRepository).update(workflows.wfChanged.id, {
		name: 'wfChanged renamed',
		nodes: [trigger, httpNode('c2', credentials.owner)],
	});

	executions['engine v2 of wfAlpha'] = V2_EXECUTION_ID;
	executions['unknown engine v2 id'] = UNKNOWN_V2_EXECUTION_ID;
	executions['unknown id'] = '999999';
	v2WorkflowId = workflows.wfAlpha.id;

	return { users, executions };
}

let v2WorkflowId = '';

/**
 * Execution ids are short numbers, so the recorder does not label them in all strings. The record
 * shows the label in the id fields only.
 */
const executionLabels = new Map<string, string>();
const EXECUTION_ID_FIELDS = ['id', 'retryOf', 'retrySuccessId'];

// #endregion

// #region Recording

let service: EnterpriseExecutionsService;

/** A request to `GET /executions/:id`, as the controller passes it on. */
function request(user: User, executionId: string, query: Record<string, string> = {}) {
	return {
		user,
		params: { id: executionId },
		query,
		ip: '127.0.0.1',
		headers: { 'user-agent': 'golden test' },
	} as unknown as ExecutionRequest.GetOne;
}

/** The workflows whose executions the user may read, as the controller finds them. */
async function accessibleWorkflowIds(user: User) {
	return await Container.get(WorkflowSharingService).getSharedWorkflowIds(user, {
		scopes: ['execution:read'],
	});
}

/** A result with its run data parsed, so that the snapshot shows it as data. */
function describeResult(result: unknown) {
	if (result === undefined || result === null || typeof result !== 'object') {
		return normalize(result);
	}
	const { data, ...rest } = result as { data?: unknown } & Record<string, unknown>;
	for (const field of EXECUTION_ID_FIELDS) {
		const value = rest[field];
		if (typeof value === 'string' && executionLabels.has(value)) {
			rest[field] = `<execution ${executionLabels.get(value)}>`;
		}
	}
	// The service gives the credentials in no fixed order.
	const workflowData = rest.workflowData as { usedCredentials?: Array<{ id: string }> } | undefined;
	if (Array.isArray(workflowData?.usedCredentials)) {
		rest.workflowData = {
			...workflowData,
			usedCredentials: [...workflowData.usedCredentials].sort((a, b) =>
				labelString(a.id).localeCompare(labelString(b.id)),
			),
		};
	}
	return normalize({
		...rest,
		data: typeof data === 'string' && data.length > 0 ? parse(data) : data,
	});
}

async function findOne(
	user: User,
	executionId: string,
	query?: Record<string, string>,
	extraIds: string[] = [],
) {
	const ids = [...(await accessibleWorkflowIds(user)), ...extraIds];
	try {
		const result = await service.findOne(request(user, executionId, query), ids);
		return { workflowIds: ids.map(labelString).sort(), result: describeResult(result) };
	} catch (error) {
		return { workflowIds: ids.map(labelString).sort(), error: describeError(error) };
	}
}

/** Read each execution as each user. */
async function readAll() {
	const outcomes: Record<string, unknown> = {};
	for (const [executionLabel, executionId] of Object.entries(fixture.executions)) {
		for (const user of USER_LABELS) {
			outcomes[`${executionLabel} as ${user}`] = await findOne(fixture.users[user], executionId);
		}
	}
	return outcomes;
}

// #endregion

beforeAll(async () => {
	await testDb.init();
	await initNodeTypes();
	license.mock(Container.get(License));
	license.mockLicenseState(Container.get(LicenseState));
	for (const feature of FEATURES) license.enable(feature);
	license.setQuota('quota:maxTeamProjects', -1);

	roles.globalViewer = await createCustomRoleWithScopeSlugs(
		[
			'workflow:read',
			'workflow:list',
			'execution:read',
			'execution:list',
			'project:read',
			'project:list',
		],
		{ slug: 'custom:global-viewer', displayName: 'Global Viewer', roleType: 'global' },
	);
	roles.workflowReader = await createCustomRoleWithScopeSlugs(['workflow:read'], {
		slug: 'custom:workflowReader',
		displayName: 'workflowReader',
		roleType: 'project',
	});
	roles.executionReader = await createCustomRoleWithScopeSlugs(['execution:read'], {
		slug: 'custom:executionReader',
		displayName: 'executionReader',
		roleType: 'project',
	});

	Container.get(EngineDataPlaneProxyService).registerProvider({
		startExecution: vi.fn(),
		getExecution: vi.fn(async (executionId: string) => {
			if (executionId === V2_EXECUTION_ID) return v2Snapshot(v2WorkflowId);
			if (executionId === ORPHAN_V2_EXECUTION_ID) {
				return v2Snapshot(MISSING_WORKFLOW_ID, ORPHAN_V2_EXECUTION_ID);
			}
			return undefined;
		}),
		searchExecutions: vi.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
		cancelExecution: vi.fn(),
	});

	service = Container.get(EnterpriseExecutionsService);
	fixture = await seed();
});

afterAll(async () => {
	await testDb.terminate();
});

describe('EnterpriseExecutionsService.findOne', () => {
	test('each execution as each user, with the sharing licence', async () => {
		const before = await dumpDb();
		const outcomes = await readAll();
		outcomes['database changes'] = diffDumps(before, await dumpDb());
		expect(outcomes).toMatchSnapshot();
	}, 120_000);

	test('each execution as each user, without the sharing licence', async () => {
		license.disable('feat:sharing');
		try {
			expect(await readAll()).toMatchSnapshot();
		} finally {
			license.enable('feat:sharing');
		}
	}, 120_000);

	test('an execution of a workflow that is gone, with its id in the list', async () => {
		const outcomes: Record<string, unknown> = {};
		for (const user of ['owner', 'memberA'] as const) {
			outcomes[`as ${user}`] = await findOne(fixture.users[user], ORPHAN_V2_EXECUTION_ID, {}, [
				MISSING_WORKFLOW_ID,
			]);
		}
		expect(outcomes).toMatchSnapshot();
	}, 120_000);

	test('the redaction query', async () => {
		const outcomes: Record<string, unknown> = {};
		for (const value of ['true', 'false', 'other']) {
			for (const user of ['owner', 'memberA', 'memberB'] as const) {
				outcomes[`redactExecutionData=${value} as ${user}`] = await findOne(
					fixture.users[user],
					fixture.executions['wfA success'],
					{ redactExecutionData: value },
				);
			}
		}
		expect(outcomes).toMatchSnapshot();
	}, 120_000);
});
