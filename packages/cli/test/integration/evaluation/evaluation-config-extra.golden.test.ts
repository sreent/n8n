// Fork test (not in upstream n8n): more golden cases of evaluation configs: the checks of a config,
// what happens to a config when its workflow changes, and runs of such a config. The snapshot was
// recorded against the enterprise files, and the fork files give the same snapshot. See
// `packages/cli/src/evaluation/FORK.md`.
import { createTeamProject, createWorkflow } from '@n8n/backend-test-utils';
import {
	CONFIG_EVALUATIONS_ENABLED_VARIANT,
	CONFIG_EVALUATIONS_FLAG,
	EVAL_COLLECTIONS_FLAG,
} from '@n8n/api-types';
import { LICENSE_QUOTAS } from '@n8n/constants';
import type { User } from '@n8n/db';
import { GLOBAL_OWNER_ROLE } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { INode, IWorkflowBase } from 'n8n-workflow';

import '@/evaluation/evaluation-config.controller';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { PostHogClient } from '@/posthog';
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

const FINISHED = ['completed', 'error', 'cancelled'];

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
			// A 16-character id must not be a part of a longer id: a nano id can hold a hyphen.
			.replace(/(?<![\w-])[A-Za-z0-9]{16}(?![\w-])/g, (match) =>
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

let owner: User;
let agent: SuperAgentTest;
let tableId: string;

const set = (name: string, x: number, field: string, value: string): INode => ({
	id: name,
	name,
	type: 'n8n-nodes-base.set',
	typeVersion: 3.4,
	position: [x, 0],
	parameters: {
		assignments: { assignments: [{ id: name, name: field, value, type: 'string' }] },
		includeOtherFields: true,
		options: {},
	},
});

const manual: INode = {
	id: 'manual',
	name: 'When clicking',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const link = (...names: string[]) => ({
	main: [names.map((node) => ({ node, type: 'main' as const, index: 0 }))],
});

const metric = (overrides: Record<string, unknown> = {}) => ({
	id: 'm1',
	name: 'Exact',
	type: 'expression',
	config: { expression: '={{ $json.final === $json.expected }}', outputType: 'boolean' },
	...overrides,
});

const configBody = (overrides: Record<string, unknown> = {}) => ({
	name: 'Config',
	datasetSource: 'data_table',
	datasetRef: { dataTableId: tableId },
	startNodeName: 'Prepare',
	endNodeName: 'Answer',
	metrics: [metric()],
	...overrides,
});

async function call(
	method: 'get' | 'post' | 'put' | 'patch' | 'delete',
	path: string,
	body?: object,
) {
	const request = agent[method](path);
	const response = body === undefined ? await request : await request.send(body);
	return normalize({ status: response.statusCode, body: response.body });
}

async function configRows() {
	return normalize(
		await query(
			'SELECT name, status, "invalidReason", "startNodeName", "endNodeName" FROM evaluation_config ORDER BY "createdAt", name',
		),
	);
}

async function waitForRun(runId: string) {
	for (let attempt = 0; attempt < 300; attempt++) {
		const [run] = await query('SELECT status, "runningInstanceId" FROM test_run WHERE id = ?', [
			runId,
		]);
		if (run && FINISHED.includes(String(run.status)) && run.runningInstanceId === null) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`The test run ${runId} did not finish`);
}

beforeAll(async () => {
	await utils.initNodeTypes(
		loadNodesFromDist([
			'n8n-nodes-base.evaluationTrigger',
			'n8n-nodes-base.evaluation',
			'n8n-nodes-base.set',
			'n8n-nodes-base.manualTrigger',
		]),
	);
	await utils.initBinaryDataService();
	vi.mocked(Container.get(PostHogClient).getFeatureFlags).mockResolvedValue({
		[EVAL_COLLECTIONS_FLAG]: true,
		[CONFIG_EVALUATIONS_FLAG]: CONFIG_EVALUATIONS_ENABLED_VARIANT,
	});
	owner = await createUserShell(GLOBAL_OWNER_ROLE);
	label(owner.id, 'owner');
	agent = testServer.authAgentFor(owner);
	const project = await createTeamProject('Evals', owner);
	label(project.id, 'project');
	const tables = Container.get(DataTableService);
	tableId = label(
		(
			await tables.createDataTable(project.id, {
				name: 'cases',
				columns: [
					{ name: 'question', type: 'string' },
					{ name: 'expected', type: 'string' },
				],
			})
		).id,
		'table',
	);
	await tables.insertRows(tableId, project.id, [{ question: 'a', expected: 'A' }]);
	(globalThis as Record<string, unknown>).evaluationProject = project;
});

test('the checks of a config', async () => {
	const project = (globalThis as Record<string, unknown>).evaluationProject as Parameters<
		typeof createWorkflow
	>[1];
	const record: Record<string, unknown> = {};
	const create = async (
		name: string,
		nodes: INode[],
		connections: IWorkflowBase['connections'],
		body: object,
	) => {
		const workflow = await createWorkflow({ name, nodes, connections }, project);
		label(workflow.id, `workflow ${name}`);
		record[name] = await call('post', `/workflows/${workflow.id}/evaluation-configs`, body);
	};
	const chain = [
		manual,
		set('Seed', 200, 'question', 'q'),
		set('Prepare', 400, 'answer', '={{ $json.question }}'),
		set('Answer', 600, 'final', '={{ $json.answer }}'),
	];
	const chainLinks = {
		'When clicking': link('Seed'),
		Seed: link('Prepare'),
		Prepare: link('Answer'),
	};
	await create(
		'a node with the reserved prefix',
		[...chain, set('__eval_custom', 800, 'x', 'y')],
		chainLinks,
		configBody(),
	);
	await create(
		'a start node with two inputs',
		[...chain, set('Other', 200, 'question', 'o')],
		{ ...chainLinks, 'When clicking': link('Seed', 'Other'), Other: link('Prepare') },
		configBody(),
	);
	await create(
		'a trigger as the start node',
		chain,
		chainLinks,
		configBody({ startNodeName: 'When clicking' }),
	);
	await create(
		'a start node without inputs',
		[...chain, set('Lonely', 200, 'question', 'l')],
		{ ...chainLinks, Lonely: link('Answer') },
		configBody({ startNodeName: 'Lonely' }),
	);
	await create(
		'a boolean of two expressions',
		chain,
		chainLinks,
		configBody({
			metrics: [
				metric({
					config: { expression: '={{ $json.a }} and {{ $json.b }}', outputType: 'boolean' },
				}),
			],
		}),
	);
	await create(
		'a boolean without an expression',
		chain,
		chainLinks,
		configBody({
			metrics: [metric({ config: { expression: 'true', outputType: 'boolean' } })],
		}),
	);
	await create(
		'an expression of spaces',
		chain,
		chainLinks,
		configBody({
			metrics: [metric({ config: { expression: '   ', outputType: 'numeric' } })],
		}),
	);
	await create(
		'a similarity input of spaces',
		chain,
		chainLinks,
		configBody({
			metrics: [
				{
					id: 's',
					name: 'Sim',
					type: 'string_similarity',
					config: { inputs: { actualAnswer: '={{ $json.final }}', expectedAnswer: '  ' } },
				},
			],
		}),
	);
	await create(
		'tools with an input of spaces',
		chain,
		chainLinks,
		configBody({
			metrics: [
				{
					id: 't',
					name: 'Tools',
					type: 'tools_used',
					config: { inputs: { expectedTools: ' ', intermediateSteps: '={{ $json.steps }}' } },
				},
			],
		}),
	);
	await create(
		'a Google Sheet',
		chain,
		chainLinks,
		configBody({
			datasetSource: 'google_sheets',
			datasetRef: { credentialId: 'c', spreadsheetId: 's', sheetName: 'Sheet1' },
		}),
	);
	await create(
		'an unknown table',
		chain,
		chainLinks,
		configBody({ datasetRef: { dataTableId: 'missing' } }),
	);
	await create(
		'two problems: an unknown start node and two metric ids',
		chain,
		chainLinks,
		configBody({
			startNodeName: 'Missing',
			metrics: [metric(), metric({ name: 'Other' })],
		}),
	);
	await create(
		'two problems: two metric ids and an unknown table',
		chain,
		chainLinks,
		configBody({
			datasetRef: { dataTableId: 'missing' },
			metrics: [metric(), metric({ name: 'Other' })],
		}),
	);
	await create(
		'two problems: an unreachable end node and an unknown table',
		chain,
		chainLinks,
		configBody({
			startNodeName: 'Answer',
			endNodeName: 'Prepare',
			datasetRef: { dataTableId: 'missing' },
		}),
	);
	await create(
		'two problems: a Google Sheet and an unknown start node',
		chain,
		chainLinks,
		configBody({
			startNodeName: 'Missing',
			datasetSource: 'google_sheets',
			datasetRef: { credentialId: 'c', spreadsheetId: 's', sheetName: 'Sheet1' },
		}),
	);
	record.rows = await configRows();
	expect(record).toMatchSnapshot();
});

test('a config when its workflow changes', async () => {
	const project = (globalThis as Record<string, unknown>).evaluationProject as Parameters<
		typeof createWorkflow
	>[1];
	await query('DELETE FROM evaluation_config');
	const chain = [
		manual,
		set('Seed', 200, 'question', 'q'),
		set('Prepare', 400, 'answer', '={{ $json.question }}'),
		set('Answer', 600, 'final', '={{ $json.answer }}'),
	];
	const chainLinks = {
		'When clicking': link('Seed'),
		Seed: link('Prepare'),
		Prepare: link('Answer'),
	};
	const workflow = await createWorkflow(
		{ name: 'changing', nodes: chain, connections: chainLinks },
		project,
	);
	label(workflow.id, 'workflow');
	const base = `/workflows/${workflow.id}/evaluation-configs`;
	const record: Record<string, unknown> = {};
	record.create = await call('post', base, configBody());
	const [config] = await query('SELECT id FROM evaluation_config');
	const configId = label(String(config.id), 'config');
	record['create a second'] = await call(
		'post',
		base,
		configBody({ name: 'Second', endNodeName: 'Prepare' }),
	);

	const current = await agent.get(`/workflows/${workflow.id}`);
	const versionId = current.body.data.versionId;
	// Remove the end node "Answer" of the first config.
	record['save the workflow without the end node'] = normalize({
		status: (
			await agent.patch(`/workflows/${workflow.id}`).send({
				versionId,
				nodes: chain.slice(0, 3),
				connections: { 'When clicking': link('Seed'), Seed: link('Prepare') },
			})
		).statusCode,
	});
	record['rows after the save'] = await configRows();
	record['list after the save'] = await call('get', base);
	record['get after the save'] = await call('get', `${base}/${configId}`);

	const start = await agent.post(`/workflows/${workflow.id}/test-runs/new`).send({
		evaluationConfigId: configId,
		compileFromConfig: true,
	});
	record['start a compiled run of the broken config'] = normalize({
		status: start.statusCode,
		body: start.body,
	});
	if (start.body?.testRunId) {
		label(start.body.testRunId, 'run');
		await waitForRun(start.body.testRunId);
		record['the broken run'] = normalize(
			await query('SELECT status, "errorCode", "errorDetails" FROM test_run WHERE id = ?', [
				start.body.testRunId,
			]),
		);
	}
	record['update the broken config to a valid one'] = await call(
		'put',
		`${base}/${configId}`,
		configBody({ endNodeName: 'Prepare' }),
	);
	record['rows after the update'] = await configRows();
	expect(record).toMatchSnapshot();
}, 120_000);
