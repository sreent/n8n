// Fork test (not in upstream n8n): a golden test of the agent eval repositories of `@n8n/db`. It
// calls each method as the ordinary module `agent-evals` does, and records the result and the
// changes to the rows of the four tables. The snapshot was recorded against the enterprise files,
// and the fork files give the same snapshot. See `packages/@n8n/db/src/entities/FORK.md`.
import { createTeamProject, testDb, testModules } from '@n8n/backend-test-utils';
import {
	AgentEvalDatasetRepository,
	AgentEvalRatingRepository,
	AgentEvalResultRepository,
	AgentEvalRunRepository,
	GLOBAL_OWNER_ROLE,
	type User,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { Agent } from '@/modules/agents/entities/agent.entity';
import { createUserShell } from '@test-integration/db/users';

const TABLES = ['agent_eval_dataset', 'agent_eval_run', 'agent_eval_result', 'agent_eval_rating'];
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
const NANO_ID = /^[A-Za-z0-9]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const labels = new Map<string, string>();
const label = (id: string, name: string) => {
	labels.set(id, name);
	return id;
};

/** Labels for known ids, the format of other ids and of dates. */
function normalize(value: unknown): unknown {
	if (value instanceof Date) return '<Date>';
	if (typeof value === 'string') {
		const known = labels.get(value);
		if (known) return `@${known}`;
		if (DATE_TEXT.test(value)) return `<date ${value.replace(/\d/g, 'd')}>`;
		if (NANO_ID.test(value) && /\d/.test(value)) return '<nano id>';
		if (UUID.test(value)) return '<uuid>';
		let text = value;
		for (const [id, name] of labels) text = text.replaceAll(id, `@${name}`);
		return text;
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === 'object') {
		const copy: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) copy[key] = normalize(inner);
		const name = value.constructor?.name;
		return name && name !== 'Object' ? { '<class>': name, ...copy } : copy;
	}
	return value;
}

type Rows = Record<string, Map<string, Record<string, unknown>>>;

async function readRows(): Promise<Rows> {
	const manager = Container.get(DataSource).manager;
	const rows: Rows = {};
	for (const table of TABLES) {
		const list = await manager.query<Array<Record<string, unknown>>>(`SELECT * FROM "${table}"`);
		rows[table] = new Map(list.map((row) => [String(row.id), row]));
	}
	return rows;
}

/** The rows that a call added, removed or changed, with the changed columns. */
function diffRows(before: Rows, after: Rows) {
	const diff: Record<string, unknown> = {};
	for (const table of TABLES) {
		const added: unknown[] = [];
		const removed: unknown[] = [];
		const changed: Record<string, unknown> = {};
		for (const [id, row] of after[table]) {
			const old = before[table].get(id);
			if (!old) {
				added.push(normalize(row));
				continue;
			}
			const columns: Record<string, unknown> = {};
			for (const [column, value] of Object.entries(row)) {
				if (old[column] !== value) columns[column] = normalize(value);
			}
			if (Object.keys(columns).length > 0) changed[String(normalize(id))] = columns;
		}
		for (const id of before[table].keys()) {
			if (!after[table].has(id)) removed.push(normalize(id));
		}
		const entry: Record<string, unknown> = {};
		if (added.length) entry.added = added;
		if (removed.length) entry.removed = removed;
		if (Object.keys(changed).length) entry.changed = changed;
		if (Object.keys(entry).length) diff[table] = entry;
	}
	return diff;
}

const tick = async () => await new Promise((resolve) => setTimeout(resolve, 15));

/**
 * Runs one call and records its result or error, and the row changes. `CURRENT_TIMESTAMP` of
 * SQLite has whole seconds, so each call starts with an old `updatedAt` in all rows: a write of
 * `updatedAt` always shows as a change.
 */
async function record(call: () => Promise<unknown>) {
	await tick();
	const manager = Container.get(DataSource).manager;
	for (const table of TABLES) {
		await manager.query(`UPDATE "${table}" SET "updatedAt" = '2000-01-01 00:00:00.000'`);
	}
	const before = await readRows();
	let outcome: Record<string, unknown>;
	try {
		outcome = { result: normalize(await call()) };
	} catch (error) {
		const e = error as Error;
		outcome = { error: `${e.constructor.name}: ${String(normalize(e.message))}` };
	}
	return { ...outcome, rows: diffRows(before, await readRows()) };
}

let owner: User;
let datasets: AgentEvalDatasetRepository;
let runs: AgentEvalRunRepository;
let results: AgentEvalResultRepository;
let ratings: AgentEvalRatingRepository;

