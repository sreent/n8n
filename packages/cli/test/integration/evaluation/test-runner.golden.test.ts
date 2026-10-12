// Fork test (not in upstream n8n): a golden test of the evaluation test runner, end to end. It
// starts test runs through the REST API on workflows with the Evaluation nodes and a Data table
// dataset, waits for each run, and records the run, its test cases, their executions, and the rows
// of the dataset after the run. The snapshot was recorded against the enterprise files, and the
// fork files give the same snapshot. See `packages/cli/src/evaluation/FORK.md`.
import { createTeamProject, createWorkflow } from '@n8n/backend-test-utils';
import { LICENSE_QUOTAS } from '@n8n/constants';
import type { Project, User } from '@n8n/db';
import { GLOBAL_OWNER_ROLE } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { INode, IWorkflowBase } from 'n8n-workflow';

import { DataTableService } from '@/modules/data-table/data-table.service';
import { Telemetry } from '@/telemetry';
import { createUserShell } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';
import { loadNodesFromDist } from '@test-integration/utils/node-types-data';

const testServer = utils.setupTestServer({
	endpointGroups: ['workflows', 'evaluation'],
	enabledFeatures: ['feat:sharing'],
	quotas: { [LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT]: -1 },
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
const ID_KEYS = ['executionId'];

function normalize(value: unknown, key = ''): unknown {
	if (value instanceof Date) return '<Date>';
	if (
		['executionTime', 'duration', 'duration_ms', 'start'].includes(key) ||
		key.endsWith('Duration')
	) {
		return '<duration>';
	}
	if (typeof value === 'number' && ID_KEYS.includes(key)) {
		const known = labels.get(String(value));
		return known ? `@${known}` : value;
	}
	if (typeof value === 'string') {
		const known = labels.get(value);
		if (known) return `@${known}`;
		if (DATE_TEXT.test(value)) return '<date>';
		let text = value.replace(/\b[A-Za-z0-9]{16}\b/g, (match) =>
			labels.has(match) ? `@${labels.get(match)}` : isGeneratedId(match) ? '<id>' : match,
		);
		// Short labels (execution IDs) match only a whole value, not a part of a text.
		for (const [id, name] of labels) if (id.length >= 8) text = text.replaceAll(id, `@${name}`);
		return text;
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

let owner: User;
let ownerAgent: SuperAgentTest;
let projectId: string;
let project: Project;

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

/** A Data table with the cases of a test. */
async function createDataset(name: string, rows: Array<Record<string, string>>) {
	const service = Container.get(DataTableService);
	const table = await service.createDataTable(projectId, {
		name,
		columns: [
			{ name: 'question', type: 'string' },
			{ name: 'expected', type: 'string' },
		],
	});
	if (rows.length) await service.insertRows(table.id, projectId, rows);
	return label(table.id, `table ${name}`);
}

const trigger = (dataTableId: string, extra: Partial<INode> = {}): INode => ({
	id: 'trigger',
	name: 'When fetching a dataset row',
	type: 'n8n-nodes-base.evaluationTrigger',
	typeVersion: 4.7,
	position: [0, 0],
	parameters: { source: 'dataTable', dataTableId: { mode: 'id', value: dataTableId } },
	...extra,
});

const answer: INode = {
	id: 'answer',
	name: 'Answer',
	type: 'n8n-nodes-base.set',
	typeVersion: 3.4,
	position: [200, 0],
	parameters: {
		assignments: {
			assignments: [
				{ id: 'a1', name: 'answer', value: '={{ $json.question.toUpperCase() }}', type: 'string' },
			],
		},
		includeOtherFields: true,
		options: {},
	},
};

const setOutputs = (dataTableId: string): INode => ({
	id: 'outputs',
	name: 'Set outputs',
	type: 'n8n-nodes-base.evaluation',
	typeVersion: 4.8,
	position: [400, 0],
	parameters: {
		operation: 'setOutputs',
		source: 'dataTable',
		dataTableId: { mode: 'id', value: dataTableId },
		outputs: { values: [{ outputName: 'actual', outputValue: '={{ $json.answer }}' }] },
	},
});

const setMetrics = (
	value = "={{ $json.answer === $('When fetching a dataset row').item.json.expected ? 1 : 0 }}",
): INode => ({
	id: 'metrics',
	name: 'Set metrics',
	type: 'n8n-nodes-base.evaluation',
	typeVersion: 4.8,
	position: [600, 0],
	parameters: {
		operation: 'setMetrics',
		metric: 'customMetrics',
		metrics: { assignments: [{ id: 'm1', name: 'accuracy', value, type: 'number' }] },
	},
});

function chain(nodes: INode[]): Pick<IWorkflowBase, 'nodes' | 'connections'> {
	const connections: IWorkflowBase['connections'] = {};
	for (let index = 0; index < nodes.length - 1; index++) {
		connections[nodes[index].name] = {
			main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]],
		};
	}
	return { nodes, connections };
}

async function workflowWith(name: string, nodes: INode[]) {
	// The workflow and its dataset are in the same project.
	const workflow = await createWorkflow({ name, ...chain(nodes) }, project);
	label(workflow.id, `workflow ${name}`);
	return workflow.id;
}

const FINISHED = ['completed', 'error', 'cancelled'];

/** Waits until the run has finished, then gives the run as the REST API shows it. */
async function waitForRun(workflowId: string, runId: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const response = await ownerAgent.get(`/workflows/${workflowId}/test-runs/${runId}`);
		const run = response.body.data;
		if (run && FINISHED.includes(run.status)) {
			// A finished run can keep its instance for a moment. Wait up to 2 seconds for it to go.
			for (let settle = 0; settle < 20 && run.runningInstanceId; settle++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				const again = await ownerAgent.get(`/workflows/${workflowId}/test-runs/${runId}`);
				Object.assign(run, again.body.data);
			}
			return run;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`The test run ${runId} did not finish`);
}

/** The rows of a run: the run, its cases in the order of the dataset, and their executions. */
async function rowsOfRun(runId: string, dataTableId?: string) {
	const [run] = await query('SELECT * FROM test_run WHERE id = ?', [runId]);
	const cases = await query(
		'SELECT * FROM test_case_execution WHERE "testRunId" = ? ORDER BY "runIndex", "createdAt"',
		[runId],
	);
	const executions = [];
	for (const testCase of cases) {
		if (testCase.executionId === null) continue;
		label(String(testCase.executionId), `execution of case ${String(testCase.runIndex)}`);
		const [execution] = await query(
			'SELECT id, mode, status, finished, "workflowId" FROM execution_entity WHERE id = ?',
			[testCase.executionId],
		);
		executions.push({ ...execution, id: `@execution of case ${String(testCase.runIndex)}` });
	}
	const dataset = dataTableId
		? await query(`SELECT * FROM "data_table_user_${dataTableId}" ORDER BY id`)
		: undefined;
	// All executions of the workflow, also those that no case names (for example a dataset read).
	const allExecutions = run
		? (
				await query(
					'SELECT id, mode, status, finished FROM execution_entity WHERE "workflowId" = ? ORDER BY id',
					[run.workflowId],
				)
			).map((execution) => ({
				...execution,
				id: labels.has(String(execution.id))
					? `@${labels.get(String(execution.id))}`
					: '<other execution>',
			}))
		: [];
	return normalize({ run, cases, executions, allExecutions, dataset });
}

/** Starts a run through the REST API and records the answer, the finished run and its rows. */
/** The telemetry since the last call, after the event of a finished run is in (up to 2 seconds). */
async function telemetrySinceLastCall(expectFinished: boolean) {
	const track = vi.mocked(Container.get(Telemetry).track);
	for (let attempt = 0; attempt < 20 && expectFinished; attempt++) {
		if (track.mock.calls.some(([event]) => event === 'Test run finished')) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const calls = track.mock.calls.map(([event, properties]) => ({ event, properties }));
	track.mockClear();
	return calls;
}

async function startAndRecord(workflowId: string, body: object = {}, dataTableId?: string) {
	vi.mocked(Container.get(Telemetry).track).mockClear();
	const response = await ownerAgent.post(`/workflows/${workflowId}/test-runs/new`).send(body);
	const record: Record<string, unknown> = {
		start: normalize({ status: response.statusCode, body: response.body }),
	};
	const runId = response.body?.testRunId as string | undefined;
	if (!runId) return record;
	label(runId, 'run');
	const run = await waitForRun(workflowId, runId);
	record.finished = normalize(run);
	record.rows = await rowsOfRun(runId, dataTableId);
	const cases = await ownerAgent.get(`/workflows/${workflowId}/test-runs/${runId}/test-cases`);
	record.testCases = normalize({ status: cases.statusCode, body: cases.body });
	record.telemetry = normalize(await telemetrySinceLastCall(true));
	labels.delete(runId);
	return record;
}

beforeAll(async () => {
	const nodeTypes = loadNodesFromDist([
		'n8n-nodes-base.evaluationTrigger',
		'n8n-nodes-base.evaluation',
		'n8n-nodes-base.set',
		'n8n-nodes-base.stopAndError',
		'n8n-nodes-base.manualTrigger',
	]);
	await utils.initNodeTypes(nodeTypes);
	await utils.initBinaryDataService();

	owner = await createUserShell(GLOBAL_OWNER_ROLE);
	label(owner.id, 'owner');
	ownerAgent = testServer.authAgentFor(owner);
	project = await createTeamProject('Evals', owner);
	projectId = label(project.id, 'project');
});

afterEach(() => {
	testServer.license.reset();
});

describe('a test run', () => {
	test('of a workflow with a dataset, outputs and metrics', async () => {
		const table = await createDataset('happy', [
			{ question: 'a', expected: 'A' },
			{ question: 'b', expected: 'X' },
			{ question: 'c', expected: 'C' },
		]);
		const workflowId = await workflowWith('happy', [
			trigger(table),
			answer,
			setOutputs(table),
			setMetrics(),
		]);
		expect(await startAndRecord(workflowId, {}, table)).toMatchSnapshot();
	}, 120_000);

	test('with a concurrency of 3 and with some rows only', async () => {
		const table = await createDataset('rows', [
			{ question: 'a', expected: 'A' },
			{ question: 'b', expected: 'B' },
			{ question: 'c', expected: 'X' },
			{ question: 'd', expected: 'D' },
		]);
		const workflowId = await workflowWith('rows', [trigger(table), answer, setMetrics()]);
		const record = {
			concurrency: await startAndRecord(workflowId, { concurrency: 3 }, table),
			rows: await startAndRecord(workflowId, { rowIndices: [1, 3] }, table),
		};
		expect(record).toMatchSnapshot();
	}, 120_000);

	test('that cannot start', async () => {
		const table = await createDataset('broken', [{ question: 'a', expected: 'A' }]);
		const empty = await createDataset('empty', []);
		const record = {
			'no trigger': await startAndRecord(
				await workflowWith('no trigger', [
					{
						...answer,
						name: 'Start',
						type: 'n8n-nodes-base.manualTrigger',
						typeVersion: 1,
						parameters: {},
					},
					setMetrics(),
				]),
			),
			'a disabled trigger': await startAndRecord(
				await workflowWith('disabled trigger', [
					trigger(table, { disabled: true }),
					answer,
					setMetrics(),
				]),
			),
			'no metrics node': await startAndRecord(
				await workflowWith('no metrics', [trigger(table), answer]),
			),
			'a metrics node without metrics': await startAndRecord(
				await workflowWith('empty metrics', [
					trigger(table),
					answer,
					{
						...setMetrics(),
						parameters: {
							operation: 'setMetrics',
							metric: 'customMetrics',
							metrics: { assignments: [] },
						},
					},
				]),
			),
			'an outputs node without outputs': await startAndRecord(
				await workflowWith('empty outputs', [
					trigger(table),
					answer,
					{
						...setOutputs(table),
						parameters: { ...setOutputs(table).parameters, outputs: { values: [] } },
					},
					setMetrics(),
				]),
			),
			'an empty dataset': await startAndRecord(
				await workflowWith('empty dataset', [trigger(empty), answer, setMetrics()]),
			),
			'an unknown workflow': await startAndRecord('unknown'),
		};
		expect(record).toMatchSnapshot();
	}, 120_000);

	test('with cases that fail', async () => {
		const table = await createDataset('failing', [
			{ question: 'a', expected: 'A' },
			{ question: 'fail', expected: 'X' },
			{ question: 'c', expected: 'C' },
		]);
		const failOn: INode = {
			id: 'fail',
			name: 'Fail',
			type: 'n8n-nodes-base.stopAndError',
			typeVersion: 1,
			position: [300, 0],
			parameters: { errorMessage: 'The case failed' },
		};
		const failing = await workflowWith('fails always', [
			trigger(table),
			answer,
			failOn,
			setMetrics(),
		]);
		const invalid = await workflowWith('invalid metric', [
			trigger(table),
			answer,
			setMetrics('={{ "not a number" }}'),
		]);
		const record = {
			'a failing node': await startAndRecord(failing, {}, table),
			'a metric that is not a number': await startAndRecord(invalid, {}, table),
		};
		expect(record).toMatchSnapshot();
	}, 120_000);

	test('without the quota', async () => {
		const table = await createDataset('quota', [{ question: 'a', expected: 'A' }]);
		const workflowId = await workflowWith('quota', [trigger(table), answer, setMetrics()]);
		testServer.license.setQuota(LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT, 0);
		const record: Record<string, unknown> = { 'quota 0': await startAndRecord(workflowId) };
		testServer.license.setQuota(LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT, 1);
		record['quota 1, a new workflow'] = await startAndRecord(workflowId);
		const other = await workflowWith('quota 2', [trigger(table), answer, setMetrics()]);
		record['quota 1, a second workflow'] = await startAndRecord(other);
		record['quota 1, the first workflow again'] = await startAndRecord(workflowId);
		expect(record).toMatchSnapshot();
	}, 120_000);
});
