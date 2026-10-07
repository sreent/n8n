// The behaviour of the sharing services `EnterpriseWorkflowService` and `EnterpriseCredentialsService`:
// for a fixed set of users, projects, workflows and credentials, what each method returns, which
// error it throws, which events it emits and what it changes in the database. The snapshot records
// what n8n does, so a change in behaviour shows up as a snapshot diff. packages/cli/src/workflows/FORK.md
// tells how the fork made the snapshot.
import { LicenseState } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import {
	createActiveWorkflow,
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
	CredentialsRepository,
	ProjectRelationRepository,
	ProjectRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
	WorkflowRepository,
} from '@n8n/db';
import type { EnforcementPoint, PolicedWorkflow } from '@n8n/decorators';
import { Container } from '@n8n/di';
import type { EntityManager } from '@n8n/typeorm';
import type { INode } from 'n8n-workflow';
import { deepCopy, WorkflowActivationError } from 'n8n-workflow';
import type { MockInstance } from 'vitest';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { EnterpriseCredentialsService } from '@/credentials/enterprise-credentials.service';
import { License } from '@/license';
import type {
	PolicyActor,
	PolicyContext,
	PolicyEnforcementBackend,
} from '@/policy/policy-enforcement-backend';
import { PolicyEnforcementService } from '@/policy/policy-enforcement.service';
import { OwnershipService } from '@/services/ownership.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';
import { EnterpriseWorkflowService } from '@/workflows/enterprise-workflow.service';

import {
	saveCredential,
	shareCredentialWithProjects,
	shareCredentialWithUsers,
} from '@test-integration/db/credentials';
import { createFolder } from '@test-integration/db/folders';
import { createCustomRoleWithScopeSlugs } from '@test-integration/db/roles';
import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import { LicenseMocker } from '@test-integration/license';
import { initNodeTypes } from '@test-integration/utils';

const activeWorkflowManager = mockInstance(ActiveWorkflowManager);

const FEATURES: BooleanLicenseFeature[] = [
	'feat:sharing',
	'feat:folders',
	'feat:advancedPermissions',
	'feat:projectRole:admin',
	'feat:projectRole:editor',
	'feat:projectRole:viewer',
];
const license = new LicenseMocker();

/** Run `fn` without some licence features, then restore the full licence. */
async function withoutFeatures<T>(features: BooleanLicenseFeature[], fn: () => Promise<T>) {
	for (const feature of features) license.disable(feature);
	try {
		return await fn();
	} finally {
		for (const feature of FEATURES) license.enable(feature);
	}
}

const recorder = new GoldenRecorder();
const { labels, label, labelString, normalize, describeError, dumpDb, diffDumps, labelNewRows } =
	recorder;

// #region Fixture

let emitSpy: MockInstance<EventService['emit']>;
let workflowService: EnterpriseWorkflowService;
let credentialsService: EnterpriseCredentialsService;

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

type Fixture = {
	users: Record<string, User>;
	ids: Record<string, string>;
	credentials: Record<string, CredentialsEntity>;
};

let fixture: Fixture;

/**
 * Custom roles. The global role can see but not use or change. The project roles hold one or two
 * scopes each, so a case can show which scope a check needs.
 */
const roles: Record<string, Role> = {};
const CUSTOM_PROJECT_ROLES = {
	workflowReader: ['workflow:read'],
	projectReader: ['project:read'],
	projectLister: ['project:list'],
	credentialReader: ['credential:read'],
	credentialCreator: ['credential:create'],
	credentialMover: ['credential:move'],
	credentialReaderMover: ['credential:read', 'credential:move'],
	credentialManager: ['credential:read', 'credential:move', 'credential:create'],
	workflowCreator: ['workflow:create'],
	workflowMover: ['workflow:move'],
	workflowReaderMover: ['workflow:read', 'workflow:move'],
	folderCreator: ['folder:create', 'workflow:read'],
} as const;
type CustomProjectRole = keyof typeof CUSTOM_PROJECT_ROLES;