async function createAgent(name: string) {
	const project = await createTeamProject();
	const agent = await Container.get(DataSource)
		.getRepository(Agent)
		.save(Object.assign(new Agent(), { name, projectId: project.id }));
	label(project.id, `project of ${name}`);
	return label(agent.id, name);
}

beforeAll(async () => {
	await testModules.loadModules(['agents']);
	await testDb.init();
	owner = await createUserShell(GLOBAL_OWNER_ROLE);
	label(owner.id, 'owner');
	datasets = Container.get(AgentEvalDatasetRepository);
	runs = Container.get(AgentEvalRunRepository);
	results = Container.get(AgentEvalResultRepository);
	ratings = Container.get(AgentEvalRatingRepository);
});

beforeEach(async () => {
	await testDb.truncate(['AgentEvalRating', 'AgentEvalResult', 'AgentEvalRun', 'AgentEvalDataset']);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('AgentEvalDatasetRepository', () => {
	test('creates, lists, reads, updates and deletes datasets', async () => {
		const agentA = await createAgent('agent A');
		const agentB = await createAgent('agent B');
		const steps: Record<string, unknown> = {};

		steps['create minimal'] = await record(async () => {
			const dataset = await datasets.createDataset({
				name: 'minimal',
				agentId: agentA,
				datasetSource: 'data_table',
				datasetRef: { dataTableId: 'dt-1' },
			});
			label(dataset.id, 'dataset minimal');
			return dataset;
		});
		steps['create full'] = await record(async () => {
			const dataset = await datasets.createDataset({
				name: 'full',
				agentId: agentA,
				datasetSource: 'google_sheets',
				datasetRef: { credentialId: 'cred-1', spreadsheetId: 'sheet-1', sheetName: 'Cases' },
				description: 'All fields',
				columnMapping: { input: 'q', expectedOutput: 'a', criteria: 'c' },
				createdById: owner.id,
			});
			label(dataset.id, 'dataset full');
			return dataset;
		});
		steps['create with an unknown source'] = await record(
			async () =>
				await datasets.createDataset({
					name: 'bad',
					agentId: agentA,
					// @ts-expect-error The check constraint allows two sources only.
					datasetSource: 'csv',
					datasetRef: { dataTableId: 'dt-2' },
				}),
		);
		steps['create for an unknown agent'] = await record(
			async () =>
				await datasets.createDataset({
					name: 'orphan',
					agentId: 'missing-agent',
					datasetSource: 'data_table',
					datasetRef: { dataTableId: 'dt-3' },
				}),
		);
		const other = await datasets.createDataset({
			name: 'other agent',
			agentId: agentB,
			datasetSource: 'data_table',
			datasetRef: { dataTableId: 'dt-4' },
		});
		label(other.id, 'dataset of agent B');
		const minimal = [...labels].find(([, name]) => name === 'dataset minimal')![0];

		steps['findByAgentId A'] = await record(async () => await datasets.findByAgentId(agentA));
		steps['findByAgentId unknown'] = await record(async () => await datasets.findByAgentId('x'));
		steps['findById'] = await record(async () => await datasets.findById(minimal));
		steps['findById unknown'] = await record(async () => await datasets.findById('x'));
		steps['findByIdAndAgentId own'] = await record(
			async () => await datasets.findByIdAndAgentId(minimal, agentA),
		);
		steps['findByIdAndAgentId foreign'] = await record(
			async () => await datasets.findByIdAndAgentId(minimal, agentB),
		);
		steps['update name'] = await record(
			async () => await datasets.updateDataset(minimal, agentA, { name: 'renamed' }),
		);
		steps['update all fields'] = await record(
			async () =>
				await datasets.updateDataset(minimal, agentA, {
					name: 'all',
					description: 'set',
					columnMapping: { input: 'question' },
				}),
		);
		steps['update to null'] = await record(
			async () =>
				await datasets.updateDataset(minimal, agentA, { description: null, columnMapping: null }),
		);
		steps['update without fields'] = await record(
			async () => await datasets.updateDataset(minimal, agentA, {}),
		);
		steps['update with undefined fields'] = await record(
			async () =>
				await datasets.updateDataset(minimal, agentA, { name: undefined, description: undefined }),
		);
		steps['update foreign'] = await record(
			async () => await datasets.updateDataset(minimal, agentB, { name: 'stolen' }),
		);
		steps['update unknown'] = await record(
			async () => await datasets.updateDataset('x', agentA, { name: 'ghost' }),
		);
		steps['delete foreign'] = await record(
			async () => await datasets.deleteDataset(minimal, agentB),
		);
		steps['delete own'] = await record(async () => await datasets.deleteDataset(minimal, agentA));
		steps['delete again'] = await record(async () => await datasets.deleteDataset(minimal, agentA));

		expect(steps).toMatchSnapshot();
	});
});

async function seedDataset(agentName: string) {
	const agent = await createAgent(agentName);
	const dataset = await datasets.createDataset({
		name: `dataset of ${agentName}`,
		agentId: agent,
		datasetSource: 'data_table',
		datasetRef: { dataTableId: 'dt' },
	});
	label(dataset.id, `dataset of ${agentName}`);
	return { agent, dataset: dataset.id };
}

describe('AgentEvalRunRepository', () => {
	test('creates runs and moves them through their states', async () => {
		const { agent, dataset } = await seedDataset('agent R');
		const steps: Record<string, unknown> = {};
		const ids: Record<string, string> = {};
		const create = async (
			name: string,
			input: Parameters<AgentEvalRunRepository['createRun']>[0],
		) => {
			// A pause between runs keeps their `createdAt` apart, so the order is stable.
			await tick();
			const run = await runs.createRun(input);
			ids[name] = label(run.id, name);
			return run;
		};

		steps['create minimal'] = await record(
			async () => await create('run 1', { datasetId: dataset }),
		);
		steps['create full'] = await record(
			async () =>
				await create('run 2', { datasetId: dataset, agentVersionId: 'v-1', createdById: owner.id }),
		);
		steps['create with null version'] = await record(
			async () => await create('run 3', { datasetId: dataset, agentVersionId: null }),
		);
		steps['create for an unknown dataset'] = await record(
			async () => await runs.createRun({ datasetId: 'missing' }),
		);
		await create('run 4', { datasetId: dataset });
		await create('run 5', { datasetId: dataset });

		steps['markAsRunning with instance'] = await record(
			async () => await runs.markAsRunning(ids['run 1'], 'main-1'),
		);
		steps['markAsRunning without instance'] = await record(
			async () => await runs.markAsRunning(ids['run 2']),
		);
		steps['markAsCompleted'] = await record(
			async () => await runs.markAsCompleted(ids['run 1'], { total: 2, success: 2 }),
		);
		steps['markAsError'] = await record(
			async () => await runs.markAsError(ids['run 2'], 'run_failed', { message: 'boom' }),
		);
		steps['markAsError with metrics'] = await record(
			async () =>
				await runs.markAsError(ids['run 3'], 'timeout', { message: 'late' }, { total: 3 }),
		);
		steps['requestCancellation'] = await record(
			async () => await runs.requestCancellation(ids['run 4']),
		);
		steps['requestCancellation unknown'] = await record(
			async () => await runs.requestCancellation('x'),
		);
		steps['isCancellationRequested yes'] = await record(
			async () => await runs.isCancellationRequested(ids['run 4']),
		);
		steps['isCancellationRequested no'] = await record(
			async () => await runs.isCancellationRequested(ids['run 5']),
		);
		steps['isCancellationRequested unknown'] = await record(
			async () => await runs.isCancellationRequested('x'),
		);
		steps['markAsCancelled with metrics'] = await record(
			async () => await runs.markAsCancelled(ids['run 4'], { total: 1 }),
		);
		steps['markAsRunning run 5'] = await record(
			async () => await runs.markAsRunning(ids['run 5'], 'main-2'),
		);
		steps['markAsCancelled without metrics'] = await record(
			async () => await runs.markAsCancelled(ids['run 5']),
		);
		steps['findByDatasetId'] = await record(async () => await runs.findByDatasetId(dataset));
		steps['findById'] = await record(async () => await runs.findById(ids['run 1']));
		steps['findById unknown'] = await record(async () => await runs.findById('x'));
		steps['findByIdAndAgentId own'] = await record(
			async () => await runs.findByIdAndAgentId(ids['run 1'], agent),
		);
		steps['findByIdAndAgentId foreign'] = await record(
			async () => await runs.findByIdAndAgentId(ids['run 1'], 'other-agent'),
		);
		steps['findAndCount default'] = await record(
			async () => await runs.findAndCountByDatasetIdAndAgentId(dataset, agent),
		);
		steps['findAndCount page'] = await record(
			async () =>
				await runs.findAndCountByDatasetIdAndAgentId(dataset, agent, { take: 2, skip: 1 }),
		);
		steps['findAndCount foreign'] = await record(
			async () => await runs.findAndCountByDatasetIdAndAgentId(dataset, 'other-agent'),
		);

		await create('run 6', { datasetId: dataset });
		await create('run 7', { datasetId: dataset });
		await runs.markAsRunning(ids['run 7'], 'main-3');
		steps['markAllIncompleteAsError'] = await record(
			async () => await runs.markAllIncompleteAsError(),
		);
		steps['markAllIncompleteAsError again'] = await record(
			async () => await runs.markAllIncompleteAsError(),
		);

		expect(steps).toMatchSnapshot();
	});
});

describe('AgentEvalResultRepository and AgentEvalRatingRepository', () => {
	test('seed results, record their outcomes, and rate them', async () => {
		const { dataset } = await seedDataset('agent C');
		const run = await runs.createRun({ datasetId: dataset });
		label(run.id, 'run');
		const otherRun = await runs.createRun({ datasetId: dataset });
		label(otherRun.id, 'other run');
		const steps: Record<string, unknown> = {};
		const ids: string[] = [];

		steps['seed'] = await record(async () => {
			const seeded = await results.seedResults([
				{ runId: run.id, sourceRowId: 'row-a', runIndex: 5, input: { q: '1' } },
				{ runId: run.id, sourceRowId: 'row-b', runIndex: 0, input: { q: '2' } },
				{ runId: run.id },
				{ runId: run.id, runIndex: 7 },
			]);
			seeded.forEach((result, index) => ids.push(label(result.id, `result ${index}`)));
			return seeded;
		});
		steps['seed none'] = await record(async () => await results.seedResults([]));
		steps['seed for an unknown run'] = await record(
			async () => await results.seedResults([{ runId: 'missing' }]),
		);
		const [otherResult] = await results.seedResults([{ runId: otherRun.id }]);
		label(otherResult.id, 'result of the other run');

		steps['countByStatus new'] = await record(async () => await results.countByStatus(run.id));
		steps['countByStatus unknown run'] = await record(async () => await results.countByStatus('x'));
		steps['markAsRunning'] = await record(async () => await results.markAsRunning(ids[0]));
		steps['markAsCompleted minimal'] = await record(
			async () => await results.markAsCompleted(ids[0], { output: { answer: '42' } }),
		);
		steps['markAsCompleted full'] = await record(
			async () =>
				await results.markAsCompleted(ids[1], {
					output: { answer: '43' },
					toolCalls: { calls: [] },
					metrics: { usage: { inputTokens: 1 } },
				}),
		);
		steps['markAsError'] = await record(
			async () => await results.markAsError(ids[2], 'execution_failed', { message: 'boom' }),
		);
		steps['markAsCancelled'] = await record(async () => await results.markAsCancelled(ids[3]));
		steps['countByStatus mixed'] = await record(async () => await results.countByStatus(run.id));
		steps['findAndCountByRunId default'] = await record(
			async () => await results.findAndCountByRunId(run.id),
		);
		steps['findAndCountByRunId page'] = await record(
			async () => await results.findAndCountByRunId(run.id, { take: 2, skip: 1 }),
		);
		steps['findById'] = await record(async () => await results.findById(ids[1]));
		steps['findById unknown'] = await record(async () => await results.findById('x'));

		steps['createRating minimal'] = await record(async () => {
			const rating = await ratings.createRating({ resultId: ids[0], vote: 'up' });
			label(rating.id, 'rating 1');
			return rating;
		});
		steps['createRating full'] = await record(async () => {
			const rating = await ratings.createRating({
				resultId: ids[0],
				vote: 'down',
				comment: 'wrong tone',
				correction: { finalText: 'better' },
				ratedById: owner.id,
			});
			label(rating.id, 'rating 2');
			return rating;
		});
		steps['createRating with an unknown vote'] = await record(
			async () =>
				// @ts-expect-error The check constraint allows up and down only.
				await ratings.createRating({ resultId: ids[1], vote: 'sideways' }),
		);
		steps['createRating for an unknown result'] = await record(
			async () => await ratings.createRating({ resultId: 'missing', vote: 'up' }),
		);
		await tick();
		const third = await ratings.createRating({ resultId: ids[1], vote: 'up' });
		label(third.id, 'rating 3');
		const foreign = await ratings.createRating({ resultId: otherResult.id, vote: 'down' });
		label(foreign.id, 'rating of the other run');

		steps['findByResultId'] = await record(async () => await ratings.findByResultId(ids[0]));
		steps['findByResultId unrated'] = await record(
			async () => await ratings.findByResultId(ids[2]),
		);
		// The order of the latest ratings follows the random ids of the results, so the test sorts them.
		steps['findLatestByRunId'] = await record(async () =>
			(await ratings.findLatestByRunId(run.id)).sort((a, b) =>
				String(normalize(a.id)).localeCompare(String(normalize(b.id))),
			),
		);
		steps['findLatestByRunId unknown'] = await record(
			async () => await ratings.findLatestByRunId('x'),
		);
		steps['delete the run cascades'] = await record(async () => await runs.delete(run.id));

		expect(steps).toMatchSnapshot();
	});
});
