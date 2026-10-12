// Fork test (not in upstream n8n): a golden test of the public API of test runs
// (`/api/v1/workflows/:workflowId/test-runs`) with the real evaluation services behind the ordinary
// controller. It records the status and the body of each answer, and the rows of the test runs.
// The snapshot was recorded against the enterprise files, and the fork files give the same
// snapshot. See `packages/cli/src/evaluation/FORK.md`.
import { createWorkflow, shareWorkflowWithUsers, testDb } from '@n8n/backend-test-utils';
import { LICENSE_QUOTAS, UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { INode } from 'n8n-workflow';

import { DataTableService } from '@/modules/data-table/data-table.service';
import { Telemetry } from '@/telemetry';
import { createOwnerWithApiKey, createMemberWithApiKey } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';
import { loadNodesFromDist } from '@test-integration/utils/node-types-data';

const testServer = utils.setupTestServer({
	endpointGroups: ['publicApi'],
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

function normalize(value: unknown, key = ''): unknown {
	if (value instanceof Date) return '<Date>';
	if (['executionTime', 'duration', 'duration_ms', 'start'].includes(key)) return '<time>';
	if (typeof value === 'string') {
		const known = labels.get(value);
		if (known) return `@${known}`;
		if (DATE_TEXT.test(value)) return '<date>';
		let text = value;
		for (const [id, name] of labels) text = text.replaceAll(id, `@${name}`);
		return /^[A-Za-z0-9]{16}$/.test(text) && isGeneratedId(text) ? '<id>' : text;
	}
	if (key === 'executionId' && value !== null) return '<execution id>';
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
	return rows.map((row) =>
		Object.fromEntries(Object.entries(row).map(([key, value]) => [key, parseJsonText(value)])),
	);
}

let owner: User;
let ownerAgent: SuperAgentTest;
let memberAgent: SuperAgentTest;
let member: User;

async function call(agent: SuperAgentTest, method: 'get' | 'post', path: string) {
	const response = await agent[method](path);
	return normalize({ status: response.statusCode, body: response.body });
}

/** A run with cases, written with plain SQL. */
async function seedRun(
	workflowId: string,
	runId: string,
	status: string,
	cases: string[],
	createdAt: string,
) {
	label(runId, runId);
	await query(
		`INSERT INTO test_run (id, "workflowId", status, "runAt", "completedAt", metrics, "cancelRequested", "createdAt", "updatedAt")
		 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		[
			runId,
			workflowId,
			status,
			status === 'new' ? null : '2026-01-01 10:00:00.000',
			['completed', 'error', 'cancelled'].includes(status) ? '2026-01-01 10:05:00.000' : null,
			status === 'completed' ? '{"accuracy":0.5}' : null,
			createdAt,
			createdAt,
		],
	);
	for (const [index, caseStatus] of cases.entries()) {
		await query(
			`INSERT INTO test_case_execution (id, "testRunId", status, "runIndex", metrics, "errorCode", inputs, outputs)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				`${runId}-case-${index}`,
				runId,
				caseStatus,
				index,
				caseStatus === 'success' ? '{"accuracy":1}' : null,
				caseStatus === 'error' ? 'FAILED_TO_EXECUTE_WORKFLOW' : null,
				'{"q":"a"}',
				caseStatus === 'success' ? '{"a":"A"}' : null,
			],
		);
	}
}

const evaluationNodes = (dataTableId: string): INode[] => [
	{
		id: 'trigger',
		name: 'When fetching a dataset row',
		type: 'n8n-nodes-base.evaluationTrigger',
		typeVersion: 4.7,
		position: [0, 0],
		parameters: { source: 'dataTable', dataTableId: { mode: 'id', value: dataTableId } },
	},
	{
		id: 'metrics',
		name: 'Set metrics',
		type: 'n8n-nodes-base.evaluation',
		typeVersion: 4.8,
		position: [200, 0],
		parameters: {
			operation: 'setMetrics',
			metric: 'customMetrics',
			metrics: { assignments: [{ id: 'm1', name: 'score', value: '={{ 1 }}', type: 'number' }] },
		},
	},
];

beforeAll(async () => {
	await utils.initNodeTypes(
		loadNodesFromDist(['n8n-nodes-base.evaluationTrigger', 'n8n-nodes-base.evaluation']),
	);
	await utils.initBinaryDataService();
	owner = await createOwnerWithApiKey();
	member = await createMemberWithApiKey();
	label(owner.id, 'owner');
	label(member.id, 'member');
	ownerAgent = testServer.publicApiAgentFor(owner);
	memberAgent = testServer.publicApiAgentFor(member);
});

beforeEach(async () => {
	await testDb.truncate(['TestRun', 'TestCaseExecution']);
	testServer.license.setQuota(
		LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT,
		UNLIMITED_LICENSE_QUOTA,
	);
});

test('reads test runs and their cases', async () => {
	const workflow = await createWorkflow({ name: 'read' }, owner);
	label(workflow.id, 'workflow');
	const other = await createWorkflow({ name: 'other' }, owner);
	label(other.id, 'other workflow');
	await seedRun(
		workflow.id,
		'run-1',
		'completed',
		['success', 'success'],
		'2026-01-01 09:00:00.000',
	);
	await seedRun(
		workflow.id,
		'run-2',
		'completed',
		['success', 'error', 'warning'],
		'2026-01-01 09:01:00.000',
	);
	await seedRun(workflow.id, 'run-3', 'running', ['success', 'new'], '2026-01-01 09:02:00.000');
	await seedRun(workflow.id, 'run-4', 'new', [], '2026-01-01 09:03:00.000');
	await seedRun(workflow.id, 'run-5', 'error', ['error'], '2026-01-01 09:04:00.000');
	await seedRun(other.id, 'run-6', 'completed', ['success'], '2026-01-01 09:05:00.000');
	const base = `/workflows/${workflow.id}/test-runs`;
	const record: Record<string, unknown> = {
		list: await call(ownerAgent, 'get', base),
		'list, limit 2': await call(ownerAgent, 'get', `${base}?limit=2`),
		'list, completed': await call(ownerAgent, 'get', `${base}?status=completed`),
		'list as a member without access': await call(memberAgent, 'get', base),
	};
	for (const run of ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6', 'unknown']) {
		record[`get ${run}`] = await call(ownerAgent, 'get', `${base}/${run}`);
		record[`cases of ${run}`] = await call(ownerAgent, 'get', `${base}/${run}/test-cases`);
	}
	record['cases of run-2, limit 2'] = await call(
		ownerAgent,
		'get',
		`${base}/run-2/test-cases?limit=2`,
	);
	await shareWorkflowWithUsers(workflow, [member]);
	record['list as a member with access'] = await call(memberAgent, 'get', base);
	record['cancel as a member with read access'] = await call(
		memberAgent,
		'post',
		`${base}/run-3/cancel`,
	);
	expect(record).toMatchSnapshot();
});

test('cancels test runs', async () => {
	const workflow = await createWorkflow({ name: 'cancel' }, owner);
	label(workflow.id, 'workflow');
	await seedRun(workflow.id, 'run-new', 'new', ['new'], '2026-01-01 09:00:00.000');
	await seedRun(
		workflow.id,
		'run-running',
		'running',
		['success', 'running', 'new'],
		'2026-01-01 09:01:00.000',
	);
	for (const status of ['completed', 'error', 'cancelled']) {
		await seedRun(workflow.id, `run-${status}`, status, ['success'], '2026-01-01 09:02:00.000');
	}
	const base = `/workflows/${workflow.id}/test-runs`;
	const record: Record<string, unknown> = {};
	for (const run of ['run-new', 'run-running', 'run-completed', 'run-error', 'run-cancelled']) {
		record[`cancel ${run}`] = await call(ownerAgent, 'post', `${base}/${run}/cancel`);
	}
	record.rows = normalize({
		runs: await query(
			'SELECT id, status, "cancelRequested", "completedAt", "errorCode" FROM test_run ORDER BY id',
		),
		cases: await query('SELECT id, status, "completedAt" FROM test_case_execution ORDER BY id'),
	});
	expect(record).toMatchSnapshot();
});

test('starts test runs within the quota', async () => {
	const tables = Container.get(DataTableService);
	const project = await Container.get(DataSource).query<Array<{ id: string }>>(
		'SELECT p.id FROM project p JOIN project_relation r ON r."projectId" = p.id WHERE r."userId" = ? AND p.type = \'personal\'',
		[owner.id],
	);
	const table = await tables.createDataTable(project[0].id, {
		name: 'rows',
		columns: [{ name: 'q', type: 'string' }],
	});
	await tables.insertRows(table.id, project[0].id, [{ q: 'a' }, { q: 'b' }]);
	label(table.id, 'table');
	const first = await createWorkflow(
		{
			name: 'first',
			nodes: evaluationNodes(table.id),
			connections: {
				'When fetching a dataset row': {
					main: [[{ node: 'Set metrics', type: 'main', index: 0 }]],
				},
			},
		},
		owner,
	);
	label(first.id, 'first workflow');
	const second = await createWorkflow(
		{ name: 'second', nodes: evaluationNodes(table.id), connections: {} },
		owner,
	);
	label(second.id, 'second workflow');
	const record: Record<string, unknown> = {};

	const track = vi.mocked(Container.get(Telemetry).track);
	const start = async (name: string, workflowId: string) => {
		track.mockClear();
		const response = await ownerAgent.post(`/workflows/${workflowId}/test-runs`);
		if (response.body?.id) {
			label(response.body.id, `${name} run`);
			for (let attempt = 0; attempt < 300; attempt++) {
				const [run] = await query('SELECT status FROM test_run WHERE id = ?', [response.body.id]);
				if (run && ['completed', 'error', 'cancelled'].includes(String(run.status))) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		for (let attempt = 0; attempt < 20 && response.body?.id; attempt++) {
			if (track.mock.calls.some(([event]) => event === 'Test run finished')) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		record[name] = normalize({
			status: response.statusCode,
			body: response.body,
			telemetry: track.mock.calls.map(([event, properties]) => ({ event, properties })),
		});
	};

	testServer.license.setQuota(LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT, 0);
	await start('quota 0', first.id);
	testServer.license.setQuota(LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT, 1);
	await start('quota 1, first workflow', first.id);
	await start('quota 1, second workflow', second.id);
	await start('quota 1, first workflow again', first.id);
	record['no trigger'] = await call(
		ownerAgent,
		'post',
		`/workflows/${(await createWorkflow({ name: 'plain' }, owner)).id}/test-runs`,
	);
	record.rows = normalize({
		runs: await query('SELECT * FROM test_run ORDER BY "createdAt", id'),
		cases: await query(
			'SELECT c.* FROM test_case_execution c JOIN test_run r ON r.id = c."testRunId" ORDER BY r."createdAt", c."runIndex"',
		),
	});
	expect(record).toMatchSnapshot();
});