const trigger: INode = {
	id: 'trigger',
	name: 'Manual Trigger',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** An HTTP Request node that uses a credential, by id and name or by name only. */
function httpNode(
	nodeId: string,
	credential: CredentialsEntity | string,
	url = 'https://a.example',
): INode {
	return {
		id: nodeId,
		name: `HTTP ${nodeId}`,
		type: 'n8n-nodes-base.httpRequest',
		typeVersion: 4.2,
		position: [200, 0],
		parameters: { url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
		credentials: {
			httpHeaderAuth:
				typeof credential === 'string'
					? (credential as unknown as { id: string; name: string })
					: { id: credential.id, name: credential.name },
		},
	};
}

type CredentialReference =
	| CredentialsEntity
	| { id: string; name: string }
	| { id: null; name: string; __aiGatewayManaged: true };

const toReference = (credential: CredentialReference) =>
	credential instanceof Object && 'type' in credential
		? { id: credential.id, name: credential.name }
		: credential;

/** A Message an Agent node with an inline agent, as an object or as a JSON string. */
function agentNode(
	nodeId: string,
	name: string,
	inlineAgent: unknown,
	extra: Record<string, unknown> = {},
): INode {
	return {
		id: nodeId,
		name,
		type: 'n8n-nodes-base.messageAnAgent',
		typeVersion: 2,
		position: [400, 0],
		parameters: { agentSource: 'inline', inlineAgent, ...extra } as INode['parameters'],
	};
}

/** The value of the `inlineAgent` parameter: a model credential, and node tools. */
function agentConfig(credential: string | undefined, tools: unknown[] = []) {
	return {
		config: {
			name: 'Agent',
			model: 'openai/gpt-4o-mini',
			...(credential === undefined ? {} : { credential }),
			instructions: 'Help',
			...(tools.length > 0 ? { tools } : {}),
		},
	};
}

/** A node tool of an inline agent, with a credential. */
function nodeTool(credential: CredentialReference) {
	return {
		type: 'node',
		name: 'tool',
		node: {
			nodeType: 'n8n-nodes-base.httpRequest',
			nodeTypeVersion: 4.2,
			nodeParameters: {},
			credentials: { httpHeaderAuth: toReference(credential) },
		},
	};
}

/** A node with an inline sub-workflow (`workflowJson`) whose HTTP node uses a credential. */
function subWorkflowNode(
	nodeId: string,
	name: string,
	credential: CredentialReference,
	type = 'n8n-nodes-base.executeWorkflow',
	depth = 0,
): INode {
	let workflowJson = JSON.stringify({
		nodes: [
			{
				name: 'Inner',
				type: 'n8n-nodes-base.httpRequest',
				typeVersion: 4.2,
				parameters: {},
				credentials: { httpHeaderAuth: toReference(credential) },
			},
		],
		connections: {},
	});
	for (let level = 0; level < depth; level++) {
		workflowJson = JSON.stringify({
			nodes: [
				{
					name: `Nested ${level}`,
					type: 'n8n-nodes-base.executeWorkflow',
					typeVersion: 1.2,
					parameters: { source: 'parameter', workflowJson },
				},
			],
			connections: {},
		});
	}
	return {
		id: nodeId,
		name,
		type,
		typeVersion: 1.2,
		position: [400, 0],
		parameters: { source: 'parameter', workflowJson },
	};
}

async function seed(): Promise<Fixture> {
	await testDb.truncate([
		'SharedWorkflow',
		'SharedCredentials',
		'WorkflowEntity',
		'CredentialsEntity',
		'Folder',
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
	const users: Record<string, User> = {};
	const projects: Record<string, Project> = {};
	const ids: Record<string, string> = {
		missing: 'missing-project',
		missingWorkflow: 'missing-workflow',
		missingCredential: 'missing-credential',
		missingFolder: 'missing-folder',
	};
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
	projects.gamma = await createTeamProject('Gamma');
	for (const [project, member, role] of [
		['alpha', 'memberB', 'project:editor'],
		['alpha', 'memberC', 'project:viewer'],
		['beta', 'memberD', 'project:editor'],
		['gamma', 'memberA', 'project:editor'],
		['gamma', 'memberC', 'project:viewer'],
	] as const) {
		await linkUserToProject(users[member], projects[project], role);
	}
	for (const [name, project] of Object.entries(projects)) ids[name] = label(project.id, name);

	const payload = (name: string) => ({
		name,
		type: 'httpHeaderAuth',
		data: { name: 'X-Header', value: `${name} value` },
	});
	const credentials: Record<string, CredentialsEntity> = {
		alpha: await saveCredential(payload('alpha credential'), {
			project: projects.alpha,
			role: 'credential:owner',
		}),
		beta: await saveCredential(payload('beta credential'), {
			project: projects.beta,
			role: 'credential:owner',
		}),
		owner: await saveCredential(payload('owner credential'), {
			user: users.owner,
			role: 'credential:owner',
		}),
		memberA: await saveCredential(payload('memberA credential'), {
			user: users.memberA,
			role: 'credential:owner',
		}),
		global: await saveCredential(
			{ ...payload('global credential'), isGlobal: true },
			{ user: users.owner, role: 'credential:owner' },
		),
		memberB: await saveCredential(payload('memberB credential'), {
			user: users.memberB,
			role: 'credential:owner',
		}),
		admin: await saveCredential(payload('admin credential'), {
			user: users.admin,
			role: 'credential:owner',
		}),
		memberC: await saveCredential(payload('memberC credential'), {
			user: users.memberC,
			role: 'credential:owner',
		}),
		gamma: await saveCredential(payload('gamma credential'), {
			project: projects.gamma,
			role: 'credential:owner',
		}),
		endUser: await saveCredential(
			{ ...payload('end-user credential'), isResolvable: true },
			{ project: projects.alpha, role: 'credential:owner' },
		),
	};
	// An instance credential has no shares.
	credentials.instance = await saveCredential(payload('instance credential'), {
		user: users.owner,
		role: 'credential:owner',
	});
	await Container.get(SharedCredentialsRepository).delete({
		credentialsId: credentials.instance.id,
	});
	await Container.get(CredentialsRepository).update(credentials.instance.id, {
		usageScope: 'instance',
	});
	await shareCredentialWithProjects(credentials.beta, [projects.alpha]);
	await shareCredentialWithUsers(credentials.memberA, [users.memberB]);
	await shareCredentialWithUsers(credentials.memberB, [users.memberC]);
	await shareCredentialWithUsers(credentials.admin, [users.memberA]);
	for (const [name, credential] of Object.entries(credentials)) {
		ids[`${name}Credential`] = label(credential.id, `${name}Credential`);
	}

	const folder1 = await createFolder(projects.alpha, { name: 'F1' });
	const folder2 = await createFolder(projects.alpha, { name: 'F2', parentFolder: folder1 });
	const betaFolder = await createFolder(projects.beta, { name: 'FB' });
	const gammaFolder = await createFolder(projects.gamma, { name: 'FG' });
	ids.folder1 = label(folder1.id, 'folder1');
	ids.folder2 = label(folder2.id, 'folder2');
	ids.betaFolder = label(betaFolder.id, 'betaFolder');
	ids.gammaFolder = label(gammaFolder.id, 'gammaFolder');

	const workflow = async (
		name: string,
		nodes: INode[],
		owner: Project,
		extra: Partial<WorkflowEntity> = {},
	) => {
		const created = await createWorkflow({ name, nodes, connections: {}, ...extra }, owner);
		ids[name] = label(created.id, name);
		return created;
	};
	await workflow(
		'alphaWorkflow',
		[
			trigger,
			httpNode('alpha', credentials.alpha),
			httpNode('beta', credentials.beta),
			httpNode('owner', credentials.owner),
			httpNode('global', credentials.global),
		],
		projects.alpha,
	);
	await workflow(
		'folder1Workflow',
		[trigger, httpNode('alpha', credentials.alpha), httpNode('endUser', credentials.endUser)],
		projects.alpha,
		{ parentFolder: folder1 },
	);
	await workflow(
		'folder2Workflow',
		[trigger, httpNode('memberA', credentials.memberA)],
		projects.alpha,
		{
			parentFolder: folder2,
		},
	);
	const active = await createActiveWorkflow(
		{
			name: 'activeWorkflow',
			nodes: [trigger, httpNode('alpha', credentials.alpha)],
			parentFolder: folder1,
		},
		projects.alpha,
	);
	ids.activeWorkflow = label(active.id, 'activeWorkflow');
	const beta = await workflow(
		'betaWorkflow',
		[trigger, httpNode('beta', credentials.beta)],
		projects.beta,
	);
	await shareWorkflowWithUsers(beta, [users.memberC]);
	const personal = await workflow(
		'personalWorkflow',
		[trigger, httpNode('memberA', credentials.memberA)],
		projects['personal:memberA'],
	);
	await shareWorkflowWithProjects(personal, [{ project: projects.gamma, role: 'workflow:editor' }]);
	await workflow('namedWorkflow', [trigger, httpNode('named', 'owner credential')], projects.alpha);
	await workflow('emptyWorkflow', [trigger], projects.gamma);
	// Credentials in node parameters: inline agents and inline sub-workflows.
	await workflow(
		'agentWorkflow',
		[
			trigger,
			agentNode('agent-owner', 'Agent owner', agentConfig(credentials.owner.id)),
			agentNode('agent-alpha', 'Agent alpha', agentConfig(credentials.alpha.id)),
			agentNode(
				'agent-tool-owner',
				'Agent tool owner',
				agentConfig(credentials.alpha.id, [nodeTool(credentials.owner)]),
			),
			agentNode(
				'agent-json-owner',
				'Agent JSON owner',
				JSON.stringify(agentConfig(credentials.owner.id)),
			),
			subWorkflowNode('sub-owner', 'Sub owner', credentials.owner),
			subWorkflowNode('sub-alpha', 'Sub alpha', credentials.alpha),
		],
		projects.alpha,
	);
	await workflow(
		'agentEndUserWorkflow',
		[trigger, agentNode('agent-end-user', 'Agent end user', agentConfig(credentials.endUser.id))],
		projects.alpha,
	);
	await workflow(
		'subEndUserWorkflow',
		[trigger, subWorkflowNode('sub-end-user', 'Sub end user', credentials.endUser)],
		projects.alpha,
	);
	// Nodes without ids, as in older workflows.
	const withoutId = ({ id: _, ...node }: INode) => node as INode;
	await workflow(
		'idlessWorkflow',
		[
			withoutId(trigger),
			withoutId(httpNode('alpha', credentials.alpha)),
			withoutId(httpNode('owner', credentials.owner)),
		],
		projects.alpha,
	);
	// Workflows of personal projects, shared with other users.
	const memberBWorkflow = await workflow(
		'memberBWorkflow',
		[
			trigger,
			httpNode('memberB', credentials.memberB),
			httpNode('memberA', credentials.memberA),
			httpNode('global', credentials.global),
		],
		projects['personal:memberB'],
	);
	await shareWorkflowWithUsers(memberBWorkflow, [users.memberA, users.memberC]);
	// The default workflow of the test helper, owned by the instance owner and shared with a member.
	const ownerShared = await createWorkflow({ name: 'ownerSharedWorkflow' }, users.owner);
	ids.ownerSharedWorkflow = label(ownerShared.id, 'ownerSharedWorkflow');
	await shareWorkflowWithUsers(ownerShared, [users.memberA]);
	const adminWorkflow = await workflow(
		'adminWorkflow',
		[trigger, httpNode('admin', credentials.admin), httpNode('owner', credentials.owner)],
		projects['personal:admin'],
	);
	await shareWorkflowWithUsers(adminWorkflow, [users.memberA]);
	await workflow(
		'ownerWorkflow',
		[trigger, httpNode('owner', credentials.owner), httpNode('memberA', credentials.memberA)],
		projects['personal:owner'],
	);

	labels.set('missing-project', 'missing');
	return { users, ids, credentials };
}

const user = (name: string) => fixture.users[name];
const id = (name: string) => fixture.ids[name];

const WORKFLOW_LABELS = [
	'alphaWorkflow',
	'folder1Workflow',
	'folder2Workflow',
	'activeWorkflow',
	'betaWorkflow',
	'personalWorkflow',
	'namedWorkflow',
	'emptyWorkflow',
	'ownerWorkflow',
	'idlessWorkflow',
	'memberBWorkflow',
	'adminWorkflow',
	'ownerSharedWorkflow',
	'agentWorkflow',
	'agentEndUserWorkflow',
	'subEndUserWorkflow',
];
const CREDENTIAL_LABELS = [
	'alpha',
	'beta',
	'owner',
	'memberA',
	'global',
	'endUser',
	'instance',
].map((name) => `${name}Credential`);

async function loadWorkflow(workflowId: string) {
	const workflow = await Container.get(WorkflowFinderService).findWorkflowForUser(
		workflowId,
		user('owner'),
		['workflow:read'],
		{ includeTags: true, includeParentFolder: true, includeActiveVersion: true },
	);
	if (!workflow) throw new Error(`No workflow ${workflowId}`);
	return workflow;
}

function withoutNodeId(node: INode): INode {
	const { id: _, ...rest } = node;
	return rest as INode;
}

function deepCopyNode(node: INode): INode {
	return deepCopy(node);
}

/** A value as one line of JSON with sorted keys, to keep the snapshot small. */
function line(value: unknown) {
	return JSON.stringify(value, (_key, entry: unknown) => {
		if (entry === undefined) return '<undefined>';
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
		return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
	});
}

/** A list of credentials in the order of their labels: the services give them in no fixed order. */
function byCredentialLabel(credentials: unknown) {
	if (!Array.isArray(credentials)) return credentials;
	return [...(credentials as Array<{ id: string }>)].sort((a, b) =>
		labelString(a.id).localeCompare(labelString(b.id)),
	);
}

// #endregion

// #region Observation

type Outcome = {
	result?: unknown;
	error?: string;
	events?: unknown[];
	activeWorkflowManager?: unknown[];
	policy?: unknown[];
	workflowOwners?: Record<string, string>;
	db?: ReturnType<typeof diffDumps>;
};

const AWM_METHODS = ['add', 'remove', 'clearWebhooks', 'removeActivationError'] as const;

/**
 * A policy backend that records each call and denies a workflow transfer into the projects in
 * `deniedProjects`. It shows when the services ask for a policy decision, and with what.
 */
const deniedProjects = new Set<string>();
const policyCalls: unknown[] = [];

function describePolicyContext(context: object) {
	const isWorkflow = (value: unknown): value is PolicedWorkflow =>
		typeof value === 'object' && value !== null && 'nodes' in value;
	return Object.fromEntries(
		Object.entries(context).map(([key, value]) => [
			key,
			isWorkflow(value)
				? { id: value.id, name: value.name, nodes: value.nodes.map(({ name }) => name) }
				: value,
		]),
	);
}

const policyBackend: PolicyEnforcementBackend = {
	hasChecksFor: () => true,
	async enforce<Point extends EnforcementPoint>(
		point: Point,
		context: PolicyContext<Point>,
		actor: PolicyActor,
	) {
		policyCalls.push(['enforce', point, describePolicyContext(context), actor]);
		const target = 'targetProjectId' in context ? context.targetProjectId : null;
		if (target === null || !deniedProjects.has(target)) return { violations: [] };
		return {
			violations: [
				{
					kind: 'test-denied',
					checkId: 'test',
					message: `Transfers into ${target} are blocked`,
					subject: target,
					subjectType: 'project',
					scope: 'project',
				},
			],
		};
	},
	async evaluate<Point extends EnforcementPoint>(point: Point, context: PolicyContext<Point>) {
		policyCalls.push(['evaluate', point, describePolicyContext(context)]);
		return { violations: [] };
	},
};

function resetCalls() {
	emitSpy.mockClear();
	for (const method of AWM_METHODS) activeWorkflowManager[method].mockClear();
	policyCalls.length = 0;
}

function collectCalls(outcome: Outcome) {
	const events = emitSpy.mock.calls.map(([name, payload]) => [name, normalize(payload)]);
	if (events.length > 0) outcome.events = events;
	// In the order of the calls, across the methods.
	const calls = AWM_METHODS.flatMap((method) => {
		const { calls: argsList, invocationCallOrder } = activeWorkflowManager[method].mock;
		return argsList.map((args, index) => ({
			order: invocationCallOrder[index],
			call: [method, normalize(args)],
		}));
	})
		.sort((a, b) => a.order - b.order)
		.map(({ call }) => call);
	if (calls.length > 0) outcome.activeWorkflowManager = calls;
	if (policyCalls.length > 0) outcome.policy = policyCalls.map((call) => normalize(call));
}

/** The lists of shares come in no fixed order. Sort them, after the labels are in place. */
function sortShareLists(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortShareLists);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			(key === 'shared' || key === 'sharedWithProjects') && Array.isArray(entry)
				? entry
						.map(sortShareLists)
						.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
				: sortShareLists(entry),
		]),
	);
}

async function run(outcome: Outcome, fn: () => Promise<unknown>) {
	try {
		const result = await fn();
		await labelNewRows();
		outcome.result = sortShareLists(normalize(result));
	} catch (error) {
		await labelNewRows();
		outcome.error = describeError(error);
	}
	collectCalls(outcome);
}

/** Call a reading method. The database is checked once for all of them. */
async function read(fn: () => Promise<unknown>): Promise<Outcome> {
	resetCalls();
	const outcome: Outcome = {};
	await run(outcome, fn);
	return outcome;
}

/** The project that the ownership cache gives for each workflow. */
async function cachedOwners() {
	const owners: Record<string, string> = {};
	for (const workflow of WORKFLOW_LABELS) {
		const project = await Container.get(OwnershipService).getWorkflowProjectCached(id(workflow));
		owners[workflow] = labelString(project.id);
	}
	return owners;
}

/**
 * Seed the fixture again, change it with `prepare` for this case, call a changing method, and
 * record what the call changed.
 */
