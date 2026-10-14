// Fork test (not in upstream n8n): a golden test of workflow reviews, end to end. It calls each
// route of `/workflow-review-requests` as the owner, an admin and members with each project role
// and with custom roles, publishes workflows that have an open review, archives, deletes and moves
// reviewed workflows, and records the status and the body of each answer, the rows of the review
// tables and of the workflow history, and the events and the push signals of each step. The
// snapshot was recorded against the original module of workflow reviews, and the fork module gives
// the same snapshot. See `packages/cli/src/modules/workflow-reviews/README.md`.
import {
	createTeamProject,
	createWorkflowHistory,
	createWorkflowWithTriggerAndHistory,
	linkUserToProject,
	mockInstance,
} from '@n8n/backend-test-utils';
import { EventService } from '@n8n/backend-services';
import { WorkflowsConfig } from '@n8n/config';
import type { Project, User, WorkflowEntity } from '@n8n/db';
import {
	GLOBAL_ADMIN_ROLE,
	GLOBAL_MEMBER_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRelationRepository,
	RoleRepository,
	UserRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { deepCopy } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { CollaborationService } from '@/collaboration/collaboration.service';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';
import { WorkflowService } from '@/workflows/workflow.service';
import { createFolder } from '@test-integration/db/folders';
import { createCustomRoleWithScopeSlugs } from '@test-integration/db/roles';
import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

mockInstance(ActiveWorkflowManager);

const testServer = utils.setupTestServer({
	endpointGroups: ['workflows', 'folder'],
	enabledFeatures: [
		'feat:sharing',
		'feat:folders',
		'feat:workflowReviews',
		'feat:namedVersions',
		'feat:customRoles',
		'feat:projectRole:admin',
		'feat:projectRole:editor',
		'feat:projectRole:viewer',
	],
	quotas: { 'quota:maxTeamProjects': -1 },
	modules: ['workflow-reviews'],
});

const BASE = '/workflow-review-requests';
const rec = new GoldenRecorder();

type Who =
	| 'owner'
	| 'admin'
	| 'requester'
	| 'reviewer'
	| 'editor2'
	| 'viewer2'
	| 'projAdmin'
	| 'outsider'
	| 'customUpdate'
	| 'customManage'
	| 'customRead'
	| 'customAdminLike'
	| 'projAdmin2'
	| 'projAdmin3'
	| 'zed'
	| 'leaver';

/**
 * Fixed user ids, in the reverse order of the emails. A list that the original sorts by user id
 * then differs from a list that it sorts by email or by name, and each run gives the same order.
 */
const USER_IDS: Record<Who | 'pending' | 'disabled', string> = Object.fromEntries(
	(
		[
			'zed',
			'viewer2',
			'reviewer',
			'requester',
			'projAdmin3',
			'projAdmin2',
			'projAdmin',
			'owner',
			'outsider',
			'leaver',
			'editor2',
			'customUpdate',
			'customRead',
			'customManage',
			'customAdminLike',
			'admin',
			'pending',
			'disabled',
		] as const
	).map((who, index) => [who, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]),
) as Record<Who | 'pending' | 'disabled', string>;

const users = {} as Record<Who, User>;
const agents = {} as Record<Who, SuperAgentTest>;
let pendingUser: User;
let disabledUser: User;
let project: Project;
let otherProject: Project;

let transcript: unknown[] = [];
let events: Array<{ name: string; payload: unknown }> = [];
let broadcasts: string[] = [];
let cursorCount = 0;
let requestCount = 0;

const READERS: Who[] = [
	'requester',
	'reviewer',
	'editor2',
	'viewer2',
	'projAdmin',
	'owner',
	'admin',
	'outsider',
	'customUpdate',
	'customManage',
	'customRead',
	'customAdminLike',
];

/** A user-like object becomes its label, so that a snapshot shows who, not the user record. */
function compactUsers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compactUsers);
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.id === 'string' && 'email' in record && 'role' in record) {
			return `user ${rec.labelString(record.id)}`;
		}
		return Object.fromEntries(
			Object.entries(record).map(([key, entry]) => {
				// Keep the snapshot readable: the names of the nodes tell which version it is.
				if (key === 'nodes' && Array.isArray(entry)) {
					return [
						key,
						entry.map((node: unknown) =>
							node !== null && typeof node === 'object' ? (node as { name?: string }).name : node,
						),
					];
				}
				// A hash of the whole workflow, with its random ids.
				if (key === 'checksum' && typeof entry === 'string') return [key, '<checksum>'];
				return [key, compactUsers(entry)];
			}),
		);
	}
	return value;
}

/** Labels of the cursors. A cursor is opaque, and it can be short: it gets a label only as a whole value. */
const cursorLabels = new Map<string, string>();

function cursorLabel(cursor: string) {
	let label = cursorLabels.get(cursor);
	if (!label) {
		label = `@cursor${++cursorCount}`;
		cursorLabels.set(cursor, label);
	}
	return label;
}

/** The cursors of an answer get labels in the order in which they come. */
function labelCursors(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(labelCursors);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				key === 'nextCursor' && typeof entry === 'string'
					? cursorLabel(entry)
					: labelCursors(entry),
			]),
		);
	}
	return value;
}

/** A copy of an event payload, so that later changes do not show. */
function copyPayload(payload: unknown): unknown {
	return payload !== null && typeof payload === 'object' ? deepCopy(payload) : payload;
}

/** Long texts (from the length checks) become their length. */
function shorten(value: unknown): unknown {
	if (typeof value === 'string' && value.length > 200) return `<${value.length} characters>`;
	if (Array.isArray(value)) return value.map(shorten);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry)]));
	}
	return value;
}

function cleanBody(body: unknown): unknown {
	if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
		const { stacktrace: _stack, ...rest } = body as Record<string, unknown>;
		return shorten(rec.normalize(compactUsers(labelCursors(rest))));
	}
	return shorten(rec.normalize(compactUsers(labelCursors(body))));
}

/** The url with labels, and the label of its cursor. */
function labelUrl(url: string) {
	const [path, search] = url.split('?');
	if (search === undefined) return rec.labelString(url);
	const params = search
		.split('&')
		.map((param) => {
			const [key, value = ''] = param.split('=');
			return key === 'cursor' && cursorLabels.has(value)
				? `${key}=${cursorLabel(value)}`
				: `${key}=${rec.labelString(value)}`;
		})
		.join('&');
	return `${rec.labelString(path)}?${params}`;
}

