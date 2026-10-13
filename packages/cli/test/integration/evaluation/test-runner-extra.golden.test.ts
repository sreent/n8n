// Fork test (not in upstream n8n): more golden cases of the evaluation test runner, end to end:
// error workflows, Set Inputs, several metrics nodes, the checks before a run, row indices, the
// cancellation of a running run and cases that run in parallel. It records the run, its test
// cases, their executions and the telemetry. The snapshot was recorded against the enterprise
// files, and the fork files give the same snapshot. See `packages/cli/src/evaluation/FORK.md`.
import { createTeamProject, createWorkflow } from '@n8n/backend-test-utils';
import { GlobalConfig } from '@n8n/config';
import { LICENSE_QUOTAS } from '@n8n/constants';
import type { Project, User } from '@n8n/db';
import { GLOBAL_OWNER_ROLE, WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { INode, IWorkflowBase } from 'n8n-workflow';

import { ActiveExecutions } from '@/active-executions';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { WorkflowRunner } from '@/workflow-runner';
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

const FINISHED = ['completed', 'error', 'cancelled'];

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

beforeAll(async () => {
	const nodeTypes = loadNodesFromDist([
		'n8n-nodes-base.evaluationTrigger',
		'n8n-nodes-base.evaluation',
		'n8n-nodes-base.set',
		'n8n-nodes-base.stopAndError',
		'n8n-nodes-base.manualTrigger',
		'n8n-nodes-base.errorTrigger',
		'n8n-nodes-base.noOp',
		'n8n-nodes-base.wait',
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

const node = (
	name: string,
	type: string,
	typeVersion: number,
	parameters: INode['parameters'],
	x = 0,
	y = 0,
): INode => ({
	id: name,
	name,
	type,
	typeVersion,
	position: [x, y],
	parameters,
});

const metricsNode = (name: string, metricName: string, value = '={{ 1 }}', x = 600, y = 0): INode =>
	node(
		name,
		'n8n-nodes-base.evaluation',
		4.8,
		{
			operation: 'setMetrics',
			metric: 'customMetrics',
			metrics: { assignments: [{ id: name, name: metricName, value, type: 'number' }] },
		},
		x,
		y,
	);

const fail = node(
	'Fail',
	'n8n-nodes-base.stopAndError',
	1,
	{ errorMessage: 'The case failed' },
	300,
	0,
);

const setInputs = node(
	'Set inputs',
	'n8n-nodes-base.evaluation',
	4.8,
	{
		operation: 'setInputs',
		inputs: { values: [{ inputName: 'asked', inputValue: '={{ $json.question }}' }] },
	},
	100,
	0,
);

const wait = (seconds: number) =>
	node(
		'Wait',
		'n8n-nodes-base.wait',
		1.1,
		{ resume: 'timeInterval', amount: seconds, unit: 'seconds' },
		300,
		0,
	);

async function workflowFrom(
	name: string,
	nodes: INode[],
	connections: IWorkflowBase['connections'],
	settings = {},
) {
	const workflow = await createWorkflow({ name, nodes, connections, settings }, project);
	label(workflow.id, `workflow ${name}`);
	return workflow.id;
}

const to = (...names: string[]) => ({
	main: [names.map((name) => ({ node: name, type: 'main' as const, index: 0 }))],
});

/** The cases of a run, without IDs, dates and timings. */
async function casesOf(runId: string) {
	return normalize(
		await query(
			'SELECT status, "runIndex", "errorCode", "errorDetails", metrics, inputs, outputs, "executionId" IS NOT NULL AS "hasExecution", "runAt" IS NOT NULL AS started, "completedAt" IS NOT NULL AS completed FROM test_case_execution WHERE "testRunId" = ? ORDER BY "runIndex"',
			[runId],
		),
	);
}

async function runOf(runId: string) {
	const [run] = await query(
		'SELECT status, "errorCode", "errorDetails", metrics, "cancelRequested", "runningInstanceId", "completedAt" IS NOT NULL AS completed FROM test_run WHERE id = ?',
		[runId],
	);
	return normalize(run);
}

async function waitUntilFinished(runId: string) {
	for (let attempt = 0; attempt < 300; attempt++) {
		const [run] = await query('SELECT status, "runningInstanceId" FROM test_run WHERE id = ?', [
			runId,
		]);
		if (run && FINISHED.includes(String(run.status)) && run.runningInstanceId === null) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`The test run ${runId} did not finish`);
}

/** Starts a run and records the run, its cases and the telemetry, without execution IDs. */
async function startAndRecordCases(workflowId: string, body: object = {}) {
	vi.mocked(Container.get(Telemetry).track).mockClear();
	const response = await ownerAgent.post(`/workflows/${workflowId}/test-runs/new`).send(body);
	const runId = response.body?.testRunId as string | undefined;
	if (!runId) return normalize({ status: response.statusCode, body: response.body });
	label(runId, 'run');
	await waitUntilFinished(runId);
	const record = {
		run: await runOf(runId),
		cases: await casesOf(runId),
		telemetry: normalize(await telemetrySinceLastCall(true)),
	};
	labels.delete(runId);
	return record;
}

/** The modes and states of all executions of a workflow. */
async function executionsOf(workflowId: string) {
	return normalize(
		await query(
			'SELECT mode, status, finished FROM execution_entity WHERE "workflowId" = ? ORDER BY id',
			[workflowId],
		),
	);
}

describe('a test run, more cases', () => {
	test('of a workflow with an error workflow', async () => {
		const table = await createDataset('errors', [{ question: 'a', expected: 'A' }]);
		const errorWorkflow = await workflowFrom(
			'error handler',
			[
				node('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, {}),
				node('Done', 'n8n-nodes-base.noOp', 1, {}, 200, 0),
			],
			{ 'Error Trigger': to('Done') },
		);
		const workflowId = await workflowFrom(
			'with error workflow',
			[trigger(table), fail, metricsNode('Metrics', 'score')],
			{ 'When fetching a dataset row': to('Fail'), Fail: to('Metrics') },
			{ errorWorkflow },
		);
		const record = await startAndRecordCases(workflowId);
		// The error workflow runs in the background: give it a moment.
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const afterTestRun = await executionsOf(errorWorkflow);
		// A control: the same workflow in an evaluation execution that no test run started.
		const workflow = await Container.get(WorkflowRepository).findOneByOrFail({ id: workflowId });
		const executionId = await Container.get(WorkflowRunner).run({
			executionMode: 'evaluation',
			workflowData: workflow,
			userId: owner.id,
			pinData: {
				'When fetching a dataset row': [{ json: { question: 'a', expected: 'A' } }],
			},
			triggerToStartFrom: { name: 'When fetching a dataset row' },
		});
		await Container.get(ActiveExecutions).getPostExecutePromise(executionId);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect({
			record,
			'executions of the error workflow after the test run': afterTestRun,
			'executions of the error workflow after a plain evaluation execution':
				await executionsOf(errorWorkflow),
		}).toMatchSnapshot();
	}, 120_000);

	test('with Set Inputs, Set Outputs and several metrics nodes', async () => {
		const table = await createDataset('inputs', [
			{ question: 'a', expected: 'A' },
			{ question: 'b', expected: 'B' },
		]);
		const record: Record<string, unknown> = {};
		record['inputs, then a failure'] = await startAndRecordCases(
			await workflowFrom(
				'inputs then failure',
				[trigger(table), setInputs, fail, metricsNode('Metrics', 'score')],
				{
					'When fetching a dataset row': to('Set inputs'),
					'Set inputs': to('Fail'),
					Fail: to('Metrics'),
				},
			),
		);
		record['inputs, outputs and metrics'] = await startAndRecordCases(
			await workflowFrom(
				'inputs outputs metrics',
				[trigger(table), setInputs, answer, setOutputs(table), metricsNode('Metrics', 'score')],
				{
					'When fetching a dataset row': to('Set inputs'),
					'Set inputs': to('Answer'),
					Answer: to('Set outputs'),
					'Set outputs': to('Metrics'),
				},
			),
		);
		record['two metrics nodes in parallel'] = await startAndRecordCases(
			await workflowFrom(
				'parallel metrics',
				[
					trigger(table),
					answer,
					metricsNode('First', 'first', '={{ 1 }}', 600, 0),
					metricsNode('Second', 'second', '={{ 2 }}', 600, 200),
				],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('First', 'Second') },
			),
		);
		record['two metrics nodes in a chain'] = await startAndRecordCases(
			await workflowFrom(
				'chained metrics',
				[
					trigger(table),
					answer,
					metricsNode('First', 'first', '={{ 1 }}'),
					metricsNode('Second', 'second', '={{ 2 }}', 800),
				],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('First'), First: to('Second') },
			),
		);
		record['two metrics nodes with one metric name'] = await startAndRecordCases(
			await workflowFrom(
				'same metric name',
				[
					trigger(table),
					answer,
					metricsNode('First', 'score', '={{ 1 }}', 600, 0),
					metricsNode('Second', 'score', '={{ 2 }}', 600, 200),
				],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('First', 'Second') },
			),
		);
		record['a disabled metrics node and an enabled one'] = await startAndRecordCases(
			await workflowFrom(
				'disabled and enabled metrics',
				[
					trigger(table),
					answer,
					{ ...metricsNode('First', 'first'), disabled: true },
					metricsNode('Second', 'second', '={{ 2 }}', 800),
				],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('First'), First: to('Second') },
			),
		);
		record['only a disabled metrics node'] = await startAndRecordCases(
			await workflowFrom(
				'only disabled metrics',
				[trigger(table), answer, { ...metricsNode('First', 'first'), disabled: true }],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('First') },
			),
		);
		record['a metrics node that does not run'] = await startAndRecordCases(
			await workflowFrom(
				'metrics not run',
				[
					trigger(table),
					node(
						'Check',
						'n8n-nodes-base.evaluation',
						4.8,
						{ operation: 'checkIfEvaluating' },
						200,
						0,
					),
					metricsNode('Metrics', 'score'),
				],
				{
					'When fetching a dataset row': to('Check'),
					Check: { main: [[], [{ node: 'Metrics', type: 'main' as const, index: 0 }]] },
				},
			),
		);
		expect(record).toMatchSnapshot();
	}, 120_000);

	test('with checks before the run and row indices', async () => {
		const table = await createDataset('checks', [
			{ question: 'a', expected: 'A' },
			{ question: 'b', expected: 'B' },
		]);
		const plain = await workflowFrom(
			'plain',
			[trigger(table), answer, metricsNode('Metrics', 'score')],
			{
				'When fetching a dataset row': to('Answer'),
				Answer: to('Metrics'),
			},
		);
		const record: Record<string, unknown> = {};
		record['a trigger without a table'] = await startAndRecordCases(
			await workflowFrom(
				'no table',
				[
					{
						...trigger(table),
						parameters: { source: 'dataTable', dataTableId: { mode: 'list', value: '' } },
					},
					answer,
					metricsNode('Metrics', 'score'),
				],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('Metrics') },
			),
		);
		record['a trigger with an unknown table'] = await startAndRecordCases(
			await workflowFrom(
				'unknown table',
				[
					{
						...trigger(table),
						parameters: { source: 'dataTable', dataTableId: { mode: 'id', value: 'missing' } },
					},
					answer,
					metricsNode('Metrics', 'score'),
				],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('Metrics') },
			),
		);
		record['an outputs node without a table'] = await startAndRecordCases(
			await workflowFrom(
				'outputs without table',
				[
					trigger(table),
					answer,
					{
						...setOutputs(table),
						parameters: {
							...setOutputs(table).parameters,
							dataTableId: { mode: 'list', value: '' },
						},
					},
					metricsNode('Metrics', 'score'),
				],
				{
					'When fetching a dataset row': to('Answer'),
					Answer: to('Set outputs'),
					'Set outputs': to('Metrics'),
				},
			),
		);
		record['an outputs node without the outputs parameter'] = await startAndRecordCases(
			await workflowFrom(
				'outputs without parameter',
				[
					trigger(table),
					answer,
					{
						...setOutputs(table),
						parameters: {
							operation: 'setOutputs',
							source: 'dataTable',
							dataTableId: { mode: 'id', value: table },
						},
					},
					metricsNode('Metrics', 'score'),
				],
				{
					'When fetching a dataset row': to('Answer'),
					Answer: to('Set outputs'),
					'Set outputs': to('Metrics'),
				},
			),
		);
		record['an output without a name'] = await startAndRecordCases(
			await workflowFrom(
				'unnamed output',
				[
					trigger(table),
					answer,
					{
						...setOutputs(table),
						parameters: {
							...setOutputs(table).parameters,
							outputs: { values: [{ outputName: '', outputValue: 'x' }] },
						},
					},
					metricsNode('Metrics', 'score'),
				],
				{
					'When fetching a dataset row': to('Answer'),
					Answer: to('Set outputs'),
					'Set outputs': to('Metrics'),
				},
			),
		);
		record['a metric without a name'] = await startAndRecordCases(
			await workflowFrom('unnamed metric', [trigger(table), answer, metricsNode('Metrics', '')], {
				'When fetching a dataset row': to('Answer'),
				Answer: to('Metrics'),
			}),
		);
		record['a correctness metric without a model'] = await startAndRecordCases(
			await workflowFrom(
				'judge without model',
				[
					trigger(table),
					answer,
					node(
						'Judge',
						'n8n-nodes-base.evaluation',
						4.8,
						{ operation: 'setMetrics', metric: 'correctness' },
						600,
						0,
					),
				],
				{ 'When fetching a dataset row': to('Answer'), Answer: to('Judge') },
			),
		);
		record['row indices out of range'] = await startAndRecordCases(plain, { rowIndices: [5] });
		record['row indices in and out of range'] = await startAndRecordCases(plain, {
			rowIndices: [1, 5, 0],
		});
		record['an empty list of row indices'] = await startAndRecordCases(plain, { rowIndices: [] });
		expect(record).toMatchSnapshot();
	}, 120_000);

	test('that a user cancels while a case runs', async () => {
		const table = await createDataset('cancel', [
			{ question: 'a', expected: 'A' },
			{ question: 'b', expected: 'B' },
			{ question: 'c', expected: 'C' },
		]);
		const workflowId = await workflowFrom(
			'slow',
			[trigger(table), wait(3), metricsNode('Metrics', 'score')],
			{
				'When fetching a dataset row': to('Wait'),
				Wait: to('Metrics'),
			},
		);
		vi.mocked(Container.get(Telemetry).track).mockClear();
		const response = await ownerAgent.post(`/workflows/${workflowId}/test-runs/new`).send({});
		const runId = response.body.testRunId as string;
		label(runId, 'run');
		for (let attempt = 0; attempt < 100; attempt++) {
			const running = await query(
				'SELECT id FROM test_case_execution WHERE "testRunId" = ? AND status = ?',
				[runId, 'running'],
			);
			if (running.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		// Give the execution of the case a moment to start.
		await new Promise((resolve) => setTimeout(resolve, 500));
		const cancel = await ownerAgent.post(`/workflows/${workflowId}/test-runs/${runId}/cancel`);
		await waitUntilFinished(runId);
		await new Promise((resolve) => setTimeout(resolve, 3500));
		expect({
			cancel: normalize({ status: cancel.statusCode, body: cancel.body }),
			run: await runOf(runId),
			cases: await casesOf(runId),
			executions: await executionsOf(workflowId),
			telemetry: normalize(await telemetrySinceLastCall(true)),
		}).toMatchSnapshot();
		labels.delete(runId);
	}, 120_000);

	test('with cases in parallel', async () => {
		const config = Container.get(GlobalConfig).executions.concurrency;
		const before = config.evaluationLimit;
		config.evaluationLimit = 3;
		process.env.N8N_CONCURRENCY_EVALUATION_LIMIT = '3';
		try {
			const table = await createDataset('parallel', [
				{ question: 'a', expected: 'A' },
				{ question: 'b', expected: 'B' },
				{ question: 'c', expected: 'C' },
				{ question: 'd', expected: 'D' },
			]);
			const workflowId = await workflowFrom(
				'parallel',
				[trigger(table), wait(1), metricsNode('Metrics', 'score')],
				{
					'When fetching a dataset row': to('Wait'),
					Wait: to('Metrics'),
				},
			);
			const record = {
				'concurrency 3': await startAndRecordCases(workflowId, { concurrency: 3 }),
				'concurrency 5': await startAndRecordCases(workflowId, { concurrency: 5 }),
			};
			expect(record).toMatchSnapshot();
		} finally {
			config.evaluationLimit = before;
			delete process.env.N8N_CONCURRENCY_EVALUATION_LIMIT;
		}
	}, 120_000);
});