async function write(
	fn: () => Promise<unknown>,
	prepare?: () => Promise<unknown>,
): Promise<Outcome> {
	fixture = await seed();
	deniedProjects.clear();
	await prepare?.();
	const ownersBefore = await cachedOwners();
	const before = await dumpDb();
	resetCalls();
	const outcome: Outcome = {};
	await run(outcome, fn);
	const db = diffDumps(before, await dumpDb());
	if (Object.keys(db).length > 0) outcome.db = db;
	const ownersAfter = await cachedOwners();
	if (JSON.stringify(ownersAfter) !== JSON.stringify(ownersBefore)) {
		outcome.workflowOwners = ownersAfter;
	}
	return outcome;
}

async function inTransaction<T>(fn: (trx: EntityManager) => Promise<T>) {
	return await Container.get(ProjectRepository).manager.transaction(fn);
}

/** Give a user a role in a team project, in place of the role that they have there. */
async function setRole(userLabel: UserLabel, project: string, role: string) {
	const relations = Container.get(ProjectRelationRepository);
	await relations.delete({ userId: user(userLabel).id, projectId: id(project) });
	await relations.insert({
		userId: user(userLabel).id,
		projectId: id(project),
		role: { slug: role },
	});
}

const customRole = (name: CustomProjectRole) => roles[name].slug;

async function archiveWorkflow(workflow: string) {
	await Container.get(WorkflowRepository).update(id(workflow), { isArchived: true });
}

async function shareWorkflow(workflow: string, project: string) {
	await Container.get(SharedWorkflowRepository).insert({
		workflowId: id(workflow),
		projectId: id(project),
		role: 'workflow:editor',
	});
}

/** Shares come in no fixed order. */
function byProject<T extends { projectId: string }>(shares: T[]) {
	return [...shares].sort((a, b) =>
		labelString(a.projectId).localeCompare(labelString(b.projectId)),
	);
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
			'credential:read',
			'credential:list',
			'workflow:read',
			'workflow:list',
			'project:read',
			'project:list',
			'folder:read',
			'folder:list',
		],
		{ slug: 'custom:global-viewer', displayName: 'Global Viewer', roleType: 'global' },
	);
	for (const [name, scopes] of Object.entries(CUSTOM_PROJECT_ROLES)) {
		roles[name] = await createCustomRoleWithScopeSlugs([...scopes], {
			slug: `custom:${name}`,
			displayName: name,
			roleType: 'project',
		});
	}

	Container.get(PolicyEnforcementService).setImplementation(policyBackend);

	workflowService = Container.get(EnterpriseWorkflowService);
	credentialsService = Container.get(EnterpriseCredentialsService);
	fixture = await seed();
});

// The vitest config restores spies after each test, so each test needs a new one.
beforeEach(() => {
	emitSpy = vi.spyOn(Container.get(EventService), 'emit');
});

afterAll(async () => {
	await testDb.terminate();
});

