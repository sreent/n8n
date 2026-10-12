// Fork test (not in upstream n8n): a golden test of the REST API of evaluation configs, of the
// dataset routes of a config, of evaluation collections, of the versions list and of the AI
// insights, end to end. It calls each route as the owner, a member and the admin, the editor and
// the viewer of a project, runs real test runs with the Evaluation nodes and a Data table, and
// records the status and the body of each answer, the rows of the evaluation tables, the dataset
// rows, the compiled workflows of the runs, and the events and telemetry of each call. The
// snapshot was recorded against the enterprise files, and the fork files give the same snapshot.
// See `packages/cli/src/evaluation/FORK.md`.
import { createTeamProject, linkUserToProject } from '@n8n/backend-test-utils';
import { createWorkflowWithHistory } from '@n8n/backend-test-utils';
import {
	CONFIG_EVALUATIONS_ENABLED_VARIANT,
	CONFIG_EVALUATIONS_FLAG,
	EVAL_COLLECTIONS_FLAG,
} from '@n8n/api-types';
import { LICENSE_QUOTAS } from '@n8n/constants';
import type { User } from '@n8n/db';
import { GLOBAL_MEMBER_ROLE, GLOBAL_OWNER_ROLE, WorkflowHistoryRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { INode, IWorkflowBase } from 'n8n-workflow';

import '@/evaluation/evaluation-config.controller';
import '@/evaluation/evaluation-collections.controller';
import '@/evaluation/insights/eval-insights.controller';
import { ActiveExecutions } from '@/active-executions';
import { EventService } from '@n8n/backend-services';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { PostHogClient } from '@/posthog';
import { Telemetry } from '@/telemetry';
import { WorkflowRunner } from '@/workflow-runner';
import { createUserShell } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';
import { loadNodesFromDist } from '@test-integration/utils/node-types-data';

const testServer = utils.setupTestServer({
	endpointGroups: ['workflows', 'evaluation'],
	enabledFeatures: [
		'feat:sharing',
		'feat:projectRole:admin',
		'feat:projectRole:editor',
		'feat:projectRole:viewer',
	],
	quotas: {
		[LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT]: -1,
		[LICENSE_QUOTAS.TEAM_PROJECT_LIMIT]: -1,
	},
	modules: ['data-table'],
});

/** A nano ID: 16 letters and digits, with a digit or mixed case, and not a camelCase or PascalCase word. */
const isGeneratedId = (text: string) =>
	!/^[a-z]*([A-Z][a-z]{2,})+$/.test(text) &&
	(/\d/.test(text) || (/[a-z]/.test(text) && /[A-Z]/.test(text)));

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
const labels = new Map<string, string>();
const label = (id: string, name: string) => {
	labels.set(String(id), name);
	return id;
};

/** Labels for known ids, placeholders for dates, generated ids and timings. */
function normalize(value: unknown, key = ''): unknown {
	if (value instanceof Date) return '<Date>';
	if (
		['executionTime', 'startTime', 'duration', 'duration_ms', 'start'].includes(key) ||
		key.endsWith('Duration')
	) {
		return '<time>';
	}
	if (typeof value === 'string') {
		const known = labels.get(value);
		if (known) return `@${known}`;
		if (DATE_TEXT.test(value)) return '<date>';
		let text = value
			.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<day>')
			.replace(/\b[A-Za-z0-9]{16}\b/g, (match) =>
				labels.has(match) ? `@${labels.get(match)}` : isGeneratedId(match) ? '<id>' : match,
			);
		// Short labels (execution IDs) match only a whole value, not a part of a text.
		for (const [id, name] of labels) if (id.length >= 8) text = text.replaceAll(id, `@${name}`);
		return text
			.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (match) =>
				labels.has(match) ? `@${labels.get(match)}` : '<uuid>',
			)
			.replace(/(?<![\w-])[\w-]{21}(?![\w-])/g, (match) =>
				labels.has(match)
					? `@${labels.get(match)}`
					: /[A-Z]/.test(match) && /[a-z0-9]/.test(match)
						? '<nano id>'
						: match,
			);
	}
	if (typeof value === 'number' && key === 'executionId' && labels.has(String(value))) {
		return `@${labels.get(String(value))}`;
	}
	if (Array.isArray(value)) return value.map((item) => normalize(item));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, normalize(v, k)]),
		);
	}
	return value;
}

