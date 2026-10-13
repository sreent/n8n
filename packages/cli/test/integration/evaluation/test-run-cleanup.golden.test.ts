// Fork test (not in upstream n8n): a golden test of `TestRunCleanupService`, which runs when n8n
// starts. It writes test runs and test cases in each state with plain SQL, runs the cleanup, and
// records the changed rows. The snapshot was recorded against the enterprise file, and the fork
// file gives the same snapshot. See `packages/cli/src/evaluation/FORK.md`.
import { createWorkflow, testDb } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { InstanceSettings } from 'n8n-core';

import { TestRunCleanupService } from '@/evaluation/test-runner/test-run-cleanup.service';

const RUN_STATUSES = ['new', 'running', 'completed', 'error', 'cancelled'];
const CASE_STATUSES = ['new', 'running', 'success', 'error', 'cancelled'];

async function query(sql: string, parameters: unknown[] = []) {
	return await Container.get(DataSource).query<Array<Record<string, unknown>>>(sql, parameters);
}

/** The rows of both tables, by id, without the time stamps of the database. */
async function rows() {
	const strip = (row: Record<string, unknown>): Record<string, unknown> => {
		const { createdAt, updatedAt, ...rest } = row;
		return {
			...rest,
			completedAt: row.completedAt === null ? null : '<date>',
			runAt: row.runAt === null ? null : '<date>',
		};
	};
	return {
		runs: (await query('SELECT * FROM test_run ORDER BY id')).map(strip),
		cases: (await query('SELECT * FROM test_case_execution ORDER BY id')).map(strip),
	};
}

beforeAll(async () => {
	await testDb.init();
});

afterAll(async () => {
	await testDb.terminate();
});

test('the cleanup of interrupted test runs', async () => {
	const workflow = await createWorkflow({ name: 'evaluated' });
	const thisInstance = Container.get(InstanceSettings).hostId;
	for (const status of RUN_STATUSES) {
		for (const instance of ['this', 'other', 'none']) {
			const runId = `run-${status}-${instance}`;
			await query(
				`INSERT INTO test_run (id, "workflowId", status, "runAt", "runningInstanceId", "cancelRequested")
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[
					runId,
					workflow.id,
					status,
					status === 'new' ? null : '2026-01-01 00:00:00.000',
					instance === 'this' ? thisInstance : instance === 'other' ? 'other-main' : null,
					0,
				],
			);
			for (const caseStatus of CASE_STATUSES) {
				await query(
					'INSERT INTO test_case_execution (id, "testRunId", status, "runIndex") VALUES (?, ?, ?, ?)',
					[`${runId}-case-${caseStatus}`, runId, caseStatus, CASE_STATUSES.indexOf(caseStatus)],
				);
			}
		}
	}

	const before = await rows();
	let outcome: unknown;
	try {
		outcome = await Container.get(TestRunCleanupService).cleanupIncompleteRuns();
	} catch (error) {
		outcome = `${(error as Error).constructor.name}: ${(error as Error).message}`;
	}
	const after = await rows();

	const changed = (list: 'runs' | 'cases') =>
		after[list].flatMap((row) => {
			const old = before[list].find((candidate) => candidate.id === row.id);
			const columns = Object.fromEntries(
				Object.entries(row).filter(
					([key, value]) => JSON.stringify(old?.[key]) !== JSON.stringify(value),
				),
			);
			return Object.keys(columns).length ? [{ id: row.id, ...columns }] : [];
		});

	expect({
		outcome: outcome === undefined ? '<undefined>' : outcome,
		changedRuns: changed('runs'),
		changedCases: changed('cases'),
		removedRuns: before.runs.length - after.runs.length,
	}).toMatchSnapshot();
});