describe('sharing services', () => {
	test('reading methods', async () => {
		const outcomes: Record<string, unknown> = {};
		const before = await dumpDb();

		for (const workflow of WORKFLOW_LABELS) {
			outcomes[`addOwnerAndSharings ${workflow}`] = await read(async () =>
				workflowService.addOwnerAndSharings(await loadWorkflow(id(workflow))),
			);
			outcomes[`collectCredentialReferences ${workflow}`] = await read(async () => {
				const { ids, hasUnresolved } = workflowService.collectCredentialReferences(
					await loadWorkflow(id(workflow)),
				);
				return { ids: [...ids].map(labelString).sort(), hasUnresolved };
			});
			for (const [setName, allowed] of [
				['none', []],
				['alpha and beta', ['alphaCredential', 'betaCredential']],
				['all', CREDENTIAL_LABELS],
			] as const) {
				outcomes[`validateCredentialPermissionsToUser ${workflow} ${setName}`] = await read(
					async () =>
						workflowService.validateCredentialPermissionsToUser(
							await loadWorkflow(id(workflow)),
							new Set(allowed.map(id)),
						),
				);
			}
			for (const userLabel of ['owner', 'memberA', 'memberB', 'memberC', 'memberD'] as const) {
				outcomes[`addCredentialsToWorkflow ${workflow} ${userLabel}`] = await read(async () => {
					const workflowWithMeta = workflowService.addOwnerAndSharings(
						await loadWorkflow(id(workflow)),
					);
					await workflowService.addCredentialsToWorkflow(workflowWithMeta, user(userLabel));
					return byCredentialLabel(
						(workflowWithMeta as { usedCredentials?: unknown }).usedCredentials,
					);
				});
			}
		}

		// Credential references that the fixture workflows do not have.
		for (const [name, nodeCredentials] of [
			['an id of null', { httpHeaderAuth: { id: null, name: 'owner credential' } }],
			['an empty id', { httpHeaderAuth: { id: '', name: 'owner credential' } }],
			['an expression id', { httpHeaderAuth: { id: '={{ $json.id }}', name: 'x' } }],
			['an object without an id', { httpHeaderAuth: { name: 'owner credential' } }],
			['a numeric id', { httpHeaderAuth: { id: 5, name: 'x' } }],
			['a null credential', { httpHeaderAuth: null }],
			['two credentials', 'two'],
		] as const) {
			const synthetic = () =>
				({
					nodes: [
						trigger,
						{
							...httpNode('synthetic', fixture.credentials.alpha),
							credentials:
								nodeCredentials === 'two'
									? {
											httpHeaderAuth: {
												id: fixture.credentials.alpha.id,
												name: fixture.credentials.alpha.name,
											},
											httpBasicAuth: {
												id: fixture.credentials.owner.id,
												name: fixture.credentials.owner.name,
											},
										}
									: nodeCredentials,
						},
					],
				}) as unknown as WorkflowEntity;
			outcomes[`collectCredentialReferences with ${name}`] = await read(async () => {
				const { ids, hasUnresolved } = workflowService.collectCredentialReferences(synthetic());
				return { ids: [...ids].map(labelString).sort(), hasUnresolved };
			});
			for (const [setName, allowed] of [
				['none', []],
				['all', CREDENTIAL_LABELS],
			] as const) {
				outcomes[`validateCredentialPermissionsToUser with ${name} ${setName}`] = await read(
					async () =>
						workflowService.validateCredentialPermissionsToUser(
							synthetic(),
							new Set(allowed.map(id)),
						),
				);
			}
		}

		for (const [name, workflowIds] of [
			['all', [...WORKFLOW_LABELS, 'missingWorkflow']],
			['none', []],
		] as const) {
			outcomes[`getWorkflowIdsWithResolvableCredentials ${name}`] = await read(async () => {
				const result = await workflowService.getWorkflowIdsWithResolvableCredentials(
					workflowIds.map(id),
				);
				return { type: result.constructor.name, ids: [...result].map(labelString).sort() };
			});
		}

		for (const userLabel of USER_LABELS) {
			for (const [folder, project] of [
				['folder1', 'alpha'],
				['folder2', 'alpha'],
				['betaFolder', 'beta'],
				['folder1', 'beta'],
				['missingFolder', 'alpha'],
			] as const) {
				outcomes[`getFolderUsedCredentials ${userLabel} ${folder} in ${project}`] = await read(
					async () =>
						byCredentialLabel(
							await workflowService.getFolderUsedCredentials(
								user(userLabel),
								id(folder),
								id(project),
							),
						),
				);
			}
			for (const credential of [...CREDENTIAL_LABELS, 'missingCredential']) {
				for (const includeData of [true, false]) {
					outcomes[`getOneForUser ${userLabel} ${credential}${includeData ? ' with data' : ''}`] =
						await read(
							async () =>
								await credentialsService.getOneForUser(
									user(userLabel),
									id(credential),
									includeData,
								),
						);
				}
			}
		}

		// preventTampering: how a user's update of a workflow changes, by the credentials they can use.
		const alphaNodes = () => {
			const { credentials } = fixture;
			const changed = 'https://changed.example';
			const withCredentials = (node: INode, nodeCredentials: unknown) =>
				({ ...node, credentials: nodeCredentials }) as INode;
			const reference = (credential: CredentialsEntity) => ({
				id: credential.id,
				name: credential.name,
			});
			const others = [
				httpNode('alpha', credentials.alpha),
				httpNode('beta', credentials.beta),
				httpNode('global', credentials.global),
			];
			return {
				renamedOwnerNode: [
					trigger,
					...others,
					{ ...httpNode('owner', credentials.owner, changed), name: 'HTTP renamed' },
				],
				ownerNodeWithNewId: [
					trigger,
					...others,
					{ ...httpNode('owner', credentials.owner, changed), id: 'owner2' },
				],
				ownerNodeWithoutId: [
					trigger,
					...others,
					{ ...httpNode('owner', credentials.owner, changed), id: undefined } as unknown as INode,
				],
				ownerNodeMovedFirst: [httpNode('owner', credentials.owner, changed), trigger, ...others],
				ownerNodeWithMemberACredential: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), {
						httpHeaderAuth: reference(credentials.memberA),
					}),
				],
				ownerNodeWithoutCredential: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), undefined),
				],
				ownerNodeWithRenamedCredential: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), {
						httpHeaderAuth: { id: credentials.owner.id, name: 'renamed' },
					}),
				],
				ownerNodeWithAnotherCredentialType: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), {
						httpBasicAuth: reference(credentials.owner),
					}),
				],
				ownerNodeWithSecondCredential: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), {
						httpHeaderAuth: reference(credentials.owner),
						httpBasicAuth: reference(credentials.alpha),
					}),
				],
				alphaNodeWithSecondOwnerCredential: [
					trigger,
					withCredentials(httpNode('alpha', credentials.alpha), {
						httpHeaderAuth: reference(credentials.alpha),
						httpBasicAuth: reference(credentials.owner),
					}),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
				],
				newNodeWithNullCredential: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), {
						httpHeaderAuth: { id: null, name: 'owner credential' },
					}),
				],
				newNodeWithEmptyCredentialId: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), {
						httpHeaderAuth: { id: '', name: 'owner credential' },
					}),
				],
				newNodeWithoutCredentialId: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), {
						httpHeaderAuth: { name: 'owner credential' },
					}),
				],
				ownerNodeEditedEverywhere: [
					trigger,
					...others,
					{
						...httpNode('owner', credentials.owner, changed),
						name: 'HTTP renamed',
						position: [400, 400],
						typeVersion: 4.1,
						disabled: true,
						notes: 'a note',
						retryOnFail: true,
					},
				],
				ownerNodeEditedEverywhereElse: [
					trigger,
					...others,
					{
						...httpNode('owner', credentials.owner, changed),
						type: 'n8n-nodes-base.set',
						notesInFlow: true,
						color: '#ff0000',
						alwaysOutputData: true,
						executeOnce: true,
						onError: 'continueRegularOutput',
						webhookId: 'webhook',
						maxTries: 3,
						waitBetweenTries: 1000,
						extendsCredential: 'x',
					} as INode,
				],
				ownerNodeWithAlphaCredential: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), {
						httpHeaderAuth: reference(credentials.alpha),
					}),
				],
				ownerNodeWithEmptyCredentials: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), {}),
				],
				triggerWithOwnerCredential: [
					withCredentials(trigger, { httpHeaderAuth: reference(credentials.owner) }),
					...others,
					httpNode('owner', credentials.owner),
				],
				newManagedNode: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), {
						httpHeaderAuth: { id: null, name: 'Managed', __aiGatewayManaged: true },
					}),
				],
				newDisabledOwnerNode: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					{ ...httpNode('new', credentials.owner), disabled: true },
				],
				newNodeWithNullCredentialValue: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), { httpHeaderAuth: null }),
				],
				ownerNodeWithNullCredentialValue: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), { httpHeaderAuth: null }),
				],
				alphaNodeWithNullCredentialValue: [
					trigger,
					withCredentials(httpNode('alpha', credentials.alpha), { httpHeaderAuth: null }),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
				],
				triggerWithNullCredentialValue: [
					withCredentials(trigger, { httpHeaderAuth: null }),
					...others,
					httpNode('owner', credentials.owner),
				],
				newNodeWithUndefinedCredentialValue: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), { httpHeaderAuth: undefined }),
				],
				newNodeWithNumericCredentialValue: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), { httpHeaderAuth: 5 }),
				],
				ownerNodeWithManagedCredential: [
					trigger,
					...others,
					withCredentials(httpNode('owner', credentials.owner, changed), {
						httpHeaderAuth: { id: null, name: 'Managed', __aiGatewayManaged: true },
					}),
				],
				newManagedNodeWithOwnerId: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), {
						httpHeaderAuth: { ...reference(credentials.owner), __aiGatewayManaged: true },
					}),
				],
				newNodeWithManagedAndOwnerCredentials: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), {
						httpHeaderAuth: { id: null, name: 'Managed', __aiGatewayManaged: true },
						httpBasicAuth: reference(credentials.owner),
					}),
				],
				newOwnerNodeThenNullNode: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					httpNode('new', credentials.owner),
					withCredentials(httpNode('null', credentials.owner), { httpHeaderAuth: null }),
				],
				nullNodeThenNewOwnerNode: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('null', credentials.owner), { httpHeaderAuth: null }),
					httpNode('new', credentials.owner),
				],
				editedOwnerNodeThenNullNode: [
					trigger,
					...others,
					httpNode('owner', credentials.owner, changed),
					withCredentials(httpNode('null', credentials.owner), { httpHeaderAuth: null }),
				],
				disabledOwnerNodeWithMemberACredential: [
					trigger,
					...others,
					{
						...withCredentials(httpNode('owner', credentials.owner, changed), {
							httpHeaderAuth: reference(credentials.memberA),
						}),
						disabled: true,
					},
				],
				newGlobalNode: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					httpNode('new', credentials.global),
				],
				newNodeWithMissingCredential: [
					trigger,
					...others,
					httpNode('owner', credentials.owner),
					withCredentials(httpNode('new', credentials.owner), {
						httpHeaderAuth: { id: 'missing-credential', name: 'missing' },
					}),
				],
				unchanged: [
					trigger,
					httpNode('alpha', credentials.alpha),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
				],
				editedOwnerNode: [
					trigger,
					httpNode('alpha', credentials.alpha),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner, 'https://changed.example'),
					httpNode('global', credentials.global),
				],
				editedAlphaNode: [
					trigger,
					httpNode('alpha', credentials.alpha, 'https://changed.example'),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
				],
				removedOwnerNode: [
					trigger,
					httpNode('alpha', credentials.alpha),
					httpNode('beta', credentials.beta),
					httpNode('global', credentials.global),
				],
				newOwnerNodeById: [
					trigger,
					httpNode('alpha', credentials.alpha),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
					httpNode('new', credentials.owner),
				],
				newOwnerNodeByName: [
					trigger,
					httpNode('alpha', credentials.alpha),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
					httpNode('new', 'owner credential'),
				],
				newMemberANode: [
					trigger,
					httpNode('alpha', credentials.alpha),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
					httpNode('new', credentials.memberA),
				],
				ownerCredentialOnAlphaNode: [
					trigger,
					httpNode('alpha', credentials.owner),
					httpNode('beta', credentials.beta),
					httpNode('owner', credentials.owner),
					httpNode('global', credentials.global),
				],
			};
		};
		for (const [change, nodes] of Object.entries(alphaNodes())) {
			for (const userLabel of [
				'owner',
				'memberA',
				'memberB',
				'memberC',
				'memberD',
				'globalViewer',
			] as const) {
				outcomes[`preventTampering alphaWorkflow ${change} by ${userLabel}`] = await read(
					async () => {
						const input = { name: 'renamed', nodes, connections: {} } as unknown as WorkflowEntity;
						const result = await workflowService.preventTampering(
							input,
							id('alphaWorkflow'),
							user(userLabel),
						);
						// The callers in workflow.service.ts use the input, not the result.
						const { nodes: resultNodes, ...rest } = result;
						return {
							returnsInput: result === input,
							workflow: line(rest),
							nodes: resultNodes.map(line),
						};
					},
				);
			}
		}
		outcomes['preventTampering of a missing workflow'] = await read(
			async () =>
				await workflowService.preventTampering(
					{ name: 'renamed', nodes: [trigger], connections: {} } as unknown as WorkflowEntity,
					id('missingWorkflow'),
					user('memberB'),
				),
		);
		for (const userLabel of ['owner', 'memberA'] as const) {
			outcomes[`preventTampering namedWorkflow editedNamedNode by ${userLabel}`] = await read(
				async () =>
					await workflowService.preventTampering(
						{
							name: 'renamed',
							nodes: [trigger, httpNode('named', 'owner credential', 'https://changed.example')],
							connections: {},
						} as unknown as WorkflowEntity,
						id('namedWorkflow'),
						user(userLabel),
					),
			);
		}
		// preventTampering for each workflow and user: an edit of each node with a credential, and a
		// new node with each credential.
		const changedUrl = 'https://changed.example';
		for (const workflow of WORKFLOW_LABELS) {
			const stored = await loadWorkflow(id(workflow));
			for (const userLabel of [
				'owner',
				'admin',
				'memberA',
				'memberB',
				'memberC',
				'memberD',
				'globalViewer',
			] as const) {
				outcomes[`preventTampering ${workflow} edits by ${userLabel}`] = await read(async () => {
					const nodes = stored.nodes.map((node) =>
						node.credentials
							? { ...node, parameters: { ...node.parameters, url: changedUrl } }
							: node,
					);
					const result = await workflowService.preventTampering(
						{ name: 'renamed', nodes, connections: {} } as unknown as WorkflowEntity,
						id(workflow),
						user(userLabel),
					);
					return Object.fromEntries(
						(result.nodes ?? [])
							.filter((node) => node.credentials)
							.map((node) => [node.name, node.parameters.url === changedUrl ? 'kept' : 'reverted']),
					);
				});
				for (const credential of Object.keys(fixture.credentials)) {
					outcomes[`preventTampering ${workflow} new ${credential} node by ${userLabel}`] =
						await read(async () => {
							await workflowService.preventTampering(
								{
									name: 'renamed',
									nodes: [...stored.nodes, httpNode('new', fixture.credentials[credential])],
									connections: {},
								} as unknown as WorkflowEntity,
								id(workflow),
								user(userLabel),
							);
							return 'allowed';
						});
				}
			}
		}
		// preventTampering of a workflow whose nodes have no ids.
		{
			const { credentials } = fixture;
			const plain = (node: INode) => {
				const { id: _, ...rest } = node;
				return rest as INode;
			};
			const idless = {
				newOwnerNodeWithoutId: [
					plain(trigger),
					plain(httpNode('alpha', credentials.alpha)),
					plain(httpNode('owner', credentials.owner)),
					plain(httpNode('new', credentials.owner)),
				],
				newAlphaNodeWithoutId: [
					plain(trigger),
					plain(httpNode('alpha', credentials.alpha)),
					plain(httpNode('owner', credentials.owner)),
					plain(httpNode('new', credentials.alpha)),
				],
				renamedOwnerNodeWithoutId: [
					plain(trigger),
					plain(httpNode('alpha', credentials.alpha)),
					{ ...plain(httpNode('owner', credentials.owner, changedUrl)), name: 'HTTP renamed' },
				],
				ownerNodeFirstWithoutId: [
					plain(httpNode('owner', credentials.owner, changedUrl)),
					plain(trigger),
					plain(httpNode('alpha', credentials.alpha)),
				],
				ownerNodeWithIdNow: [
					plain(trigger),
					plain(httpNode('alpha', credentials.alpha)),
					httpNode('owner', credentials.owner, changedUrl),
				],
			};
			for (const [change, nodes] of Object.entries(idless)) {
				for (const userLabel of ['owner', 'memberA', 'memberD'] as const) {
					outcomes[`preventTampering idlessWorkflow ${change} by ${userLabel}`] = await read(
						async () =>
							await workflowService.preventTampering(
								{ name: 'renamed', nodes, connections: {} } as unknown as WorkflowEntity,
								id('idlessWorkflow'),
								user(userLabel),
							),
					);
				}
			}
		}
		outcomes['preventTampering of a missing workflow with a missing credential'] = await read(
			async () =>
				await workflowService.preventTampering(
					{
						name: 'renamed',
						nodes: [{ ...trigger, credentials: { httpHeaderAuth: null } }],
						connections: {},
					} as unknown as WorkflowEntity,
					id('missingWorkflow'),
					user('memberB'),
				),
		);
		outcomes['preventTampering of a missing workflow without nodes'] = await read(
			async () =>
				await workflowService.preventTampering(
					{ name: 'renamed' } as unknown as WorkflowEntity,
					id('missingWorkflow'),
					user('memberB'),
				),
		);
		outcomes['preventTampering without nodes'] = await read(
			async () =>
				await workflowService.preventTampering(
					{ name: 'renamed' } as unknown as WorkflowEntity,
					id('alphaWorkflow'),
					user('memberB'),
				),
		);

		// preventTampering with duplicate ids and names, and references by name.
		{
			const { credentials } = fixture;
			const changedUrl2 = 'https://changed.example';
			const trig = trigger;
			const alphaN = httpNode('alpha', credentials.alpha);
			const betaN = httpNode('beta', credentials.beta);
			const ownerN = httpNode('owner', credentials.owner);
			const globalN = httpNode('global', credentials.global);
			const named = (node: INode, name: string) => ({ ...node, name });
			const withId = (node: INode, nodeId: string) => ({ ...node, id: nodeId });
			const changedOwner = httpNode('owner', credentials.owner, changedUrl2);
			const summary = (nodes: INode[] = []) =>
				nodes.map((node) =>
					[
						node.id ?? '<none>',
						node.name,
						JSON.stringify(node.credentials ?? null),
						(node.parameters as { url?: string }).url ?? '-',
					].join(' | '),
				);
			const probes: Record<string, INode[]> = {
				D2ownerRenamedAlpha: [trig, alphaN, betaN, named(changedOwner, 'HTTP alpha'), globalN],
				D3ownerRenamedAlphaWithoutAlpha: [trig, betaN, named(changedOwner, 'HTTP alpha'), globalN],
				D4sameIdNoCredentialsBefore: [
					trig,
					alphaN,
					betaN,
					withId(named(trig, 'X'), 'owner'),
					changedOwner,
					globalN,
				],
				D5sameIdNoCredentialsAfter: [
					trig,
					alphaN,
					betaN,
					changedOwner,
					withId(named(trig, 'X'), 'owner'),
					globalN,
				],
				D6sameIdOwnerCredentialAfter: [
					trig,
					alphaN,
					betaN,
					changedOwner,
					named(ownerN, 'HTTP x'),
					globalN,
				],
				D7sameIdOwnerCredentialBefore: [
					trig,
					alphaN,
					betaN,
					named(ownerN, 'HTTP x'),
					changedOwner,
					globalN,
				],
				D8triggerWithOwnerIdBefore: [withId(trig, 'owner'), alphaN, betaN, changedOwner, globalN],
				D9triggerWithOwnerIdAfter: [alphaN, betaN, changedOwner, globalN, withId(trig, 'owner')],
				D10alphaRenamedOwner: [trig, named(alphaN, 'HTTP owner'), betaN, changedOwner, globalN],
				D11sameIdGammaAfter: [
					trig,
					alphaN,
					betaN,
					named(changedOwner, 'HTTP a'),
					{
						...named(ownerN, 'HTTP b'),
						credentials: { oAuth2Api: { id: credentials.gamma.id, name: 'g' } },
					},
					globalN,
				],
				D12sameIdGammaBefore: [
					trig,
					alphaN,
					betaN,
					{
						...named(ownerN, 'HTTP b'),
						credentials: { oAuth2Api: { id: credentials.gamma.id, name: 'g' } },
					},
					named(changedOwner, 'HTTP a'),
					globalN,
				],
				S1endUserByName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{ ...httpNode('n1', 'end-user credential') },
				],
				S2alphaByName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{ ...httpNode('n1', 'alpha credential') },
				],
				S3gammaByName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{ ...httpNode('n1', 'gamma credential') },
				],
				S4alphaWithoutCredentials: [
					trig,
					{ ...alphaN, credentials: undefined },
					betaN,
					ownerN,
					globalN,
				],
				N1nullIdUnknownName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{
						...httpNode('new', 'x'),
						credentials: { httpHeaderAuth: { id: null, name: 'x' } },
					} as unknown as INode,
				],
				N2nullIdAlphaName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{
						...httpNode('new', 'x'),
						credentials: { httpHeaderAuth: { id: null, name: 'alpha credential' } },
					} as unknown as INode,
				],
				N3idlessNullIdOwnerName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					withoutNodeId({
						...httpNode('new', 'x'),
						credentials: { httpHeaderAuth: { id: null, name: 'owner credential' } },
					} as unknown as INode),
				],
				N4idlessNullIdUnknownName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					withoutNodeId({
						...httpNode('new', 'x'),
						credentials: { httpHeaderAuth: { id: null, name: 'x' } },
					} as unknown as INode),
				],
				N5emptyIdUnknownName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{ ...httpNode('new', 'x'), credentials: { httpHeaderAuth: { id: '', name: 'x' } } },
				],
				N6nullIdOwnerNameOtherType: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{
						...httpNode('new', 'x'),
						credentials: { httpBasicAuth: { id: null, name: 'owner credential' } },
					} as unknown as INode,
				],
				N7nullIdGlobalName: [
					trig,
					alphaN,
					betaN,
					ownerN,
					globalN,
					{
						...httpNode('new', 'x'),
						credentials: { httpHeaderAuth: { id: null, name: 'global credential' } },
					} as unknown as INode,
				],
				U1duplicateOtherIdWithChangedOwner: [
					trig,
					alphaN,
					betaN,
					changedOwner,
					globalN,
					withId(named(trig, 'X'), 'beta'),
				],
				U2duplicateOtherIdWithChangedAlpha: [
					trig,
					httpNode('alpha', credentials.alpha, changedUrl2),
					betaN,
					ownerN,
					globalN,
					withId(named(trig, 'X'), 'beta'),
				],
				U3duplicateTriggerIds: [trig, alphaN, betaN, changedOwner, globalN, named(trig, 'X')],
			};
			for (const [probe, nodes] of Object.entries(probes)) {
				for (const userLabel of ['memberA', 'memberD'] as const) {
					outcomes[`preventTampering probe ${probe} by ${userLabel}`] = await read(async () => {
						const input = {
							name: 'renamed',
							nodes: nodes.map(deepCopyNode),
							connections: {},
						} as unknown as WorkflowEntity;
						const result = await workflowService.preventTampering(
							input,
							id('alphaWorkflow'),
							user(userLabel),
						);
						return summary(result.nodes);
					});
				}
			}
		}

		// Credentials in node parameters: inline agents and inline sub-workflows.
		{
			const { credentials } = fixture;
			const stored = (await loadWorkflow(id('agentWorkflow'))).nodes;
			const managed = { id: null, name: 'Managed', __aiGatewayManaged: true } as const;
			const describeNodes = (nodes: INode[] = []) =>
				nodes.map((node) =>
					[node.name, (node.parameters as { edited?: boolean }).edited ? 'edited' : 'stored'].join(
						' | ',
					),
				);
			const updates: Record<string, () => INode[]> = {
				editAll: () =>
					stored.map((node) =>
						node.id === 'trigger'
							? deepCopyNode(node)
							: { ...deepCopyNode(node), parameters: { ...node.parameters, edited: true } },
					),
				newAgentOwner: () => [...stored, agentNode('n', 'New', agentConfig(credentials.owner.id))],
				newAgentAlpha: () => [...stored, agentNode('n', 'New', agentConfig(credentials.alpha.id))],
				newAgentGlobal: () => [
					...stored,
					agentNode('n', 'New', agentConfig(credentials.global.id)),
				],
				newAgentMissing: () => [
					...stored,
					agentNode('n', 'New', agentConfig('missing-credential')),
				],
				newAgentEmpty: () => [...stored, agentNode('n', 'New', agentConfig(''))],
				newAgentWithoutCredential: () => [...stored, agentNode('n', 'New', agentConfig(undefined))],
				newAgentJsonOwner: () => [
					...stored,
					agentNode('n', 'New', JSON.stringify(agentConfig(credentials.owner.id))),
				],
				newAgentJsonAlpha: () => [
					...stored,
					agentNode('n', 'New', JSON.stringify(agentConfig(credentials.alpha.id))),
				],
				newAgentMalformedJson: () => [...stored, agentNode('n', 'New', '{not json')],
				newAgentToolOwner: () => [
					...stored,
					agentNode('n', 'New', agentConfig(credentials.alpha.id, [nodeTool(credentials.owner)])),
				],
				newAgentToolAlpha: () => [
					...stored,
					agentNode('n', 'New', agentConfig(credentials.alpha.id, [nodeTool(credentials.alpha)])),
				],
				newAgentToolManaged: () => [
					...stored,
					agentNode('n', 'New', agentConfig(credentials.alpha.id, [nodeTool(managed)])),
				],
				newAgentReferencedWithOwner: () => [
					...stored,
					agentNode('n', 'New', agentConfig(credentials.owner.id), { agentSource: 'referenced' }),
				],
				newOtherTypeWithInlineAgentOwner: () => [
					...stored,
					{
						...agentNode('n', 'New', agentConfig(credentials.owner.id)),
						type: 'n8n-nodes-base.set',
					},
				],
				newSubOwner: () => [...stored, subWorkflowNode('n', 'New', credentials.owner)],
				newSubAlpha: () => [...stored, subWorkflowNode('n', 'New', credentials.alpha)],
				newNestedSubOwner: () => [
					...stored,
					subWorkflowNode('n', 'New', credentials.owner, 'n8n-nodes-base.executeWorkflow', 3),
				],
				newWorkflowToolOwner: () => [
					...stored,
					subWorkflowNode('n', 'New', credentials.owner, '@n8n/n8n-nodes-langchain.toolWorkflow'),
				],
				newOtherTypeWithWorkflowJsonOwner: () => [
					...stored,
					subWorkflowNode('n', 'New', credentials.owner, 'n8n-nodes-base.set'),
				],
				newSubNullId: () => [
					...stored,
					subWorkflowNode('n', 'New', { id: null, name: 'x' } as unknown as CredentialReference),
				],
				newSubManaged: () => [...stored, subWorkflowNode('n', 'New', managed)],
				newRetrieverOwner: () => [
					...stored,
					subWorkflowNode(
						'n',
						'New',
						credentials.owner,
						'@n8n/n8n-nodes-langchain.retrieverWorkflow',
					),
				],
				newSubWorkflowJsonObject: () => [
					...stored,
					{
						...subWorkflowNode('n', 'New', credentials.owner),
						parameters: {
							source: 'parameter',
							workflowJson: {
								nodes: [
									{
										name: 'Inner',
										credentials: { httpHeaderAuth: toReference(credentials.owner) },
									},
								],
							},
						} as unknown as INode['parameters'],
					},
				],
				newAgentToolNullId: () => [
					...stored,
					agentNode(
						'n',
						'New',
						agentConfig(credentials.alpha.id, [
							nodeTool({ id: null, name: 'x' } as unknown as CredentialReference),
						]),
					),
				],
				newAgentToolEmptyId: () => [
					...stored,
					agentNode(
						'n',
						'New',
						agentConfig(credentials.alpha.id, [nodeTool({ id: '', name: 'x' })]),
					),
				],
				newAgentCredentialNull: () => [
					...stored,
					agentNode('n', 'New', {
						config: { ...agentConfig(undefined).config, credential: null },
					}),
				],
				newAgentCredentialNumber: () => [
					...stored,
					agentNode('n', 'New', { config: { ...agentConfig(undefined).config, credential: 5 } }),
				],
				newAgentToolsNotArray: () => [
					...stored,
					agentNode('n', 'New', {
						config: { ...agentConfig(credentials.alpha.id).config, tools: 'x' },
					}),
				],
				newAgentWithoutConfig: () => [...stored, agentNode('n', 'New', { skills: {} })],
				newAgentInlineNull: () => [...stored, agentNode('n', 'New', null)],
				newManagedTopLevel: () => [
					...stored,
					{
						...httpNode('n', credentials.alpha),
						name: 'New',
						credentials: { httpHeaderAuth: managed },
					},
				],
				agentOwnerToAlpha: () =>
					stored.map((node) =>
						node.id === 'agent-owner'
							? agentNode('agent-owner', 'Agent owner', agentConfig(credentials.alpha.id))
							: deepCopyNode(node),
					),
				agentAlphaToOwner: () =>
					stored.map((node) =>
						node.id === 'agent-alpha'
							? agentNode('agent-alpha', 'Agent alpha', agentConfig(credentials.owner.id))
							: deepCopyNode(node),
					),
				removedOwnerAgents: () =>
					stored.filter((node) => !['agent-owner', 'agent-json-owner'].includes(node.id)),
			};
			for (const [update, build] of Object.entries(updates)) {
				for (const userLabel of ['owner', 'memberA', 'memberB', 'memberD'] as const) {
					outcomes[`preventTampering agentWorkflow ${update} by ${userLabel}`] = await read(
						async () => {
							const input = {
								name: 'renamed',
								nodes: build().map(deepCopyNode),
								connections: {},
							} as unknown as WorkflowEntity;
							const result = await workflowService.preventTampering(
								input,
								id('agentWorkflow'),
								user(userLabel),
							);
							return describeNodes(result.nodes);
						},
					);
				}
				outcomes[`collectCredentialReferences agentWorkflow ${update}`] = await read(async () => {
					// Only the trigger and the new node, so that the stored nodes add no references.
					const built = build();
					const nodes = update.startsWith('new') ? [trigger, built[built.length - 1]] : built;
					const { ids, hasUnresolved } = workflowService.collectCredentialReferences({
						nodes,
					} as WorkflowEntity);
					return { ids: [...ids].map(labelString).sort(), hasUnresolved };
				});
			}
		}

		// preventTampering of the default workflow of the test helper, shared with a member.
		{
			const stored = (await loadWorkflow(id('ownerSharedWorkflow'))).nodes;
			const { credentials } = fixture;
			const plain = (node: INode) => {
				const copy = deepCopyNode(node);
				delete copy.credentials;
				return copy;
			};
			const added: Record<string, INode> = {
				httpWithoutCredentials: plain(httpNode('m1', 'x')),
				setNode: {
					id: 'set-1',
					name: 'Set',
					type: 'n8n-nodes-base.set',
					typeVersion: 1,
					position: [200, 0],
					parameters: {},
				},
				triggerCopy: { ...deepCopyNode(stored[0]), id: 'uuid-5678', name: 'Schedule Trigger 2' },
				memberANode: httpNode('m1', credentials.memberA),
				ownerNode: httpNode('m1', credentials.owner),
				globalNode: httpNode('m1', credentials.global),
			};
			for (const [name, node] of Object.entries(added)) {
				for (const userLabel of ['owner', 'memberA', 'memberB'] as const) {
					outcomes[`preventTampering ownerSharedWorkflow adds ${name} by ${userLabel}`] =
						await read(async () => {
							const result = await workflowService.preventTampering(
								{
									name: 'renamed',
									nodes: [...stored.map(deepCopyNode), deepCopyNode(node)],
									connections: {},
								} as unknown as WorkflowEntity,
								id('ownerSharedWorkflow'),
								user(userLabel),
							);
							return (result.nodes ?? []).map(
								(n) => `${n.name} ${JSON.stringify(n.credentials ?? null)}`,
							);
						});
				}
			}
		}

		// preventTampering of updates without credentials that add nodes.
		{
			const bare = (nodeId: string, name: string) =>
				withoutNodeId({
					...httpNode(nodeId, 'x'),
					id: nodeId,
					name,
					credentials: undefined,
				} as INode);
			const plainNode = (nodeId: string, name: string) => {
				const node = { ...httpNode(nodeId, 'x'), name } as Partial<INode>;
				delete node.credentials;
				return node as INode;
			};
			const additions: Record<string, (stored: INode[]) => INode[]> = {
				oneMore: (stored) => [...stored, plainNode('m1', 'HTTP m1')],
				twoMore: (stored) => [...stored, plainNode('m1', 'HTTP m1'), plainNode('m2', 'HTTP m2')],
				oneMoreWithoutId: (stored) => [...stored, bare('m1', 'HTTP m1')],
				sameCount: (stored) => stored.map((node) => ({ ...node, name: `${node.name} renamed` })),
			};
			for (const workflow of ['emptyWorkflow', 'alphaWorkflow', 'memberBWorkflow']) {
				const stored = (await loadWorkflow(id(workflow))).nodes;
				for (const [change, build] of Object.entries(additions)) {
					for (const userLabel of ['owner', 'memberA', 'memberD', 'chatUser'] as const) {
						outcomes[`preventTampering ${workflow} ${change} without credentials by ${userLabel}`] =
							await read(async () => {
								const nodes = build(stored.map(deepCopyNode)).map((node) =>
									workflow === 'emptyWorkflow' ? node : node,
								);
								const result = await workflowService.preventTampering(
									{ name: 'renamed', nodes, connections: {} } as unknown as WorkflowEntity,
									id(workflow),
									user(userLabel),
								);
								return (result.nodes ?? []).map((node) => node.name);
							});
					}
				}
			}
		}

		// preventTampering with random updates: a fixed seed, so each run makes the same cases.
		{
			let seedState = 20261007;
			const random = () => {
				seedState = (seedState + 0x6d2b79f5) | 0;
				let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
			const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
			const credentialList = Object.values(fixture.credentials);
			const credentialValue = (): unknown =>
				pick([
					() => ({ id: pick(credentialList).id, name: 'x' }),
					() => {
						const credential = pick(credentialList);
						return { id: credential.id, name: credential.name };
					},
					() => pick(credentialList).name,
					() => ({ id: null, name: 'x' }),
					() => ({ id: null, name: 'Managed', __aiGatewayManaged: true }),
					() => ({ id: 'missing-credential', name: 'missing' }),
				])();
			const randomCredentials = () => {
				const result: Record<string, unknown> = {};
				const count = pick([0, 1, 1, 1, 2]);
				for (let index = 0; index < count; index++) {
					result[pick(['httpHeaderAuth', 'httpBasicAuth', 'oAuth2Api'])] = credentialValue();
				}
				return result;
			};
			const mutate = (node: INode): INode[] => {
				const copy = deepCopyNode(node);
				switch (
					pick([
						'keep',
						'keep',
						'param',
						'name',
						'id',
						'noId',
						'cred',
						'noCred',
						'addCred',
						'disable',
						'remove',
						'position',
					])
				) {
					case 'param':
						copy.parameters = { ...copy.parameters, url: 'https://changed.example' };
						break;
					case 'name':
						copy.name = pick(['HTTP renamed', 'HTTP alpha', 'HTTP owner', 'Manual Trigger']);
						break;
					case 'id':
						copy.id = pick(['x1', 'x2', 'alpha', 'owner', 'trigger']);
						break;
					case 'noId':
						delete (copy as Partial<INode>).id;
						break;
					case 'cred':
						copy.credentials = randomCredentials() as INode['credentials'];
						break;
					case 'noCred':
						delete copy.credentials;
						break;
					case 'addCred':
						copy.credentials = {
							...(copy.credentials ?? {}),
							oAuth2Api: credentialValue(),
						} as INode['credentials'];
						break;
					case 'disable':
						copy.disabled = pick([true, false]);
						break;
					case 'remove':
						return [];
					case 'position':
						copy.position = [999, 999];
						break;
				}
				return [copy];
			};
			const summarize = (nodes: INode[] = []) => nodes.map(line);
			const fuzzWorkflows = [
				'memberBWorkflow',
				'adminWorkflow',
				'alphaWorkflow',
				'personalWorkflow',
				'betaWorkflow',
				'ownerWorkflow',
				'idlessWorkflow',
				'namedWorkflow',
				'activeWorkflow',
				'folder2Workflow',
			];
			const stored = new Map<string, INode[]>();
			for (const workflow of fuzzWorkflows) {
				stored.set(workflow, (await loadWorkflow(id(workflow))).nodes);
			}
			for (let index = 0; index < 400; index++) {
				const workflow = pick(fuzzWorkflows);
				const userLabel = pick(USER_LABELS);
				let nodes = (stored.get(workflow) ?? []).flatMap(mutate);
				for (let added = pick([0, 0, 1, 2]); added > 0; added--) {
					const node: INode = {
						...httpNode(pick(['n1', 'n2', 'alpha', 'owner']), fixture.credentials.alpha),
						name: pick(['HTTP n1', 'HTTP n2', 'HTTP alpha', 'HTTP owner']),
						credentials: randomCredentials() as INode['credentials'],
					};
					if (random() < 0.3) delete (node as Partial<INode>).id;
					nodes.splice(Math.floor(random() * (nodes.length + 1)), 0, node);
				}
				if (random() < 0.2) nodes = [...nodes].reverse();
				const input = { name: 'renamed', nodes, connections: {} } as unknown as WorkflowEntity;
				outcomes[`preventTampering fuzz ${index}`] = await read(async () => {
					const before = summarize(input.nodes);
					const result = await workflowService.preventTampering(
						input,
						id(workflow),
						user(userLabel),
					);
					const after = summarize(result.nodes);
					return {
						workflow,
						user: userLabel,
						before,
						after: line(after) === line(before) ? 'unchanged' : after,
					};
				});
			}
		}

		outcomes['database changes'] = diffDumps(before, await dumpDb());
		expect(outcomes).toMatchSnapshot();
	}, 600_000);

	test('changing methods', async () => {
		const outcomes: Record<string, Outcome> = {};
		const denyProject = (project: string) => async () => {
			deniedProjects.add(id(project));
		};

		// shareWithProjects
		for (const [name, workflow, projects] of [
			['a personal project', 'alphaWorkflow', ['personal:memberD']],
			['personal and team projects', 'alphaWorkflow', ['personal:memberD', 'beta', 'gamma']],
			['the owner project', 'alphaWorkflow', ['alpha']],
			['a project that it is shared with', 'personalWorkflow', ['gamma']],
			['a missing project', 'alphaWorkflow', ['missing']],
			['nothing', 'alphaWorkflow', []],
			['a missing workflow', 'missingWorkflow', ['beta']],
			['the owner personal project', 'personalWorkflow', ['personal:memberA']],
			['a personal project that it is shared with', 'betaWorkflow', ['personal:memberC']],
			['a missing workflow with a personal project', 'missingWorkflow', ['personal:memberD']],
		] as const) {
			outcomes[`workflow shareWithProjects ${name}`] = await write(async () =>
				byProject(
					await inTransaction(
						async (trx) =>
							await workflowService.shareWithProjects(id(workflow), projects.map(id), trx),
					),
				),
			);
		}
		for (const [name, actor, credential, projects] of [
			['a personal project', 'memberA', 'alphaCredential', ['personal:memberD']],
			[
				'personal and team projects',
				'memberA',
				'alphaCredential',
				['personal:memberD', 'beta', 'gamma'],
			],
			['the owner project', 'memberA', 'alphaCredential', ['alpha']],
			['a project that it is shared with', 'memberB', 'betaCredential', ['alpha']],
			['a missing project', 'owner', 'ownerCredential', ['missing']],
			['nothing', 'owner', 'ownerCredential', []],
			['by a user who cannot share', 'memberC', 'alphaCredential', ['beta']],
			['by a user without the share scope', 'memberC', 'alphaCredential', ['personal:memberD']],
			['a team project with a viewer role', 'memberC', 'alphaCredential', ['gamma']],
			['the owner personal project', 'memberA', 'memberACredential', ['personal:memberA']],
			[
				'a personal project that it is shared with',
				'memberA',
				'memberACredential',
				['personal:memberB'],
			],
			['a missing credential', 'owner', 'missingCredential', ['beta']],
			[
				'an end-user credential to a personal project',
				'memberA',
				'endUserCredential',
				['personal:memberD'],
			],
			['the personal project of the user', 'memberA', 'alphaCredential', ['personal:memberA']],
			['a team project that the owner is not in', 'owner', 'ownerCredential', ['beta']],
			['a team project by a global viewer', 'globalViewer', 'alphaCredential', ['beta']],
			['an instance credential', 'owner', 'instanceCredential', ['personal:memberD']],
			['by a user without access', 'memberD', 'alphaCredential', ['personal:memberD']],
		] as const) {
			outcomes[`credential shareWithProjects ${name}`] = await write(async () =>
				byProject(
					await inTransaction(
						async (trx) =>
							await credentialsService.shareWithProjects(
								user(actor),
								id(credential),
								projects.map(id),
								trx,
							),
					),
				),
			);
		}
		// Which role in the team project lets a user share with it.
		for (const role of [
			'workflowReader',
			'projectReader',
			'projectLister',
			'credentialReader',
		] as const) {
			outcomes[`credential shareWithProjects a team project with the custom role ${role}`] =
				await write(
					async () =>
						await inTransaction(
							async (trx) =>
								await credentialsService.shareWithProjects(
									user('memberD'),
									id('betaCredential'),
									[id('gamma')],
									trx,
								),
						),
					async () => await setRole('memberD', 'gamma', customRole(role)),
				);
		}

		// transferOne
		for (const [name, actor, credential, destination] of [
			['to a team project', 'memberA', 'alphaCredential', 'gamma'],
			['to a personal project', 'memberA', 'alphaCredential', 'personal:memberA'],
			['by the owner', 'owner', 'alphaCredential', 'beta'],
			['to its own project', 'memberA', 'alphaCredential', 'alpha'],
			['to a project that it is shared with', 'memberB', 'betaCredential', 'alpha'],
			['to a missing project', 'memberA', 'alphaCredential', 'missing'],
			['to a project without access', 'memberA', 'alphaCredential', 'beta'],
			['to a project with a viewer role', 'memberA', 'alphaCredential', 'personal:memberC'],
			['by an editor', 'memberB', 'alphaCredential', 'beta'],
			['by a viewer', 'memberC', 'alphaCredential', 'gamma'],
			['a missing credential', 'owner', 'missingCredential', 'beta'],
			['a personal credential', 'memberA', 'memberACredential', 'alpha'],
			[
				'an end-user credential to a personal project',
				'memberA',
				'endUserCredential',
				'personal:memberA',
			],
			['an end-user credential to a team project', 'memberA', 'endUserCredential', 'gamma'],
			['a global credential', 'owner', 'globalCredential', 'beta'],
			['a missing credential to a missing project', 'owner', 'missingCredential', 'missing'],
			[
				'an end-user credential to a team project by the owner',
				'owner',
				'endUserCredential',
				'beta',
			],
			['an end-user credential by a global viewer', 'globalViewer', 'endUserCredential', 'beta'],
			['an end-user credential to its own project', 'memberA', 'endUserCredential', 'alpha'],
			['an instance credential', 'owner', 'instanceCredential', 'beta'],
		] as const) {
			outcomes[`transferOne ${name}`] = await write(
				async () =>
					await credentialsService.transferOne(user(actor), id(credential), id(destination)),
			);
		}
		// Which roles let a user move a credential, and create it in the destination project.
		for (const [name, actor, credential, destination, roleChanges] of [
			[
				'with the custom role credentialMover in the source',
				'memberD',
				'alphaCredential',
				'personal:memberD',
				[['memberD', 'alpha', 'credentialMover']],
			],
			[
				'with the custom role credentialReaderMover in the source',
				'memberD',
				'alphaCredential',
				'personal:memberD',
				[['memberD', 'alpha', 'credentialReaderMover']],
			],
			[
				'with the custom role credentialCreator in the destination',
				'memberA',
				'alphaCredential',
				'gamma',
				[['memberA', 'gamma', 'credentialCreator']],
			],
			[
				'with the custom role credentialReader in the destination',
				'memberA',
				'alphaCredential',
				'gamma',
				[['memberA', 'gamma', 'credentialReader']],
			],
			[
				'to its own project with the custom role credentialMover',
				'memberD',
				'alphaCredential',
				'alpha',
				[['memberD', 'alpha', 'credentialMover']],
			],
			[
				'an end-user credential to its own project by a user who cannot manage it',
				'memberD',
				'endUserCredential',
				'alpha',
				[['memberD', 'alpha', 'credentialManager']],
			],
			[
				'an end-user credential by a mover who is admin of the destination',
				'memberD',
				'endUserCredential',
				'beta',
				[
					['memberD', 'alpha', 'credentialReaderMover'],
					['memberD', 'beta', 'project:admin'],
				],
			],
		] as const) {
			outcomes[`transferOne ${name}`] = await write(
				async () =>
					await credentialsService.transferOne(user(actor), id(credential), id(destination)),
				async () => {
					for (const [member, project, role] of roleChanges) {
						await setRole(
							member,
							project,
							role.startsWith('project:') ? role : customRole(role as CustomProjectRole),
						);
					}
				},
			);
		}

		outcomes['transferOne to a project that a policy denies'] = await write(
			async () =>
				await credentialsService.transferOne(user('memberA'), id('alphaCredential'), id('gamma')),
			denyProject('gamma'),
		);

		// transferWorkflow
		for (const [name, actor, workflow, destination, share, parentFolder] of [
			['to a team project', 'memberA', 'alphaWorkflow', 'gamma', undefined, undefined],
			[
				'with all credentials',
				'memberA',
				'alphaWorkflow',
				'gamma',
				['alphaCredential', 'betaCredential', 'ownerCredential', 'globalCredential'],
				undefined,
			],
			[
				'with the alpha credential',
				'memberA',
				'alphaWorkflow',
				'gamma',
				['alphaCredential'],
				undefined,
			],
			[
				'by the owner with all credentials',
				'owner',
				'alphaWorkflow',
				'beta',
				['alphaCredential', 'betaCredential', 'ownerCredential', 'globalCredential'],
				undefined,
			],
			[
				'to a personal project',
				'memberA',
				'alphaWorkflow',
				'personal:memberA',
				undefined,
				undefined,
			],
			['to its own project', 'memberA', 'alphaWorkflow', 'alpha', undefined, undefined],
			['to a missing project', 'memberA', 'alphaWorkflow', 'missing', undefined, undefined],
			['to a project without access', 'memberA', 'alphaWorkflow', 'beta', undefined, undefined],
			['by an editor', 'memberB', 'alphaWorkflow', 'beta', undefined, undefined],
			['by a viewer', 'memberC', 'alphaWorkflow', 'gamma', undefined, undefined],
			['a missing workflow', 'owner', 'missingWorkflow', 'beta', undefined, undefined],
			['an active workflow', 'memberA', 'activeWorkflow', 'gamma', undefined, undefined],
			['into a folder', 'memberA', 'alphaWorkflow', 'gamma', undefined, 'gammaFolder'],
			['into the root folder', 'memberA', 'folder1Workflow', 'gamma', undefined, '0'],
			[
				'into a folder of another project',
				'memberA',
				'alphaWorkflow',
				'gamma',
				undefined,
				'betaFolder',
			],
			['into a missing folder', 'memberA', 'alphaWorkflow', 'gamma', undefined, 'missingFolder'],
			['a shared workflow', 'memberA', 'personalWorkflow', 'alpha', undefined, undefined],
			[
				'with an end-user credential to a personal project',
				'memberA',
				'folder1Workflow',
				'personal:memberA',
				['endUserCredential'],
				undefined,
			],
			[
				'to its own project into a missing folder',
				'memberA',
				'alphaWorkflow',
				'alpha',
				undefined,
				'missingFolder',
			],
			[
				'a missing workflow to a missing project',
				'owner',
				'missingWorkflow',
				'missing',
				undefined,
				undefined,
			],
			[
				'with a credential that it does not use',
				'memberA',
				'alphaWorkflow',
				'gamma',
				['memberACredential'],
				undefined,
			],
			[
				'to a project that it is shared with',
				'memberA',
				'personalWorkflow',
				'gamma',
				undefined,
				undefined,
			],
			[
				'by a global viewer',
				'globalViewer',
				'alphaWorkflow',
				'personal:globalViewer',
				undefined,
				undefined,
			],
			[
				'to its own project into another folder',
				'memberA',
				'alphaWorkflow',
				'alpha',
				undefined,
				'folder1',
			],
			[
				'to its own project from a folder',
				'memberA',
				'folder1Workflow',
				'alpha',
				undefined,
				undefined,
			],
			[
				'to its own project into its own folder',
				'memberA',
				'folder1Workflow',
				'alpha',
				undefined,
				'folder1',
			],
		] as const) {
			outcomes[`transferWorkflow ${name}`] = await write(
				async () =>
					await workflowService.transferWorkflow(
						user(actor),
						id(workflow),
						id(destination),
						share?.map(id),
						parentFolder ? (parentFolder === '0' ? '0' : id(parentFolder)) : undefined,
					),
			);
		}
		for (const [name, actor, destination, prepare] of [
			[
				'an archived workflow',
				'memberA',
				'gamma',
				async () => await archiveWorkflow('alphaWorkflow'),
			],
			[
				'with the custom role workflowMover in the source',
				'memberD',
				'personal:memberD',
				async () => await setRole('memberD', 'alpha', customRole('workflowMover')),
			],
			[
				'with the custom role workflowReaderMover in the source',
				'memberD',
				'personal:memberD',
				async () => await setRole('memberD', 'alpha', customRole('workflowReaderMover')),
			],
			[
				'to its own project with the custom role workflowMover',
				'memberD',
				'alpha',
				async () => await setRole('memberD', 'alpha', customRole('workflowMover')),
			],
			[
				'with the custom role workflowCreator in the destination',
				'memberA',
				'gamma',
				async () => await setRole('memberA', 'gamma', customRole('workflowCreator')),
			],
			[
				'with the custom role workflowReader in the destination',
				'memberA',
				'gamma',
				async () => await setRole('memberA', 'gamma', customRole('workflowReader')),
			],
		] as const) {
			outcomes[`transferWorkflow ${name}`] = await write(
				async () =>
					await workflowService.transferWorkflow(user(actor), id('alphaWorkflow'), id(destination)),
				prepare,
			);
		}
		outcomes['transferWorkflow within its project, a workflow with a share'] = await write(
			async () =>
				await workflowService.transferWorkflow(user('memberA'), id('folder1Workflow'), id('alpha')),
			async () => await shareWorkflow('folder1Workflow', 'personal:memberD'),
		);
		// The transfer policy of the destination project.
		const changeDraft = async () => {
			await Container.get(WorkflowRepository).update(id('activeWorkflow'), {
				nodes: [
					trigger,
					httpNode('alpha', fixture.credentials.alpha),
					{ ...trigger, id: 'draft', name: 'Draft only' },
				],
			});
		};
		for (const [name, workflow, destination, share, parentFolder, prepare] of [
			[
				'to a project that a policy denies',
				'alphaWorkflow',
				'gamma',
				[],
				undefined,
				denyProject('gamma'),
			],
			[
				'an active workflow to a project that a policy denies',
				'activeWorkflow',
				'gamma',
				[],
				undefined,
				denyProject('gamma'),
			],
			[
				'to its own project, denied by a policy',
				'alphaWorkflow',
				'alpha',
				[],
				undefined,
				denyProject('alpha'),
			],
			[
				'into a missing folder of a project that a policy denies',
				'alphaWorkflow',
				'gamma',
				[],
				'missingFolder',
				denyProject('gamma'),
			],
			[
				'with credentials to a project that a policy denies',
				'alphaWorkflow',
				'gamma',
				['alphaCredential'],
				undefined,
				denyProject('gamma'),
			],
			[
				'from a project that a policy denies',
				'alphaWorkflow',
				'gamma',
				[],
				undefined,
				denyProject('alpha'),
			],
			[
				'an active workflow with a changed draft',
				'activeWorkflow',
				'gamma',
				[],
				undefined,
				changeDraft,
			],
		] as const) {
			outcomes[`transferWorkflow ${name}`] = await write(
				async () =>
					await workflowService.transferWorkflow(
						user('memberA'),
						id(workflow),
						id(destination),
						share.map(id),
						parentFolder ? id(parentFolder) : undefined,
					),
				prepare,
			);
		}
		// preventTampering when the draft of a published workflow differs from its published version.
		const draftAlphaNode = async () => {
			await Container.get(WorkflowRepository).update(id('activeWorkflow'), {
				nodes: [trigger, httpNode('alpha', fixture.credentials.alpha, 'https://draft.example')],
			});
		};
		for (const [name, versionOf] of [
			['the published version', 'active'],
			['the draft version', 'draft'],
			['a missing version', 'missing'],
		] as const) {
			for (const userLabel of ['memberA', 'memberD'] as const) {
				outcomes[`preventTampering with the version id of ${name} by ${userLabel}`] = await write(
					async () => {
						const stored = await Container.get(WorkflowRepository).findOneByOrFail({
							id: id('activeWorkflow'),
						});
						const versionId =
							versionOf === 'active'
								? stored.activeVersionId
								: versionOf === 'draft'
									? stored.versionId
									: 'missing-version';
						return await workflowService.preventTampering(
							{
								name: 'renamed',
								versionId,
								nodes: [
									trigger,
									httpNode('alpha', fixture.credentials.alpha, 'https://changed.example'),
								],
								connections: {},
							} as unknown as WorkflowEntity,
							id('activeWorkflow'),
							user(userLabel),
						);
					},
					draftAlphaNode,
				);
			}
		}
		for (const userLabel of ['memberA', 'memberD'] as const) {
			outcomes[`preventTampering an active workflow whose draft differs by ${userLabel}`] =
				await write(
					async () =>
						await workflowService.preventTampering(
							{
								name: 'renamed',
								nodes: [
									trigger,
									httpNode('alpha', fixture.credentials.alpha, 'https://changed.example'),
								],
								connections: {},
							} as unknown as WorkflowEntity,
							id('activeWorkflow'),
							user(userLabel),
						),
					draftAlphaNode,
				);
		}
		outcomes['transferWorkflow without the sharing licence with credentials'] = await write(
			async () =>
				await withoutFeatures(
					['feat:sharing'],
					async () =>
						await workflowService.transferWorkflow(
							user('memberA'),
							id('alphaWorkflow'),
							id('gamma'),
							[id('alphaCredential')],
						),
				),
		);
		outcomes['transferWorkflow without the sharing licence'] = await write(
			async () =>
				await withoutFeatures(
					['feat:sharing'],
					async () =>
						await workflowService.transferWorkflow(
							user('memberA'),
							id('alphaWorkflow'),
							id('gamma'),
						),
				),
		);
		outcomes['transferWorkflow an active workflow that fails with an activation error'] =
			await write(async () => {
				activeWorkflowManager.add.mockRejectedValueOnce(
					new WorkflowActivationError('Activation failed', { workflowId: id('activeWorkflow') }),
				);
				return await workflowService.transferWorkflow(
					user('memberA'),
					id('activeWorkflow'),
					id('gamma'),
				);
			});
		outcomes['transferWorkflow an active workflow that fails to activate'] = await write(
			async () => {
				activeWorkflowManager.add.mockRejectedValueOnce(new Error('Activation failed'));
				return await workflowService.transferWorkflow(
					user('memberA'),
					id('activeWorkflow'),
					id('gamma'),
				);
			},
		);

		// transferFolder
		for (const [name, actor, source, folder, destination, parentFolder, share] of [
			['to a team project', 'memberA', 'alpha', 'folder1', 'gamma', '0', []],
			['a subfolder', 'memberA', 'alpha', 'folder2', 'gamma', '0', []],
			['into a folder', 'memberA', 'alpha', 'folder1', 'gamma', 'gammaFolder', []],
			[
				'with credentials',
				'memberA',
				'alpha',
				'folder1',
				'gamma',
				'0',
				['alphaCredential', 'endUserCredential', 'memberACredential'],
			],
			['by the owner', 'owner', 'alpha', 'folder1', 'beta', '0', ['alphaCredential']],
			['to a personal project', 'memberA', 'alpha', 'folder2', 'personal:memberA', '0', []],
			['to its own project', 'memberA', 'alpha', 'folder1', 'alpha', '0', []],
			['to a missing project', 'memberA', 'alpha', 'folder1', 'missing', '0', []],
			['to a project without access', 'memberA', 'alpha', 'folder1', 'beta', '0', []],
			['by an editor', 'memberB', 'alpha', 'folder1', 'beta', '0', []],
			['from the wrong project', 'memberA', 'gamma', 'folder1', 'alpha', '0', []],
			['a missing folder', 'memberA', 'alpha', 'missingFolder', 'gamma', '0', []],
			[
				'into a folder of another project',
				'memberA',
				'alpha',
				'folder1',
				'gamma',
				'betaFolder',
				[],
			],
			['into a missing folder', 'memberA', 'alpha', 'folder1', 'gamma', 'missingFolder', []],
			[
				'a missing folder to a missing project',
				'memberA',
				'alpha',
				'missingFolder',
				'missing',
				'0',
				[],
			],
			[
				'to its own project into a missing folder',
				'memberA',
				'alpha',
				'folder1',
				'alpha',
				'missingFolder',
				[],
			],
			[
				'with a credential that the folder does not use',
				'owner',
				'alpha',
				'folder1',
				'gamma',
				'0',
				['ownerCredential'],
			],
			['by a user without access to the source', 'memberD', 'alpha', 'folder1', 'beta', '0', []],
			[
				'with credentials by a user who cannot share them',
				'memberB',
				'alpha',
				'folder1',
				'beta',
				'0',
				['alphaCredential', 'memberACredential'],
			],
			['by a global viewer', 'globalViewer', 'alpha', 'folder1', 'personal:globalViewer', '0', []],
			[
				'a missing folder to its own project',
				'memberA',
				'alpha',
				'missingFolder',
				'alpha',
				'0',
				[],
			],
			[
				'a missing folder into a missing folder',
				'memberA',
				'alpha',
				'missingFolder',
				'gamma',
				'missingFolder',
				[],
			],
		] as const) {
			outcomes[`transferFolder ${name}`] = await write(
				async () =>
					await workflowService.transferFolder(
						user(actor),
						id(source),
						id(folder),
						id(destination),
						parentFolder === '0' ? '0' : id(parentFolder),
						share.map(id),
					),
			);
		}
		for (const [name, destination, prepare] of [
			[
				'a folder with a shared workflow',
				'gamma',
				async () => await shareWorkflow('folder2Workflow', 'personal:memberD'),
			],
			[
				'a folder with a workflow that is shared with the destination',
				'gamma',
				async () => await shareWorkflow('folder2Workflow', 'gamma'),
			],
			[
				'a folder with an archived workflow',
				'gamma',
				async () => await archiveWorkflow('folder2Workflow'),
			],
			[
				'with the custom role workflowCreator in the destination',
				'gamma',
				async () => await setRole('memberA', 'gamma', customRole('workflowCreator')),
			],
			[
				'with the custom role folderCreator in the destination',
				'gamma',
				async () => await setRole('memberA', 'gamma', customRole('folderCreator')),
			],
		] as const) {
			outcomes[`transferFolder ${name}`] = await write(
				async () =>
					await workflowService.transferFolder(
						user('memberA'),
						id('alpha'),
						id('folder1'),
						id(destination),
						'0',
						[],
					),
				prepare,
			);
		}
		const setOwner = async (workflow: string, project: string) => {
			await Container.get(SharedWorkflowRepository).update(
				{ workflowId: id(workflow), role: 'workflow:owner' },
				{ projectId: id(project) },
			);
		};
		for (const [name, source, folder, destination, parentFolder, prepare] of [
			['to a project that a policy denies', 'alpha', 'folder1', 'gamma', '0', denyProject('gamma')],
			[
				'to its own project, denied by a policy',
				'alpha',
				'folder1',
				'alpha',
				'0',
				denyProject('alpha'),
			],
			[
				'into a missing folder of a project that a policy denies',
				'alpha',
				'folder1',
				'gamma',
				'missingFolder',
				denyProject('gamma'),
			],
			['an empty folder to its own project', 'gamma', 'gammaFolder', 'gamma', '0', undefined],
			[
				'a folder with a workflow of the destination project',
				'alpha',
				'folder1',
				'gamma',
				'0',
				async () => await setOwner('folder2Workflow', 'gamma'),
			],
			[
				'a folder with a workflow of another project',
				'alpha',
				'folder1',
				'gamma',
				'0',
				async () => await setOwner('folder2Workflow', 'beta'),
			],
		] as const) {
			outcomes[`transferFolder ${name}`] = await write(
				async () =>
					await workflowService.transferFolder(
						user('memberA'),
						id(source),
						id(folder),
						id(destination),
						parentFolder === '0' ? '0' : id(parentFolder),
						[],
					),
				prepare,
			);
		}
		outcomes['transferFolder without the folders licence'] = await write(
			async () =>
				await withoutFeatures(
					['feat:folders'],
					async () =>
						await workflowService.transferFolder(
							user('memberA'),
							id('alpha'),
							id('folder1'),
							id('gamma'),
							'0',
							[],
						),
				),
		);
		outcomes['transferFolder with an active workflow that fails with an activation error'] =
			await write(async () => {
				activeWorkflowManager.add.mockRejectedValueOnce(
					new WorkflowActivationError('Activation failed', { workflowId: id('activeWorkflow') }),
				);
				return await workflowService.transferFolder(
					user('memberA'),
					id('alpha'),
					id('folder1'),
					id('gamma'),
					'0',
					[],
				);
			});
		outcomes['transferFolder with an active workflow that fails to activate'] = await write(
			async () => {
				activeWorkflowManager.add.mockRejectedValueOnce(new Error('Activation failed'));
				return await workflowService.transferFolder(
					user('memberA'),
					id('alpha'),
					id('folder1'),
					id('gamma'),
					'0',
					[],
				);
			},
		);

		expect(outcomes).toMatchSnapshot();
	}, 900_000);
});