async function call(
	who: Who,
	method: 'get' | 'post' | 'put' | 'patch' | 'delete',
	url: string,
	body?: object,
) {
	const eventCount = events.length;
	const broadcastCount = broadcasts.length;
	const request = agents[who][method](url);
	const response = body === undefined ? await request : await request.send(body);
	await labelNewRequests();
	transcript.push({
		call: `${who} ${method.toUpperCase()} ${labelUrl(url)}`,
		...(body === undefined ? {} : { send: shorten(rec.normalize(compactUsers(body))) }),
		status: response.status,
		body: url.startsWith(BASE) ? cleanBody(response.body) : ordinaryBody(response),
		// The events and push signals of this call. They get their labels when the step ends.
		...(events.length > eventCount ? { events: events.splice(eventCount) } : {}),
		...(broadcasts.length > broadcastCount
			? { broadcasts: broadcasts.splice(broadcastCount) }
			: {}),
	});
	return response;
}

/**
 * The answers of the ordinary workflow and folder routes are long, and the reviews change only
 * their errors and the published version. So a success keeps only these fields.
 */
function ordinaryBody(response: { status: number; body: unknown }): unknown {
	if (response.status >= 400) return cleanBody(response.body);
	const data = dataOf(response);
	return rec.normalize({
		versionId: data.versionId,
		activeVersionId: data.activeVersionId,
		isArchived: data.isArchived,
	});
}

/** Record a direct call of an ordinary service, with its events and push signals. */
async function act(name: string, action: () => Promise<unknown>) {
	const eventCount = events.length;
	const broadcastCount = broadcasts.length;
	let outcome: unknown = 'done';
	try {
		await action();
	} catch (error) {
		outcome = rec.describeError(error);
	}
	await labelNewRequests();
	transcript.push({
		call: name,
		outcome,
		...(events.length > eventCount ? { events: events.splice(eventCount) } : {}),
		...(broadcasts.length > broadcastCount
			? { broadcasts: broadcasts.splice(broadcastCount) }
			: {}),
	});
}

/** The data of an answer, as the REST API wraps it. */
function dataOf(response: { body: unknown }): Record<string, unknown> {
	const body = response.body as { data?: Record<string, unknown> };
	return body.data ?? {};
}

async function query(sql: string) {
	return await Container.get(DataSource).query<Array<Record<string, unknown>>>(sql);
}