async function query(sql: string, parameters: unknown[] = []) {
	return parseRows(
		await Container.get(DataSource).query<Array<Record<string, unknown>>>(sql, parameters),
	);
}

/** SQLite gives JSON columns as text: parse them, so that the values can be normalized. */
function parseJsonText(value: unknown): unknown {
	if (typeof value === 'string' && /^[[{]/.test(value)) {
		try {
			return JSON.parse(value) as unknown;
		} catch {
			return value;
		}
	}
	return value;
}

function parseRows(rows: Array<Record<string, unknown>>) {
	// A statement that is not a SELECT gives no list of rows.
	if (!Array.isArray(rows)) return rows;
	return rows.map((row) => {
		const parsed = Object.fromEntries(
			Object.entries(row).map(([key, value]) => [key, parseJsonText(value)]),
		);
		// The normalization sorts keys, so keep the stored order of the metrics.
		if (parsed.metrics && typeof parsed.metrics === 'object' && !Array.isArray(parsed.metrics)) {
			parsed.metricOrder = Object.keys(parsed.metrics);
		}
		return parsed;
	});
}

const agents: Record<string, SuperAgentTest> = {};
let owner: User;
let workflow: IWorkflowBase;
let tableId: string;
let otherTableId: string;

/** The external effects of one call: events and telemetry. */
const effects: unknown[] = [];

async function call(
	user: string,
	method: 'get' | 'post' | 'put' | 'patch' | 'delete',
	path: string,
	body?: object,
) {
	effects.length = 0;
	const request = agents[user][method](path);
	const response = body === undefined ? await request : await request.send(body);
	const record: Record<string, unknown> = { status: response.statusCode, body: response.body };
	if (effects.length > 0) record.effects = [...effects];
	return normalize(record);
}

const nodes: INode[] = [
	{
		id: 'n1',
		name: 'When clicking',
		type: 'n8n-nodes-base.manualTrigger',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	},
	{
		id: 'n2',
		name: 'Seed',
		type: 'n8n-nodes-base.set',
		typeVersion: 3.4,
		position: [200, 0],
		parameters: {
			assignments: {
				assignments: [
					{ id: 's1', name: 'question', value: 'q9', type: 'string' },
					{ id: 's2', name: 'expected', value: 'Q9', type: 'string' },
				],
			},
			options: {},
		},
	},
	{
		id: 'n3',
		name: 'Prepare',
		type: 'n8n-nodes-base.set',
		typeVersion: 3.4,
		position: [400, 0],
		parameters: {
			assignments: {
				assignments: [
					{
						id: 'p1',
						name: 'answer',
						value: '={{ $json.question.toUpperCase() }}',
						type: 'string',
					},
				],
			},
			includeOtherFields: true,
			options: {},
		},
	},
	{
		id: 'n4',
		name: 'Answer',
		type: 'n8n-nodes-base.set',
		typeVersion: 3.4,
		position: [600, 0],
		parameters: {
			assignments: {
				assignments: [{ id: 'a1', name: 'final', value: '={{ $json.answer }}', type: 'string' }],
			},
			includeOtherFields: true,
			options: {},
		},
	},
];

const connections = {
	'When clicking': { main: [[{ node: 'Seed', type: 'main' as const, index: 0 }]] },
	Seed: { main: [[{ node: 'Prepare', type: 'main' as const, index: 0 }]] },
	Prepare: { main: [[{ node: 'Answer', type: 'main' as const, index: 0 }]] },
};

const exactMetric = {
	id: 'm-exact',
	name: 'Exact',
	type: 'expression',
	config: { expression: '={{ $json.final === $json.expected }}', outputType: 'boolean' },
};
const similarityMetric = {
	id: 'm-sim',
	name: 'Similarity',
	type: 'string_similarity',
	config: {
		inputs: { actualAnswer: '={{ $json.final }}', expectedAnswer: '={{ $json.expected }}' },
	},
};
const categoryMetric = {
	id: 'm-cat',
	name: 'Category',
	type: 'categorization',
	config: {
		inputs: { actualAnswer: '={{ $json.final }}', expectedAnswer: '={{ $json.expected }}' },
	},
};

const configBody = (overrides: Record<string, unknown> = {}) => ({
	name: 'Config',
	datasetSource: 'data_table',
	datasetRef: { dataTableId: tableId },
	startNodeName: 'Prepare',
	endNodeName: 'Answer',
	metrics: [exactMetric, similarityMetric, categoryMetric],
	...overrides,
});

const FINISHED = ['completed', 'error', 'cancelled'];

async function waitForRun(runId: string) {
	for (let attempt = 0; attempt < 300; attempt++) {
		const [run] = await query('SELECT status, "runningInstanceId" FROM test_run WHERE id = ?', [
			runId,
		]);
		// A finished run can keep its instance for a moment, so wait for both.
		if (
			run &&
			FINISHED.includes(String(run.status)) &&
			(run.runningInstanceId === null || attempt > 280)
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`The test run ${runId} did not finish`);
}

/** The rows of the evaluation tables, and the compiled workflow of each case execution. */
async function evaluationRows() {
	const runs = await query('SELECT * FROM test_run ORDER BY "createdAt", id');
	const cases = await query(
		'SELECT c.* FROM test_case_execution c JOIN test_run r ON r.id = c."testRunId" ORDER BY r."createdAt", c."runIndex"',
	);
	const compiled: Record<string, unknown> = {};
	for (const testCase of cases) {
		if (testCase.executionId === null) continue;
		if (!labels.has(String(testCase.executionId))) {
			const run = labels.get(String(testCase.testRunId)) ?? 'a run';
			label(
				String(testCase.executionId),
				`execution of case ${String(testCase.runIndex)} of ${run}`,
			);
		}
		const [data] = await query(
			'SELECT "workflowData" FROM execution_data WHERE "executionId" = ?',
			[testCase.executionId],
		);
		const workflowData =
			typeof data?.workflowData === 'string' ? JSON.parse(data.workflowData) : data?.workflowData;
		compiled[
			`case ${String(testCase.runIndex)} of ${String(normalize(String(testCase.testRunId)))}`
		] = {
			nodes: (workflowData?.nodes ?? []).map((node: INode) => ({
				name: node.name,
				type: node.type,
				typeVersion: node.typeVersion,
				parameters: node.parameters,
				disabled: node.disabled,
			})),
			connections: workflowData?.connections,
		};
	}
	return normalize({
		configs: await query('SELECT * FROM evaluation_config ORDER BY "createdAt", id'),
		collections: await query('SELECT * FROM evaluation_collection ORDER BY "createdAt", id'),
		runs,
		cases,
		compiled,
		dataset: await query(`SELECT * FROM "data_table_user_${tableId}" ORDER BY id`),
	});
}

/** Runs the workflow once by hand, as the editor does, and gives the execution ID. */
async function runManually() {
	const executionId = await Container.get(WorkflowRunner).run({
		executionMode: 'manual',
		workflowData: workflow,
		userId: owner.id,
	});
	await Container.get(ActiveExecutions).getPostExecutePromise(executionId);
	return executionId;
}

beforeAll(async () => {
	const nodeTypes = loadNodesFromDist([
		'n8n-nodes-base.evaluationTrigger',
		'n8n-nodes-base.evaluation',
		'n8n-nodes-base.set',
		'n8n-nodes-base.manualTrigger',
		'n8n-nodes-base.noOp',
	]);
	await utils.initNodeTypes(nodeTypes);
	await utils.initBinaryDataService();

	// The test server mocks Telemetry; record the calls of its mock.
	vi.mocked(Container.get(Telemetry).track).mockImplementation((event, properties) => {
		effects.push({ telemetry: event, properties });
	});
	const events = Container.get(EventService);
	const emit = events.emit.bind(events);
	vi.spyOn(events, 'emit').mockImplementation((name, payload) => {
		effects.push({ event: name, payload });
		return emit(name, payload);
	});

	owner = await createUserShell(GLOBAL_OWNER_ROLE);
	label(owner.id, 'owner');
	const member = await createUserShell(GLOBAL_MEMBER_ROLE);
	label(member.id, 'member');
	const project = await createTeamProject('Evals', owner);
	label(project.id, 'project');
	const other = await createTeamProject('Other', owner);
	label(other.id, 'other project');
	agents.owner = testServer.authAgentFor(owner);
	agents.member = testServer.authAgentFor(member);
	for (const role of ['admin', 'editor', 'viewer'] as const) {
		const user = await createUserShell(GLOBAL_MEMBER_ROLE);
		label(user.id, `project ${role}`);
		await linkUserToProject(user, project, `project:${role}`);
		agents[role] = testServer.authAgentFor(user);
	}

	const tables = Container.get(DataTableService);
	const table = await tables.createDataTable(project.id, {
		name: 'cases',
		columns: [
			{ name: 'question', type: 'string' },
			{ name: 'expected', type: 'string' },
			{ name: 'final', type: 'string' },
		],
	});
	tableId = label(table.id, 'table');
	await tables.insertRows(table.id, project.id, [
		{ question: 'a', expected: 'A' },
		{ question: 'b', expected: 'X' },
	]);
	otherTableId = label(
		(await tables.createDataTable(other.id, { name: 'other', columns: [] })).id,
		'other table',
	);

	workflow = await createWorkflowWithHistory({ name: 'evaluated', nodes, connections }, project);
	label(workflow.id, 'workflow');
	const { versionId } = workflow;
	if (!versionId) throw new Error('The workflow has no version');
	label(versionId, 'version 1');
	// The versions list shows the first 8 characters of a version ID.
	label(versionId.slice(0, 8), 'version 1 prefix');
});

/** The test server mocks PostHog, so the flags come from the mock. */
function setFlags(enabled: boolean) {
	const flags = enabled
		? {
				[EVAL_COLLECTIONS_FLAG]: true,
				[CONFIG_EVALUATIONS_FLAG]: CONFIG_EVALUATIONS_ENABLED_VARIANT,
			}
		: {};
	vi.mocked(Container.get(PostHogClient).getFeatureFlags).mockResolvedValue(flags);
}

beforeEach(() => {
	setFlags(true);
});

afterEach(() => {
	testServer.license.reset();
});

test('the routes with the feature flags off', async () => {
	setFlags(false);
	const base = `/workflows/${workflow.id}`;
	expect({
		'list configs': await call('owner', 'get', `${base}/evaluation-configs`),
		'create a config': await call('owner', 'post', `${base}/evaluation-configs`, configBody()),
		'list collections': await call('owner', 'get', `${base}/eval-collections`),
		'list versions': await call('owner', 'get', `${base}/eval-versions`),
		'test runs': await call('owner', 'get', `${base}/test-runs`),
	}).toMatchSnapshot();
	// The config routes do not check the flag, so the create above made a config. Remove it.
	await query('DELETE FROM evaluation_config');
});

test('evaluation configs, their dataset routes and a compiled run', async () => {
	const base = `/workflows/${workflow.id}/evaluation-configs`;
	const record: Record<string, unknown> = {};

	for (const user of ['owner', 'member', 'admin', 'editor', 'viewer']) {
		record[`list as ${user}, empty`] = await call(user, 'get', base);
	}
	for (const user of ['member', 'viewer']) {
		record[`create as ${user}`] = await call(
			user,
			'post',
			base,
			configBody({ name: `by ${user}` }),
		);
	}
	record['create as the owner'] = await call('owner', 'post', base, configBody());
	const [config] = await query('SELECT id FROM evaluation_config WHERE name = ?', ['Config']);
	const configId = label(String(config.id), 'config');
	record['create as the editor'] = await call(
		'editor',
		'post',
		base,
		configBody({ name: 'Editor' }),
	);
	record['create with the same name'] = await call('owner', 'post', base, configBody());
	record['create without a body'] = await call('owner', 'post', base, {});
	record['create with an unknown start node'] = await call(
		'owner',
		'post',
		base,
		configBody({ name: 'A', startNodeName: 'Missing' }),
	);
	record['create with an end node before the start'] = await call(
		'owner',
		'post',
		base,
		configBody({ name: 'B', startNodeName: 'Answer', endNodeName: 'Prepare' }),
	);
	record['create with a table of another project'] = await call(
		'owner',
		'post',
		base,
		configBody({ name: 'C', datasetRef: { dataTableId: otherTableId } }),
	);
	record['create with two metrics of one name'] = await call(
		'owner',
		'post',
		base,
		configBody({ name: 'D', metrics: [exactMetric, { ...categoryMetric, name: 'Exact' }] }),
	);
	record['create with a reserved metric name'] = await call(
		'owner',
		'post',
		base,
		configBody({ name: 'E', metrics: [{ ...exactMetric, name: 'executionTime' }] }),
	);
	record['create on an unknown workflow'] = await call(
		'owner',
		'post',
		'/workflows/unknown/evaluation-configs',
		configBody(),
	);

	for (const user of ['owner', 'member', 'viewer']) {
		record[`list as ${user}`] = await call(user, 'get', base);
		record[`get as ${user}`] = await call(user, 'get', `${base}/${configId}`);
	}
	record['get unknown'] = await call('owner', 'get', `${base}/unknown`);
	record['update as the viewer'] = await call(
		'viewer',
		'put',
		`${base}/${configId}`,
		configBody({ name: 'Renamed' }),
	);
	record['update as the owner'] = await call(
		'owner',
		'put',
		`${base}/${configId}`,
		configBody({ name: 'Config', metrics: [exactMetric, similarityMetric, categoryMetric] }),
	);
	record['update unknown'] = await call('owner', 'put', `${base}/unknown`, configBody());

	const executionId = await runManually();
	label(executionId, 'manual execution');
	for (const path of [
		`dataset-candidate?executionId=${executionId}`,
		'dataset-candidate',
		'dataset-candidate?executionId=999999',
	]) {
		record[`GET ${path}`] = await call('owner', 'get', `${base}/${configId}/${path}`);
	}
	record['dataset candidate as the viewer'] = await call(
		'viewer',
		'get',
		`${base}/${configId}/dataset-candidate?executionId=${executionId}`,
	);
	record['add a dataset row as the viewer'] = await call(
		'viewer',
		'post',
		`${base}/${configId}/dataset-rows`,
		{ executionId, mapping: { question: { source: 'input', field: 'question' } } },
	);
	record['add a dataset row'] = await call('owner', 'post', `${base}/${configId}/dataset-rows`, {
		executionId,
		mapping: {
			question: { source: 'input', field: 'question' },
			expected: { source: 'input', field: 'expected' },
			final: { source: 'output', field: 'final' },
		},
	});
	record['add a dataset row with an unknown field'] = await call(
		'owner',
		'post',
		`${base}/${configId}/dataset-rows`,
		{ executionId, mapping: { question: { source: 'output', field: 'missing' }, expected: null } },
	);
	record['add a dataset row with an unknown column'] = await call(
		'owner',
		'post',
		`${base}/${configId}/dataset-rows`,
		{ executionId, mapping: { unknown: { source: 'input', field: 'question' } } },
	);

	const start = await call('owner', 'post', `/workflows/${workflow.id}/test-runs/new`, {
		evaluationConfigId: configId,
		compileFromConfig: true,
	});
	record['start a compiled run'] = start;
	const [run] = await query('SELECT id FROM test_run ORDER BY "createdAt" DESC LIMIT 1');
	if (run) {
		label(String(run.id), 'compiled run');
		await waitForRun(String(run.id));
	}
	record['start a run of an unknown config'] = await call(
		'owner',
		'post',
		`/workflows/${workflow.id}/test-runs/new`,
		{ evaluationConfigId: 'unknown', compileFromConfig: true },
	);
	record['start a run with a config and no compile'] = await call(
		'owner',
		'post',
		`/workflows/${workflow.id}/test-runs/new`,
		{ evaluationConfigId: configId },
	);
	const [late] = await query('SELECT id FROM test_run ORDER BY "createdAt" DESC LIMIT 1');
	if (late && !labels.has(String(late.id))) {
		label(String(late.id), 'uncompiled run');
		await waitForRun(String(late.id));
	}
	record.rows = await evaluationRows();

	record['delete as the viewer'] = await call('viewer', 'delete', `${base}/${configId}`);
	record['delete unknown'] = await call('owner', 'delete', `${base}/unknown`);
	expect(record).toMatchSnapshot();
}, 120_000);

test('evaluation collections, versions and insights', async () => {
	const workflowBase = `/workflows/${workflow.id}`;
	const base = `${workflowBase}/eval-collections`;
	const record: Record<string, unknown> = {};
	const [config] = await query('SELECT id FROM evaluation_config WHERE name = ?', ['Config']);
	const configId = String(config.id);
	const [run] = await query(
		'SELECT id FROM test_run WHERE "evaluationConfigId" = ? ORDER BY "createdAt"',
		[configId],
	);
	const runId = String(run.id);

	// A second version of the workflow, in the history. Its answer keeps the case of the question,
	// so it scores worse than the first version.
	const history = Container.get(WorkflowHistoryRepository);
	const worseNodes = nodes.map((node) =>
		node.name === 'Prepare'
			? {
					...node,
					parameters: {
						...node.parameters,
						assignments: {
							assignments: [
								{ id: 'p1', name: 'answer', value: '={{ $json.question }}', type: 'string' },
							],
						},
					},
				}
			: node,
	);
	await history.insert(
		history.create({
			workflowId: workflow.id,
			versionId: 'version-2',
			nodes: worseNodes,
			connections,
			authors: 'Test User',
		}),
	);
	label('version-2', 'version 2');

	for (const user of ['owner', 'member', 'viewer']) {
		record[`list as ${user}, empty`] = await call(user, 'get', base);
	}
	for (const query of ['', '?evaluationConfigId=<config>', '?configId=<config>']) {
		record[`GET eval-versions${query}`] = await call(
			'owner',
			'get',
			`${workflowBase}/eval-versions${query.replace('<config>', configId)}`,
		);
	}

	const body = {
		name: 'Compare',
		description: 'Two versions',
		evaluationConfigId: configId,
		versions: [
			{ workflowVersionId: null, label: 'Draft' },
			{ workflowVersionId: 'version-2', label: 'Second' },
		],
	};
	record['create with a run that has no pinned version'] = await call('owner', 'post', base, {
		...body,
		versions: [{ workflowVersionId: null, existingTestRunId: runId, label: 'Draft' }],
	});
	record['create as the viewer'] = await call('viewer', 'post', base, body);
	record['create with an unknown config'] = await call('owner', 'post', base, {
		...body,
		evaluationConfigId: 'unknown',
	});
	record['create with an unknown run'] = await call('owner', 'post', base, {
		...body,
		versions: [{ workflowVersionId: null, existingTestRunId: 'unknown' }],
	});
	record['create without versions'] = await call('owner', 'post', base, { ...body, versions: [] });
	record['create as the owner'] = await call('owner', 'post', base, body);
	const [collection] = await query('SELECT id FROM evaluation_collection WHERE name = ?', [
		'Compare',
	]);
	if (!collection) {
		record.rows = await evaluationRows();
		expect(record).toMatchSnapshot();
		return;
	}
	const collectionId = label(String(collection.id), 'collection');
	for (const row of await query('SELECT id FROM test_run WHERE "collectionId" = ?', [
		collectionId,
	])) {
		if (!labels.has(String(row.id))) label(String(row.id), 'collection run');
		await waitForRun(String(row.id));
	}

	for (const user of ['owner', 'member', 'viewer']) {
		record[`list as ${user}`] = await call(user, 'get', base);
		record[`get as ${user}`] = await call(user, 'get', `${base}/${collectionId}`);
	}
	record['get unknown'] = await call('owner', 'get', `${base}/unknown`);
	record['versions after the runs'] = await call(
		'owner',
		'get',
		`${workflowBase}/eval-versions?evaluationConfigId=${configId}`,
	);
	record['rename as the viewer'] = await call('viewer', 'patch', `${base}/${collectionId}`, {
		name: 'Renamed',
	});
	record['rename as the editor'] = await call('editor', 'patch', `${base}/${collectionId}`, {
		name: 'Renamed',
		description: null,
	});

	record['insights without the AI Assistant feature'] = await call(
		'owner',
		'post',
		`${base}/${collectionId}/insights`,
		{},
	);
	testServer.license.enable('feat:aiAssistant');
	record['insights as the viewer'] = await call(
		'viewer',
		'post',
		`${base}/${collectionId}/insights`,
		{},
	);
	record.insights = await call('owner', 'post', `${base}/${collectionId}/insights`, {});
	record['insights again'] = await call('owner', 'post', `${base}/${collectionId}/insights`, {});
	record['insights, forced'] = await call('owner', 'post', `${base}/${collectionId}/insights`, {
		forceRegenerate: true,
	});

	const [member] = await query(
		'SELECT id FROM test_run WHERE "collectionId" = ? ORDER BY "createdAt" LIMIT 1',
		[collectionId],
	);
	const memberRunId = String(member.id);
	record['remove the first run'] = await call(
		'owner',
		'delete',
		`${base}/${collectionId}/runs/${memberRunId}`,
	);
	record['remove it again'] = await call(
		'owner',
		'delete',
		`${base}/${collectionId}/runs/${memberRunId}`,
	);
	record['add it as the viewer'] = await call('viewer', 'post', `${base}/${collectionId}/runs`, {
		testRunId: memberRunId,
	});
	record['add it back'] = await call('owner', 'post', `${base}/${collectionId}/runs`, {
		testRunId: memberRunId,
	});
	record['add a run without a pinned version'] = await call(
		'owner',
		'post',
		`${base}/${collectionId}/runs`,
		{ testRunId: runId },
	);
	record['add an unknown run'] = await call('owner', 'post', `${base}/${collectionId}/runs`, {
		testRunId: 'unknown',
	});

	// A real rerun is not recorded: on SQLite the original waits 60 seconds for the write lock and
	// fails. The fork has its own test of the rerun.
	record['rerun as the viewer'] = await call('viewer', 'post', `${base}/${collectionId}/rerun`);
	record['rerun of an unknown collection'] = await call('owner', 'post', `${base}/unknown/rerun`);
	record['detail at the end'] = await call('owner', 'get', `${base}/${collectionId}`);
	record['rows before the delete'] = await evaluationRows();

	record['delete as the viewer'] = await call('viewer', 'delete', `${base}/${collectionId}`);
	record.delete = await call('owner', 'delete', `${base}/${collectionId}`);
	record['delete again'] = await call('owner', 'delete', `${base}/${collectionId}`);
	record['rows after the delete'] = await evaluationRows();
	// Also telemetry that a call sends after its answer.
	record['all telemetry of the test'] = normalize(
		vi
			.mocked(Container.get(Telemetry).track)
			.mock.calls.map(([event, properties]) => ({ event, properties })),
	);
	expect(record).toMatchSnapshot();
}, 120_000);