function parseJson(value: unknown) {
	if (typeof value === 'string' && /^[[{]/.test(value)) {
		try {
			return JSON.parse(value) as unknown;
		} catch {
			return value;
		}
	}
	return value;
}

/** Each review request without a label gets one, in the order in which it was made. */
async function labelNewRequests() {
	const rows = await query('SELECT id FROM workflow_review_request ORDER BY createdAt, id');
	for (const row of rows) {
		const id = String(row.id);
		if (!rec.labels.has(id)) rec.label(id, `R${++requestCount}`);
	}
}

/** The rows of the review tables, of the workflow history and of the publish history. */
async function dumpTables() {
	await labelNewRequests();
	const pick = (row: Record<string, unknown>, columns: string[]) =>
		Object.fromEntries(columns.map((column) => [column, parseJson(row[column])]));
	const tables: Record<string, unknown[]> = {};
	tables.requests = (
		await query('SELECT * FROM workflow_review_request ORDER BY createdAt, id')
	).map((row) =>
		pick(row, [
			'id',
			'projectId',
			'state',
			'decision',
			'title',
			'description',
			'createdById',
			'updatedById',
			'closedById',
			'approvedAt',
		]),
	);
	tables.links = (
		await query('SELECT * FROM workflow_review_request_workflow ORDER BY workflowReviewRequestId')
	).map((row) =>
		pick(row, ['workflowReviewRequestId', 'workflowId', 'workflowVersionId', 'baselineVersionId']),
	);
	tables.authors = await query(
		'SELECT workflowReviewRequestId, userId FROM workflow_review_request_authors',
	);
	tables.reviewers = await query(
		'SELECT workflowReviewRequestId, userId FROM workflow_review_request_reviewers',
	);
	tables.activity = (await query('SELECT * FROM workflow_review_activity ORDER BY id')).map((row) =>
		pick(row, ['id', 'workflowReviewRequestId', 'type', 'typeVersion', 'data', 'createdById']),
	);
	tables.comments = (await query('SELECT * FROM workflow_review_activity_comment ORDER BY id')).map(
		(row) => pick(row, ['id', 'activityId', 'createdById', 'body', 'history', 'updatedAt']),
	);
	tables.versions = (
		await query('SELECT * FROM workflow_history ORDER BY createdAt, versionId')
	).map((row) => pick(row, ['workflowId', 'versionId', 'name', 'description', 'autosaved']));
	tables.workflows = (await query('SELECT * FROM workflow_entity ORDER BY name')).map((row) =>
		pick(row, ['id', 'name', 'versionId', 'activeVersionId', 'active', 'isArchived']),
	);
	tables.publishHistory = (await query('SELECT * FROM workflow_publish_history ORDER BY id')).map(
		(row) => pick(row, ['workflowId', 'versionId', 'event', 'userId']),
	);
	tables.sharing = (
		await query(
			"SELECT workflowId, projectId, role FROM shared_workflow WHERE role = 'workflow:owner'",
		)
	).map((row) => row);
	// Sort the rows whose order comes from random ids, as it changes from run to run.
	for (const name of ['links', 'authors', 'reviewers', 'versions', 'sharing']) {
		tables[name] = (tables[name] as Array<Record<string, unknown>>)
			.map((row) => JSON.stringify(rec.normalize(row)))
			.sort()
			.map((row) => JSON.parse(row) as unknown);
	}
	return rec.normalize(tables);
}

let previousTables: Record<string, string[]> = {};

/** The rows that a step removed from or added to each table, as JSON lines. */
async function tableChanges() {
	const tables = (await dumpTables()) as Record<string, unknown[]>;
	const changes: Record<string, { removed?: string[]; added?: string[] }> = {};
	const current: Record<string, string[]> = {};
	for (const [name, rows] of Object.entries(tables)) {
		current[name] = rows.map((row) => JSON.stringify(row));
		const before = previousTables[name] ?? [];
		const removed = before.filter((row) => !current[name].includes(row));
		const added = current[name].filter((row) => !before.includes(row));
		if (removed.length > 0 || added.length > 0) {
			changes[name] = {
				...(removed.length > 0 ? { removed } : {}),
				...(added.length > 0 ? { added } : {}),
			};
		}
	}
	previousTables = current;
	return changes;
}

/** Record a step: its calls, its events and push signals, and the rows that it changed. */
async function snapshotStep() {
	// One JSON line for each call keeps the snapshot short and its diffs readable.
	const result = {
		transcript: (rec.normalize(compactUsers(transcript)) as unknown[]).map((entry) =>
			JSON.stringify(entry),
		),
		events: rec.normalize(compactUsers(events)),
		broadcasts: broadcasts.map((id) => rec.labelString(id)),
		tables: await tableChanges(),
	};
	transcript = [];
	events = [];
	broadcasts = [];
	expect(result).toMatchSnapshot();
}

async function makeUser(
	who: Who,
	firstName: string,
	role: typeof GLOBAL_MEMBER_ROLE = GLOBAL_MEMBER_ROLE,
) {
	const user = await createUser({
		id: USER_IDS[who],
		role,
		email: `${who.toLowerCase()}@reviews.test`,
		firstName,
		lastName: 'Test',
	});
	rec.label(user.id, who);
	users[who] = user;
	agents[who] = testServer.authAgentFor(user);
	return user;
}

async function makeWorkflow(
	name: string,
	label: string,
	attributes: Record<string, unknown> = {},
	home: Project = project,
) {
	const workflow = await createWorkflowWithTriggerAndHistory({ name, ...attributes }, home);
	rec.label(workflow.id, label);
	rec.label(workflow.versionId, `${label}.v1`);
	return workflow;
}

/** Save a new version of a workflow: a new node, a new version id and a history row. */
async function saveVersion(workflow: WorkflowEntity, versionLabel: string, user: User) {
	const versionId = uuid();
	const nodes = [
		...workflow.nodes,
		{
			id: `node-${versionLabel}`,
			name: `Set ${versionLabel}`,
			type: 'n8n-nodes-base.set',
			typeVersion: 1,
			position: [1000, 300] as [number, number],
			parameters: { options: {} },
		},
	];
	await Container.get(WorkflowRepository).update(workflow.id, { versionId, nodes });
	workflow.versionId = versionId;
	workflow.nodes = nodes;
	await createWorkflowHistory(workflow, user);
	rec.label(versionId, versionLabel);
	// Versions and reviews are ordered by their creation time.
	await new Promise((resolve) => setTimeout(resolve, 5));
	return versionId;
}

function createBody(
	workflow: WorkflowEntity,
	versionId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		title: `Review of ${workflow.name}`,
		description: 'Please check the trigger',
		workflows: [
			{
				workflowId: workflow.id,
				workflowVersionId: versionId,
				workflowVersionName: 'Release 1',
				workflowVersionDescription: 'First release',
			},
		],
		reviewerUserIds: [users.reviewer.id],
		...overrides,
	};
}

async function createReview(
	who: Who,
	workflow: WorkflowEntity,
	versionId: string,
	overrides: Record<string, unknown> = {},
) {
	const response = await call(who, 'post', BASE, createBody(workflow, versionId, overrides));
	await new Promise((resolve) => setTimeout(resolve, 5));
	return String(dataOf(response).id ?? '');
}

async function setProjectRole(user: User, role: string) {
	await Container.get(ProjectRelationRepository).update(
		{ projectId: project.id, userId: user.id },
		{ role: { slug: role } },
	);
}

describe('Workflow reviews (golden)', () => {
	beforeAll(async () => {
		Container.get(WorkflowsConfig).useWorkflowPublicationService = false;
		await utils.initNodeTypes();

		for (const row of await query('SELECT id FROM "user"')) {
			rec.label(String(row.id), 'shell owner');
		}

		await makeUser('owner', 'Olivia', GLOBAL_OWNER_ROLE);
		await makeUser('admin', 'Adam', GLOBAL_ADMIN_ROLE);
		await makeUser('requester', 'Rita');
		await makeUser('reviewer', 'Victor');
		await makeUser('editor2', 'Eddie');
		await makeUser('viewer2', 'Vera');
		await makeUser('projAdmin', 'Paula');
		await makeUser('outsider', 'Oscar');
		await makeUser('customUpdate', 'Ursula');
		await makeUser('customManage', 'Manuel');
		await makeUser('customRead', 'Rhea');
		await makeUser('customAdminLike', 'Ada');
		await makeUser('projAdmin2', 'Pia');
		await makeUser('projAdmin3', 'Pete');
		await makeUser('zed', 'Abe');
		await makeUser('leaver', 'Lea');

		pendingUser = await createUser({
			id: USER_IDS.pending,
			email: 'pending@reviews.test',
			firstName: 'Penny',
			lastName: 'Pending',
			password: null,
		});
		rec.label(pendingUser.id, 'pending');
		disabledUser = await createUser({
			id: USER_IDS.disabled,
			email: 'disabled@reviews.test',
			firstName: 'Dora',
			lastName: 'Disabled',
			disabled: true,
		});
		rec.label(disabledUser.id, 'disabled');

		project = await createTeamProject('Review Project', users.projAdmin);
		rec.label(project.id, 'project');
		otherProject = await createTeamProject('Other Project', users.projAdmin);
		rec.label(otherProject.id, 'otherProject');

		const editorRole = await Container.get(RoleRepository).findOneOrFail({
			where: { slug: 'project:editor' },
			relations: ['scopes'],
		});
		const editorScopes = editorRole.scopes.map((scope) => scope.slug);
		const updateRole = await createCustomRoleWithScopeSlugs([...editorScopes, 'project:update']);
		rec.label(updateRole.slug, 'role editor+project:update');
		const manageRole = await createCustomRoleWithScopeSlugs([
			...editorScopes,
			'project:manageMembers',
		]);
		rec.label(manageRole.slug, 'role editor+project:manageMembers');
		const readRole = await createCustomRoleWithScopeSlugs([
			'workflow:read',
			'workflow:list',
			'project:read',
			'project:list',
		]);
		rec.label(readRole.slug, 'role read');
		const adminRole = await Container.get(RoleRepository).findOneOrFail({
			where: { slug: 'project:admin' },
			relations: ['scopes'],
		});
		const adminLikeRole = await createCustomRoleWithScopeSlugs(
			adminRole.scopes.map((scope) => scope.slug),
		);
		rec.label(adminLikeRole.slug, 'role with the scopes of project:admin');

		await linkUserToProject(users.requester, project, 'project:editor');
		await linkUserToProject(users.reviewer, project, 'project:viewer');
		await linkUserToProject(users.editor2, project, 'project:editor');
		await linkUserToProject(users.viewer2, project, 'project:viewer');
		await linkUserToProject(pendingUser, project, 'project:viewer');
		await linkUserToProject(disabledUser, project, 'project:viewer');
		await linkUserToProject(users.customUpdate, project, updateRole.slug as 'project:editor');
		await linkUserToProject(users.customManage, project, manageRole.slug as 'project:editor');
		await linkUserToProject(users.customRead, project, readRole.slug as 'project:editor');
		await linkUserToProject(users.customAdminLike, project, adminLikeRole.slug as 'project:editor');
		await linkUserToProject(users.projAdmin2, project, 'project:admin');
		await linkUserToProject(users.projAdmin3, project, 'project:admin');
		await linkUserToProject(users.zed, project, 'project:editor');
		await linkUserToProject(users.leaver, project, 'project:editor');

		await Container.get(WorkflowReviewPolicyService).set(true);
	});

	// The test config restores all spies before each test, so each test sets them again.
	beforeEach(() => {
		const eventService = Container.get(EventService);
		const emit = eventService.emit.bind(eventService);
		vi.spyOn(eventService, 'emit').mockImplementation((name, payload) => {
			if (String(name).startsWith('workflow-review')) {
				events.push({ name: String(name), payload: copyPayload(payload) });
			} else if (['workflow-activated', 'workflow-deactivated'].includes(String(name))) {
				const { user, workflowId, source, publicApi } = payload as Record<string, unknown>;
				events.push({
					name,
					payload: rec.normalize(compactUsers({ user, workflowId, source, publicApi })),
				});
			}
			return emit(name, payload);
		});
		const collaboration = Container.get(CollaborationService);
		vi.spyOn(collaboration, 'broadcastWorkflowReviewStateChanged').mockImplementation(
			async (workflowId: string) => {
				broadcasts.push(workflowId);
			},
		);
	});

	let wf1: WorkflowEntity;
	let r1 = '';
	let wf1v1 = '';
	let wf1v2 = '';
	let wf1v3 = '';

	it('lists the eligible reviewers of a workflow', async () => {
		wf1 = await makeWorkflow('Workflow One', 'wf1');
		wf1v1 = wf1.versionId;
		for (const who of READERS) {
			await call(who, 'get', `${BASE}/eligible-reviewers?workflowId=${wf1.id}`);
		}
		await call('requester', 'get', `${BASE}/eligible-reviewers`);
		await call('requester', 'get', `${BASE}/eligible-reviewers?workflowId=unknownWorkflow1`);
		await snapshotStep();
	});

	it('checks the input of a new review', async () => {
		const wfVal = await makeWorkflow('Workflow Validation', 'wfVal');
		const other = await makeWorkflow('Workflow Other', 'wfOther');
		const v1 = wfVal.versionId;
		const workflowEntry = (overrides: Record<string, unknown>) => ({
			workflows: [
				{
					workflowId: wfVal.id,
					workflowVersionId: v1,
					workflowVersionName: 'Release 1',
					...overrides,
				},
			],
		});
		const invalid: Array<Record<string, unknown>> = [
			{ title: '' },
			{ title: 'x'.repeat(129) },
			{ description: 'x'.repeat(513) },
			{ workflows: [] },
			{ reviewerUserIds: [] },
			{ reviewerUserIds: Array.from({ length: 11 }, () => uuid()) },
			workflowEntry({ workflowVersionName: '   ' }),
			workflowEntry({ workflowVersionName: 'x'.repeat(129) }),
			workflowEntry({ workflowVersionDescription: 'x'.repeat(2049) }),
			workflowEntry({ workflowVersionId: 'unknownVersion01' }),
			workflowEntry({ workflowVersionId: other.versionId }),
			workflowEntry({ workflowId: 'unknownWorkflow1' }),
		];
		for (const overrides of invalid) {
			await call('requester', 'post', BASE, createBody(wfVal, v1, overrides));
		}
		await call(
			'reviewer',
			'post',
			BASE,
			createBody(wfVal, v1, { reviewerUserIds: [users.editor2.id] }),
		);
		await call('outsider', 'post', BASE, createBody(wfVal, v1));

		// Each of these could pass, so each uses a workflow of its own.
		const reviewers: Array<[string, string]> = [
			['self', users.requester.id],
			['outsider', users.outsider.id],
			['pending', pendingUser.id],
			['disabled', disabledUser.id],
			['unknown', '00000000-0000-4000-8000-000000000000'],
			['owner', users.owner.id],
			['two reviewers', `${users.reviewer.id},${users.editor2.id}`],
		];
		for (const [name, ids] of reviewers) {
			const workflow = await makeWorkflow(`Workflow reviewer ${name}`, `wf reviewer ${name}`);
			await createReview('requester', workflow, workflow.versionId, {
				reviewerUserIds: ids.split(','),
			});
		}
		await snapshotStep();
	});

	it('opens a review and blocks a second one', async () => {
		await call('requester', 'post', `/workflows/${wf1.id}/activate`, { versionId: wf1v1 });
		wf1v2 = await saveVersion(wf1, 'wf1.v2', users.requester);
		r1 = await createReview('requester', wf1, wf1v2);
		await createReview('requester', wf1, wf1v2, { title: 'Second review' });
		await createReview('editor2', wf1, wf1v2, { title: 'Review by another editor' });
		await snapshotStep();
	});

	it('blocks a publish while the review is open', async () => {
		await call('requester', 'post', `/workflows/${wf1.id}/activate`, { versionId: wf1v2 });
		await call('owner', 'post', `/workflows/${wf1.id}/activate`, { versionId: wf1v2 });
		// The published version again: nothing new is published.
		await call('requester', 'post', `/workflows/${wf1.id}/activate`, { versionId: wf1v1 });

		const wfPub = await makeWorkflow('Workflow Publish', 'wfPub');
		const pubV1 = wfPub.versionId;
		await call('requester', 'post', `/workflows/${wfPub.id}/activate`, { versionId: pubV1 });
		const pubV2 = await saveVersion(wfPub, 'wfPub.v2', users.requester);
		await createReview('requester', wfPub, pubV2);
		await call('requester', 'post', `/workflows/${wfPub.id}/deactivate`, {});
		await call('requester', 'post', `/workflows/${wfPub.id}/activate`, { versionId: pubV1 });
		await snapshotStep();
	});

	it('gives each user the reviews that the user may see', async () => {
		for (const who of READERS) {
			await call(who, 'get', `${BASE}?workflowId=${wf1.id}`);
			await call(who, 'get', `${BASE}/${r1}`);
			await call(who, 'get', `${BASE}/${r1}/activity`);
			await call(who, 'get', `${BASE}/inbox`);
			await call(who, 'get', `${BASE}/inbox?category=waiting`);
			await call(who, 'get', `${BASE}/inbox?category=authored`);
			await call(who, 'get', `${BASE}/summary`);
		}
		await call('requester', 'get', `${BASE}?workflowId=${wf1.id}&take=1`);
		await call('requester', 'get', `${BASE}?workflowId=${wf1.id}&state=closed`);
		await call('owner', 'get', `${BASE}/unknownRequest01`);
		await call('owner', 'get', `${BASE}/unknownRequest01/activity`);
		await call('owner', 'get', BASE);
		await snapshotStep();
	});

	it('adds comments', async () => {
		await call('reviewer', 'post', `${BASE}/${r1}/comments`, { body: 'One question' });
		await call('requester', 'post', `${BASE}/${r1}/comments`, { body: '  An answer  ' });
		for (const who of [
			'editor2',
			'viewer2',
			'projAdmin',
			'owner',
			'outsider',
			'customRead',
		] as Who[]) {
			await call(who, 'post', `${BASE}/${r1}/comments`, { body: `A comment by ${who}` });
		}
		await call('reviewer', 'post', `${BASE}/${r1}/comments`, { body: '' });
		await call('reviewer', 'post', `${BASE}/${r1}/comments`, { body: 'a\u0000b' });
		await call('reviewer', 'post', `${BASE}/${r1}/comments`, { body: 'x'.repeat(10001) });
		await call('reviewer', 'post', `${BASE}/${r1}/comments`, { body: 'Line one\nLine two\ttab' });
		await call('reviewer', 'post', `${BASE}/unknownRequest01/comments`, { body: 'Lost' });

		const first = await call('requester', 'get', `${BASE}/${r1}/activity?limit=2`);
		const cursor = String(dataOf(first).nextCursor ?? '');
		if (cursor) {
			await call('requester', 'get', `${BASE}/${r1}/activity?limit=2&cursor=${cursor}`);
		}
		await call('requester', 'get', `${BASE}/${r1}/activity?limit=0`);
		await call('requester', 'get', `${BASE}/${r1}/activity?limit=101`);
		await call('requester', 'get', `${BASE}/${r1}/activity?cursor=notACursor`);
		await snapshotStep();
	});

	it('requests changes', async () => {
		await call('editor2', 'post', `${BASE}/${r1}/decision`, { decision: 'changes_requested' });
		await call('requester', 'post', `${BASE}/${r1}/decision`, { decision: 'changes_requested' });
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, { decision: 'changes_requested' });
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, { decision: 'pending' });
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, { decision: 'rejected' });
		await call('requester', 'post', `${BASE}/${r1}/decision`, { decision: 'approved' });
		await call('editor2', 'post', `${BASE}/${r1}/decision`, { decision: 'approved' });
		await call('viewer2', 'post', `${BASE}/${r1}/decision`, { decision: 'approved' });
		await call('outsider', 'post', `${BASE}/${r1}/decision`, { decision: 'approved' });
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, {
			decision: 'changes_requested',
			note: 'Rename the trigger',
		});
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, {
			decision: 'changes_requested',
			note: 'Again',
		});
		await call('requester', 'post', `/workflows/${wf1.id}/activate`, { versionId: wf1v2 });
		await call('requester', 'get', `${BASE}?workflowId=${wf1.id}`);
		await call('requester', 'get', `${BASE}/${r1}`);
		await call('reviewer', 'get', `${BASE}/${r1}`);
		await call('reviewer', 'get', `${BASE}/inbox?category=waiting`);
		await snapshotStep();
	});

	let wf1v4 = '';

	it('submits newer versions to the review', async () => {
		const updateBody = (versionId: string, name: string, extra: Record<string, unknown> = {}) => ({
			workflowId: wf1.id,
			workflowVersionId: versionId,
			workflowVersionName: name,
			...extra,
		});
		await call(
			'requester',
			'post',
			`${BASE}/${r1}/update-version`,
			updateBody(wf1v2, 'Same again'),
		);
		wf1v3 = await saveVersion(wf1, 'wf1.v3', users.requester);
		const v3 = wf1v3;
		await call('reviewer', 'post', `${BASE}/${r1}/update-version`, updateBody(v3, 'By reviewer'));
		await call('outsider', 'post', `${BASE}/${r1}/update-version`, updateBody(v3, 'By outsider'));
		await call('requester', 'post', `${BASE}/${r1}/update-version`, {
			...updateBody(v3, 'Release 2', { workflowVersionDescription: 'Second release' }),
			workflowId: 'unknownWorkflow1',
		});
		await call(
			'requester',
			'post',
			`${BASE}/${r1}/update-version`,
			updateBody('unknownVersion01', 'Nothing'),
		);
		await call(
			'requester',
			'post',
			`${BASE}/${r1}/update-version`,
			updateBody(v3, 'Release 2', {
				workflowVersionDescription: 'Second release',
				description: 'Renamed the trigger',
			}),
		);
		await call('requester', 'get', `${BASE}/${r1}`);
		wf1v4 = await saveVersion(wf1, 'wf1.v4', users.editor2);
		await call(
			'editor2',
			'post',
			`${BASE}/${r1}/update-version`,
			updateBody(wf1v4, 'Release 3', { description: '' }),
		);
		await call('editor2', 'get', `${BASE}/${r1}`);
		await call('editor2', 'get', `${BASE}/inbox?category=authored`);
		await call('editor2', 'get', `${BASE}/inbox?category=waiting`);
		await call('requester', 'get', `${BASE}/${r1}/activity`);
		await snapshotStep();
	});

	it('approves a review and publishes the reviewed version', async () => {
		await call('editor2', 'post', `${BASE}/${r1}/decision`, { decision: 'approved' });
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, {
			decision: 'approved',
			note: 'Looks good',
		});
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, { decision: 'approved' });
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, {
			decision: 'changes_requested',
			note: 'Too late',
		});
		await call('reviewer', 'post', `${BASE}/${r1}/decision`, { decision: 'changes_requested' });
		await call('reviewer', 'post', `${BASE}/${r1}/comments`, { body: 'After the close' });
		await call('outsider', 'post', `${BASE}/${r1}/update-version`, {
			workflowId: wf1.id,
			workflowVersionId: wf1v4,
			workflowVersionName: 'By the outsider after the close',
		});
		await call('requester', 'post', `${BASE}/${r1}/update-version`, {
			workflowId: wf1.id,
			workflowVersionId: wf1v4,
			workflowVersionName: 'After the close',
		});
		for (const who of ['requester', 'reviewer', 'editor2', 'projAdmin'] as Who[]) {
			await call(who, 'get', `${BASE}/${r1}`);
		}
		await call('requester', 'get', `${BASE}/${r1}/activity`);
		await call('requester', 'get', `${BASE}?workflowId=${wf1.id}`);
		await call('reviewer', 'get', `${BASE}/inbox?state=closed`);
		await call('reviewer', 'get', `${BASE}/summary`);
		await call('requester', 'post', `/workflows/${wf1.id}/activate`, { versionId: wf1v3 });
		await createReview('requester', wf1, wf1v4, { title: 'A new review after the close' });
		await snapshotStep();
	});

	it('lets admins decide and tells who else may decide', async () => {
		const wf2 = await makeWorkflow('Workflow Two', 'wf2');
		const r2 = await createReview('requester', wf2, wf2.versionId);
		await call('projAdmin', 'get', `${BASE}/${r2}`);
		await call('projAdmin', 'post', `${BASE}/${r2}/decision`, { decision: 'approved' });

		const wf3 = await makeWorkflow('Workflow Three', 'wf3');
		const r3 = await createReview('requester', wf3, wf3.versionId);
		for (const who of ['customUpdate', 'customManage', 'admin', 'owner', 'customRead'] as Who[]) {
			await call(who, 'get', `${BASE}/${r3}`);
		}
		await call('customUpdate', 'post', `${BASE}/${r3}/decision`, {
			decision: 'changes_requested',
			note: 'By a custom role with project:update',
		});
		await call('customManage', 'post', `${BASE}/${r3}/decision`, {
			decision: 'changes_requested',
			note: 'By a custom role with project:manageMembers',
		});
		await call('admin', 'post', `${BASE}/${r3}/decision`, {
			decision: 'changes_requested',
			note: 'By the admin',
		});
		await call('owner', 'post', `${BASE}/${r3}/decision`, { decision: 'approved' });

		const wf4 = await makeWorkflow('Workflow Four', 'wf4');
		const r4 = await createReview('requester', wf4, wf4.versionId, {
			reviewerUserIds: [users.customRead.id],
		});
		await call('customRead', 'get', `${BASE}/${r4}`);
		await call('customRead', 'post', `${BASE}/${r4}/decision`, { decision: 'approved' });
		await snapshotStep();
	});

	it('handles a reviewer who loses access to the workflow', async () => {
		const wf5 = await makeWorkflow('Workflow Five', 'wf5');
		const r5 = await createReview('requester', wf5, wf5.versionId, {
			reviewerUserIds: [users.viewer2.id],
		});
		await Container.get(ProjectRelationRepository).delete({
			projectId: project.id,
			userId: users.viewer2.id,
		});
		await call('viewer2', 'get', `${BASE}/${r5}`);
		await call('viewer2', 'get', `${BASE}?workflowId=${wf5.id}`);
		await call('viewer2', 'get', `${BASE}/inbox`);
		await call('viewer2', 'get', `${BASE}/summary`);
		await call('viewer2', 'post', `${BASE}/${r5}/comments`, { body: 'No access now' });
		await call('viewer2', 'post', `${BASE}/${r5}/decision`, { decision: 'approved' });
		await call('requester', 'get', `${BASE}/${r5}`);
		await call('projAdmin', 'get', `${BASE}/${r5}`);
		await call('requester', 'get', `${BASE}/eligible-reviewers?workflowId=${wf5.id}`);
		await linkUserToProject(users.viewer2, project, 'project:viewer');
		await snapshotStep();
	});

	it('closes a review when its workflow is archived, deleted or moved', async () => {
		const wfArch = await makeWorkflow('Workflow Archive', 'wfArch');
		const rArch = await createReview('requester', wfArch, wfArch.versionId);
		await call('requester', 'post', `/workflows/${wfArch.id}/archive`, {});
		await call('requester', 'get', `${BASE}/${rArch}`);
		await call('requester', 'get', `${BASE}/${rArch}/activity`);
		await call('requester', 'post', `/workflows/${wfArch.id}/unarchive`, {});
		await call('requester', 'get', `${BASE}?workflowId=${wfArch.id}`);

		const wfDel = await makeWorkflow('Workflow Delete', 'wfDel');
		const rDel = await createReview('requester', wfDel, wfDel.versionId);
		await call('requester', 'post', `/workflows/${wfDel.id}/archive`, {});
		await call('requester', 'delete', `/workflows/${wfDel.id}`);
		await call('requester', 'get', `${BASE}/${rDel}`);
		await call('requester', 'get', `${BASE}/${rDel}/activity`);

		const wfMove = await makeWorkflow('Workflow Move', 'wfMove');
		const rMove = await createReview('requester', wfMove, wfMove.versionId);
		await call('projAdmin', 'put', `/workflows/${wfMove.id}/transfer`, {
			destinationProjectId: otherProject.id,
		});
		await call('projAdmin', 'get', `${BASE}/${rMove}`);
		await call('projAdmin', 'get', `${BASE}/${rMove}/activity`);
		await call('requester', 'get', `${BASE}/${rMove}`);
		await snapshotStep();
	});

	it('reports a failed publish after an approval', async () => {
		const wfFail = await makeWorkflow('Workflow Fail', 'wfFail');
		const rFail = await createReview('requester', wfFail, wfFail.versionId);
		await setProjectRole(users.requester, 'project:viewer');
		await call('reviewer', 'post', `${BASE}/${rFail}/decision`, {
			decision: 'approved',
			note: 'Approve while the requester may not publish',
		});
		await setProjectRole(users.requester, 'project:editor');
		await call('requester', 'get', `${BASE}/${rFail}`);
		await call('requester', 'get', `${BASE}/${rFail}/activity`);

		// A version that the publish rejects: a node of a type that does not exist.
		const wfBad = await makeWorkflow('Workflow Bad', 'wfBad');
		const badVersion = uuid();
		const badNodes = [
			...wfBad.nodes,
			{
				id: 'node-bad',
				name: 'Unknown node',
				type: 'n8n-nodes-base.doesNotExist',
				typeVersion: 1,
				position: [1000, 300] as [number, number],
				parameters: {},
			},
		];
		await Container.get(WorkflowRepository).update(wfBad.id, {
			versionId: badVersion,
			nodes: badNodes,
		});
		wfBad.versionId = badVersion;
		wfBad.nodes = badNodes;
		await createWorkflowHistory(wfBad, users.requester);
		rec.label(badVersion, 'wfBad.v2');
		const rBad = await createReview('requester', wfBad, badVersion);
		await call('reviewer', 'post', `${BASE}/${rBad}/decision`, { decision: 'approved' });
		await call('requester', 'get', `${BASE}/${rBad}/activity`);
		await snapshotStep();
	});

	it('follows the instance policy and the licence', async () => {
		const wfPol = await makeWorkflow('Workflow Policy', 'wfPol');
		const rPol = await createReview('requester', wfPol, wfPol.versionId);
		const polV2 = await saveVersion(wfPol, 'wfPol.v2', users.requester);
		await Container.get(WorkflowReviewPolicyService).set(false);
		const wfPol2 = await makeWorkflow('Workflow Policy Two', 'wfPol2');
		await call('requester', 'get', `${BASE}?workflowId=${wfPol.id}`);
		await call('requester', 'get', `${BASE}/${rPol}`);
		await call('requester', 'get', `${BASE}/inbox`);
		await call('requester', 'get', `${BASE}/summary`);
		await createReview('requester', wfPol2, wfPol2.versionId);
		await call('reviewer', 'post', `${BASE}/${rPol}/comments`, { body: 'Policy off' });
		await call('requester', 'post', `/workflows/${wfPol.id}/activate`, { versionId: polV2 });
		await Container.get(WorkflowReviewPolicyService).set(true);

		testServer.license.disable('feat:workflowReviews');
		await call('requester', 'get', `${BASE}/summary`);
		await call('requester', 'get', `${BASE}/${rPol}`);
		await call('reviewer', 'post', `${BASE}/${rPol}/decision`, { decision: 'approved' });
		testServer.license.enable('feat:workflowReviews');
		await snapshotStep();
	});

	it('orders the authors and the reviewers', async () => {
		// Authors in the order requester, zed, editor2, and reviewers in the order of the request.
		const wfC = await makeWorkflow('Workflow Authors C', 'wfC');
		const rC = await createReview('requester', wfC, wfC.versionId, {
			reviewerUserIds: [users.reviewer.id, users.viewer2.id],
		});
		for (const [who, label] of [
			['zed', 'wfC.v2'],
			['editor2', 'wfC.v3'],
		] as const) {
			const version = await saveVersion(wfC, label, users[who]);
			await call(who, 'post', `${BASE}/${rC}/update-version`, {
				workflowId: wfC.id,
				workflowVersionId: version,
				workflowVersionName: `By ${who}`,
			});
		}
		await call('owner', 'get', `${BASE}/${rC}`);

		// Authors in the order requester, editor2, zed.
		const wfD = await makeWorkflow('Workflow Authors D', 'wfD');
		const rD = await createReview('requester', wfD, wfD.versionId, {
			reviewerUserIds: [users.viewer2.id, users.reviewer.id],
		});
		for (const [who, label] of [
			['editor2', 'wfD.v2'],
			['zed', 'wfD.v3'],
		] as const) {
			const version = await saveVersion(wfD, label, users[who]);
			await call(who, 'post', `${BASE}/${rD}/update-version`, {
				workflowId: wfD.id,
				workflowVersionId: version,
				workflowVersionName: `By ${who}`,
			});
		}
		await call('owner', 'get', `${BASE}/${rD}`);
		await call('owner', 'get', `${BASE}/inbox?limit=2`);
		await snapshotStep();
	});

	it('lets an author decide only as an admin or a reviewer', async () => {
		const wfE = await makeWorkflow('Workflow Owner Author', 'wfE');
		const rE = await createReview('owner', wfE, wfE.versionId);
		await call('owner', 'get', `${BASE}/${rE}`);
		await call('owner', 'post', `${BASE}/${rE}/decision`, {
			decision: 'changes_requested',
			note: 'The owner decides on an own review',
		});

		const wfF = await makeWorkflow('Workflow Project Admin Author', 'wfF');
		const rF = await createReview('projAdmin', wfF, wfF.versionId);
		await call('projAdmin', 'get', `${BASE}/${rF}`);
		await call('projAdmin', 'post', `${BASE}/${rF}/decision`, {
			decision: 'changes_requested',
			note: 'A project admin decides on an own review',
		});

		const wfG = await makeWorkflow('Workflow Reviewer Author', 'wfG');
		const rG = await createReview('requester', wfG, wfG.versionId, {
			reviewerUserIds: [users.editor2.id],
		});
		const gVersion = await saveVersion(wfG, 'wfG.v2', users.editor2);
		await call('editor2', 'post', `${BASE}/${rG}/update-version`, {
			workflowId: wfG.id,
			workflowVersionId: gVersion,
			workflowVersionName: 'By the reviewer',
		});
		await call('editor2', 'get', `${BASE}/${rG}`);
		await call('editor2', 'post', `${BASE}/${rG}/decision`, { decision: 'approved' });
		await snapshotStep();
	});

	it('tells why an admin of the old project may not decide after a move', async () => {
		const wfMv = await makeWorkflow('Workflow Moved Review', 'wfMv');
		const rMv = await createReview('requester', wfMv, wfMv.versionId, {
			reviewerUserIds: [users.projAdmin2.id],
		});
		await call('projAdmin', 'put', `/workflows/${wfMv.id}/transfer`, {
			destinationProjectId: otherProject.id,
		});
		for (const who of ['projAdmin2', 'projAdmin3', 'projAdmin', 'requester', 'owner'] as Who[]) {
			await call(who, 'get', `${BASE}/${rMv}`);
		}
		await call('projAdmin2', 'post', `${BASE}/${rMv}/comments`, { body: 'After the move' });
		await call('projAdmin2', 'get', `${BASE}/inbox?state=closed`);
		await snapshotStep();
	});

	it('closes a review when its workflow is deleted without an archive', async () => {
		const wfForce = await makeWorkflow('Workflow Force Delete', 'wfForce');
		const rForce = await createReview('requester', wfForce, wfForce.versionId);
		await act('WorkflowService.deleteForPublicApi(requester, wfForce)', async () => {
			await Container.get(WorkflowService).deleteForPublicApi(users.requester, wfForce.id);
		});
		await call('requester', 'get', `${BASE}/${rForce}`);
		await call('requester', 'get', `${BASE}/${rForce}/activity`);
		await call('requester', 'post', `${BASE}/${rForce}/comments`, { body: 'Deleted' });
		await call('owner', 'get', `${BASE}/${rForce}`);
		await call('reviewer', 'get', `${BASE}/${rForce}`);
		await call('reviewer', 'post', `${BASE}/${rForce}/decision`, { decision: 'approved' });
		await call('owner', 'post', `${BASE}/${rForce}/decision`, { decision: 'approved' });
		await snapshotStep();
	});

	it('closes the reviews of the workflows of a moved folder', async () => {
		const folder = await createFolder(project, { name: 'Folder Under Review' });
		rec.label(folder.id, 'folder');
		const wfFold = await makeWorkflow('Workflow In Folder', 'wfFold', { parentFolder: folder });
		const rFold = await createReview('requester', wfFold, wfFold.versionId);
		await call('projAdmin', 'put', `/projects/${project.id}/folders/${folder.id}/transfer`, {
			destinationProjectId: otherProject.id,
			destinationParentFolderId: '0',
		});
		await call('projAdmin', 'get', `${BASE}/${rFold}`);
		await call('projAdmin', 'get', `${BASE}/${rFold}/activity`);
		await snapshotStep();
	});

	it('records each publish of a reviewed version', async () => {
		const wfRe = await makeWorkflow('Workflow Republish', 'wfRe');
		const rRe = await createReview('requester', wfRe, wfRe.versionId);
		await call('reviewer', 'post', `${BASE}/${rRe}/decision`, { decision: 'approved' });
		await call('requester', 'post', `/workflows/${wfRe.id}/deactivate`, {});
		await call('requester', 'post', `/workflows/${wfRe.id}/activate`, {
			versionId: wfRe.versionId,
		});
		await call('requester', 'get', `${BASE}/${rRe}/activity`);

		const wfOff = await makeWorkflow('Workflow Policy Off Publish', 'wfOff');
		const rOff = await createReview('requester', wfOff, wfOff.versionId);
		await Container.get(WorkflowReviewPolicyService).set(false);
		await call('requester', 'post', `/workflows/${wfOff.id}/activate`, {
			versionId: wfOff.versionId,
		});
		await Container.get(WorkflowReviewPolicyService).set(true);
		await call('requester', 'get', `${BASE}/${rOff}`);
		await call('requester', 'get', `${BASE}/${rOff}/activity`);
		await snapshotStep();
	});

	it('handles a requester who was deleted', async () => {
		const wfLeave = await makeWorkflow('Workflow Leaver', 'wfLeave');
		const rLeave = await createReview('leaver', wfLeave, wfLeave.versionId);
		await call('reviewer', 'post', `${BASE}/${rLeave}/comments`, { body: 'Before the delete' });
		await act('UserRepository.delete(leaver)', async () => {
			await Container.get(UserRepository).delete(users.leaver.id);
		});
		await call('owner', 'get', `${BASE}/${rLeave}`);
		await call('owner', 'get', `${BASE}?workflowId=${wfLeave.id}`);
		await call('reviewer', 'post', `${BASE}/${rLeave}/decision`, { decision: 'approved' });
		await call('owner', 'get', `${BASE}/${rLeave}/activity`);
		await call('owner', 'get', `${BASE}/inbox?state=closed&limit=1`);
		await snapshotStep();
	});

	it('checks more input and the order of the checks', async () => {
		const wfMore = await makeWorkflow('Workflow More', 'wfMore');
		const rMore = await createReview('requester', wfMore, wfMore.versionId, {
			description: '   ',
			reviewerUserIds: [users.reviewer.id, users.reviewer.id],
		});
		// An open review and a reviewer that is not allowed: which check comes first.
		await createReview('requester', wfMore, wfMore.versionId, {
			reviewerUserIds: [users.requester.id],
		});
		await createReview('requester', wfMore, wfMore.versionId, {
			reviewerUserIds: [users.outsider.id],
		});
		await createReview('requester', wfMore, 'unknownVersion01');
		await call('reviewer', 'post', `${BASE}/${rMore}/decision`, {
			decision: 'changes_requested',
			note: 'x'.repeat(10001),
		});
		await call('reviewer', 'post', `${BASE}/${rMore}/decision`, {
			decision: 'approved',
			note: 'a\u0001b',
		});
		// The pinned version again, by an editor who is not an author yet.
		await call('editor2', 'post', `${BASE}/${rMore}/update-version`, {
			workflowId: wfMore.id,
			workflowVersionId: wfMore.versionId,
			workflowVersionName: 'Same version, new name',
			workflowVersionDescription: 'Same version, new description',
			description: 'A new review description',
		});
		await call('owner', 'get', `${BASE}/${rMore}`);
		const moreV2 = await saveVersion(wfMore, 'wfMore.v2', users.requester);
		await call('requester', 'post', `${BASE}/${rMore}/update-version`, {
			workflowId: wfMore.id,
			workflowVersionId: moreV2,
			workflowVersionName: 'Blank descriptions',
			workflowVersionDescription: '   ',
			description: '   ',
		});
		await call('requester', 'post', `${BASE}/${rMore}/update-version`, {
			workflowId: wfMore.id,
			workflowVersionId: wf1v1,
			workflowVersionName: 'A version of another workflow',
		});
		await call('owner', 'get', `${BASE}/${rMore}`);

		// Two users that may not review, in one request.
		const wfTwo = await makeWorkflow('Workflow Two Ineligible', 'wfTwo');
		await createReview('requester', wfTwo, wfTwo.versionId, {
			reviewerUserIds: [users.outsider.id, '00000000-0000-4000-8000-000000000099'],
		});

		// An archived workflow.
		const wfArchived = await makeWorkflow('Workflow Archived Before', 'wfArchived');
		await call('requester', 'post', `/workflows/${wfArchived.id}/archive`, {});
		await createReview('requester', wfArchived, wfArchived.versionId);

		// A published workflow whose review closes without an approval: which baseline shows.
		const wfBase = await makeWorkflow('Workflow Baseline', 'wfBase');
		await call('requester', 'post', `/workflows/${wfBase.id}/activate`, {
			versionId: wfBase.versionId,
		});
		const baseV2 = await saveVersion(wfBase, 'wfBase.v2', users.requester);
		const rBase = await createReview('requester', wfBase, baseV2);
		await call('projAdmin', 'get', `${BASE}/${rBase}`);
		await call('projAdmin', 'put', `/workflows/${wfBase.id}/transfer`, {
			destinationProjectId: otherProject.id,
		});
		await call('projAdmin', 'get', `${BASE}/${rBase}`);
		await snapshotStep();
	});

	it('pages through the inbox', async () => {
		for (const state of ['open', 'closed']) {
			let url = `${BASE}/inbox?state=${state}&limit=2`;
			for (let page = 0; page < 10; page++) {
				const response = await call('owner', 'get', url);
				const cursor = String(dataOf(response).nextCursor ?? '');
				if (!cursor) break;
				url = `${BASE}/inbox?state=${state}&limit=2&cursor=${cursor}`;
			}
		}
		await call('reviewer', 'get', `${BASE}/inbox?limit=1&category=waiting`);
		await call('owner', 'get', `${BASE}/inbox?limit=0`);
		await call('owner', 'get', `${BASE}/inbox?limit=101`);
		await call('owner', 'get', `${BASE}/inbox?state=bogus`);
		await call('owner', 'get', `${BASE}/inbox?category=bogus`);
		await call('owner', 'get', `${BASE}/inbox?cursor=notACursor`);
		await call('owner', 'get', `${BASE}?workflowId=${wf1.id}&take=0`);
		await call('owner', 'get', `${BASE}?workflowId=${wf1.id}&skip=-1`);
		await call('owner', 'get', `${BASE}?workflowId=${wf1.id}&state=bogus`);
		await snapshotStep();
	});
});
