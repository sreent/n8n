// Fork test (not in upstream n8n): a golden test of the REST API of test runs
// (`/rest/workflows/:workflowId/test-runs`). It calls each route as the owner, an admin, a member,
// and the admin, the editor and the viewer of a project, on runs and cases that it writes with
// plain SQL, and records the status, the body and the changed rows. The snapshot was recorded
// against the enterprise files, and the fork files give the same snapshot. See
// `packages/cli/src/evaluation/FORK.md`.
import { createTeamProject, createWorkflow, linkUserToProject } from '@n8n/backend-test-utils';
import { LICENSE_QUOTAS } from '@n8n/constants';
import type { User } from '@n8n/db';
import { GLOBAL_ADMIN_ROLE, GLOBAL_MEMBER_ROLE, GLOBAL_OWNER_ROLE } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import { createUserShell } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

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
});

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
const labels = new Map<string, string>();
const label = (id: string, name: string) => {
	labels.set(String(id), name);
	return id;
};

function normalize(value: unknown): unknown {
	if (typeof value === 'string') {
		const known = labels.get(value);
		if (known) return `@${known}`;
		if (DATE_TEXT.test(value)) return '<date>';
		let text = value;
		for (const [id, name] of labels) text = text.replaceAll(id, `@${name}`);
		return text;
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, normalize(inner)]),
		);
	}
	return value;
}

async function query(sql: string, parameters: unknown[] = []) {
	return await Container.get(DataSource).query<Array<Record<string, unknown>>>(sql, parameters);
}

const agents: Record<string, SuperAgentTest> = {};
let personalWorkflow: string;
let teamWorkflow: string;

/** A run with three cases in other states, written with plain SQL. */
async function seedRun(
	workflowId: string,
	runId: string,
	status: string,
	extra: Record<string, unknown> = {},
) {
	await query(
		`INSERT INTO test_run (id, "workflowId", status, "runAt", "completedAt", metrics, "errorCode", "errorDetails", "cancelRequested", "createdAt", "updatedAt")
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		[
			runId,
			workflowId,
			status,
			status === 'new' ? null : '2026-01-01 10:00:00.000',
			['completed', 'error', 'cancelled'].includes(status) ? '2026-01-01 10:05:00.000' : null,
			(extra.metrics as string) ?? null,
			(extra.errorCode as string) ?? null,
			(extra.errorDetails as string) ?? null,
			(extra.createdAt as string) ?? '2026-01-01 09:00:00.000',
			'2026-01-01 09:00:00.000',
		],
	);
	label(runId, runId);
	const cases: Array<[string, Record<string, unknown>]> = [
		[
			'success',
			{ metrics: '{"accuracy":1}', inputs: '{"question":"a"}', outputs: '{"answer":"A"}' },
		],
		['error', { errorCode: 'FAILED_TO_EXECUTE_WORKFLOW', errorDetails: '{"message":"boom"}' }],
		['new', {}],
	];
	for (const [index, [caseStatus, values]] of cases.entries()) {
		const caseId = `${runId}-case-${index}`;
		await query(
			`INSERT INTO test_case_execution (id, "testRunId", status, "runIndex", metrics, inputs, outputs, "errorCode", "errorDetails", "runAt", "completedAt", "createdAt", "updatedAt")
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				caseId,
				runId,
				caseStatus,
				index,
				(values.metrics as string) ?? null,
				(values.inputs as string) ?? null,
				(values.outputs as string) ?? null,
				(values.errorCode as string) ?? null,
				(values.errorDetails as string) ?? null,
				caseStatus === 'new' ? null : '2026-01-01 10:01:00.000',
				caseStatus === 'new' ? null : '2026-01-01 10:02:00.000',
				`2026-01-01 09:0${index}:00.000`,
				'2026-01-01 09:00:00.000',
			],
		);
		label(caseId, caseId);
	}
}

async function runRows() {
	return {
		runs: await query(
			'SELECT id, status, "cancelRequested", "runningInstanceId", "errorCode", "completedAt" IS NOT NULL AS completed FROM test_run ORDER BY id',
		),
		cases: await query(
			'SELECT id, status, "errorCode", "completedAt" IS NOT NULL AS completed FROM test_case_execution ORDER BY id',
		),
	};
}

/** One call as each user: the status and the body, and the rows that changed. */
async function asEachUser(
	call: (agent: SuperAgentTest) => Promise<{ statusCode: number; body: unknown }>,
	reseed?: () => Promise<void>,
) {
	const record: Record<string, unknown> = {};
	for (const [name, agent] of Object.entries(agents)) {
		if (reseed) await reseed();
		const before = JSON.stringify(await runRows());
		const response = await call(agent);
		const after = await runRows();
		record[name] = normalize({
			status: response.statusCode,
			body: response.body,
			...(JSON.stringify(after) !== before ? { rowsAfter: after } : {}),
		});
	}
	return record;
}

async function reseedAll() {
	await query('DELETE FROM test_case_execution');
	await query('DELETE FROM test_run');
	await seedRun(personalWorkflow, 'run-done', 'completed', {
		metrics: '{"accuracy":0.5}',
		createdAt: '2026-01-01 08:00:00.000',
	});
	await seedRun(personalWorkflow, 'run-running', 'running', {
		createdAt: '2026-01-01 08:30:00.000',
	});
	await seedRun(personalWorkflow, 'run-failed', 'error', {
		errorCode: 'TEST_CASES_NOT_FOUND',
		errorDetails: '{"reason":"empty"}',
		createdAt: '2026-01-01 08:45:00.000',
	});
	await seedRun(teamWorkflow, 'team-run', 'running');
}

beforeAll(async () => {
	const owner = await createUserShell(GLOBAL_OWNER_ROLE);
	const admin = await createUserShell(GLOBAL_ADMIN_ROLE);
	const member = await createUserShell(GLOBAL_MEMBER_ROLE);
	const projectAdmin = await createUserShell(GLOBAL_MEMBER_ROLE);
	const projectEditor = await createUserShell(GLOBAL_MEMBER_ROLE);
	const projectViewer = await createUserShell(GLOBAL_MEMBER_ROLE);
	const users: Record<string, User> = {
		owner,
		admin,
		member,
		'project admin': projectAdmin,
		'project editor': projectEditor,
		'project viewer': projectViewer,
	};
	for (const [name, user] of Object.entries(users)) {
		label(user.id, name);
		agents[name] = testServer.authAgentFor(user);
	}
	const project = await createTeamProject('Evals', owner);
	label(project.id, 'project');
	await linkUserToProject(projectAdmin, project, 'project:admin');
	await linkUserToProject(projectEditor, project, 'project:editor');
	await linkUserToProject(projectViewer, project, 'project:viewer');
	personalWorkflow = label(
		(await createWorkflow({ name: 'personal' }, owner)).id,
		'personal workflow',
	);
	teamWorkflow = label((await createWorkflow({ name: 'team' }, project)).id, 'team workflow');
	await reseedAll();
});

describe('the REST API of test runs', () => {
	test('lists the runs of a workflow', async () => {
		expect({
			personal: await asEachUser((agent) => agent.get(`/workflows/${personalWorkflow}/test-runs`)),
			team: await asEachUser((agent) => agent.get(`/workflows/${teamWorkflow}/test-runs`)),
			'a page': await asEachUser((agent) =>
				agent.get(`/workflows/${personalWorkflow}/test-runs?take=1&skip=1`),
			),
			'an unknown workflow': await asEachUser((agent) => agent.get('/workflows/unknown/test-runs')),
		}).toMatchSnapshot();
	});

	test('reads one run and its cases', async () => {
		expect({
			run: await asEachUser((agent) =>
				agent.get(`/workflows/${personalWorkflow}/test-runs/run-done`),
			),
			'failed run': await asEachUser((agent) =>
				agent.get(`/workflows/${personalWorkflow}/test-runs/run-failed`),
			),
			'team run': await asEachUser((agent) =>
				agent.get(`/workflows/${teamWorkflow}/test-runs/team-run`),
			),
			'a run of another workflow': await asEachUser((agent) =>
				agent.get(`/workflows/${teamWorkflow}/test-runs/run-done`),
			),
			cases: await asEachUser((agent) =>
				agent.get(`/workflows/${personalWorkflow}/test-runs/run-done/test-cases`),
			),
			'team cases': await asEachUser((agent) =>
				agent.get(`/workflows/${teamWorkflow}/test-runs/team-run/test-cases`),
			),
			'cases of an unknown run': await asEachUser((agent) =>
				agent.get(`/workflows/${personalWorkflow}/test-runs/unknown/test-cases`),
			),
		}).toMatchSnapshot();
	});

	test('cancels and deletes runs', async () => {
		expect({
			'cancel a running run': await asEachUser(
				(agent) => agent.post(`/workflows/${personalWorkflow}/test-runs/run-running/cancel`),
				reseedAll,
			),
			'cancel a team run': await asEachUser(
				(agent) => agent.post(`/workflows/${teamWorkflow}/test-runs/team-run/cancel`),
				reseedAll,
			),
			'cancel a finished run': await asEachUser(
				(agent) => agent.post(`/workflows/${personalWorkflow}/test-runs/run-done/cancel`),
				reseedAll,
			),
			'cancel an unknown run': await asEachUser(
				(agent) => agent.post(`/workflows/${personalWorkflow}/test-runs/unknown/cancel`),
				reseedAll,
			),
			'cancel a new case of a running run': await asEachUser(
				(agent) =>
					agent.post(
						`/workflows/${personalWorkflow}/test-runs/run-running/test-cases/run-running-case-2/cancel`,
					),
				reseedAll,
			),
			'cancel a finished case of a running run': await asEachUser(
				(agent) =>
					agent.post(
						`/workflows/${personalWorkflow}/test-runs/run-running/test-cases/run-running-case-0/cancel`,
					),
				reseedAll,
			),
			'cancel a case of a finished run': await asEachUser(
				(agent) =>
					agent.post(
						`/workflows/${personalWorkflow}/test-runs/run-done/test-cases/run-done-case-2/cancel`,
					),
				reseedAll,
			),
			'cancel a team case': await asEachUser(
				(agent) =>
					agent.post(
						`/workflows/${teamWorkflow}/test-runs/team-run/test-cases/team-run-case-2/cancel`,
					),
				reseedAll,
			),
			'cancel an unknown case': await asEachUser(
				(agent) =>
					agent.post(
						`/workflows/${personalWorkflow}/test-runs/run-running/test-cases/unknown/cancel`,
					),
				reseedAll,
			),
			'delete a run': await asEachUser(
				(agent) => agent.delete(`/workflows/${personalWorkflow}/test-runs/run-done`),
				reseedAll,
			),
			'delete a team run': await asEachUser(
				(agent) => agent.delete(`/workflows/${teamWorkflow}/test-runs/team-run`),
				reseedAll,
			),
			'delete an unknown run': await asEachUser(
				(agent) => agent.delete(`/workflows/${personalWorkflow}/test-runs/unknown`),
				reseedAll,
			),
		}).toMatchSnapshot();
	});

	test('starts runs', async () => {
		// A started run of a workflow without an Evaluation Trigger ends with an error at once. The
		// test waits for it, records it, and removes it before the next user.
		const record: Record<string, unknown> = {};
		for (const [name, agent] of Object.entries(agents)) {
			const response = await agent.post(`/workflows/${teamWorkflow}/test-runs/new`).send({});
			const runId = (response.body as { testRunId?: string })?.testRunId;
			let run: Record<string, unknown> | undefined;
			if (runId) {
				label(runId, 'started run');
				for (let attempt = 0; attempt < 100; attempt++) {
					[run] = await query(
						'SELECT status, "errorCode", "errorDetails" FROM test_run WHERE id = ?',
						[runId],
					);
					if (run && ['completed', 'error', 'cancelled'].includes(String(run.status))) break;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
			record[name] = normalize({ status: response.statusCode, body: response.body, run });
			if (runId) {
				await query('DELETE FROM test_run WHERE id = ?', [runId]);
				labels.delete(runId);
			}
		}
		record['a body that is not valid'] = await asEachUser((agent) =>
			agent.post(`/workflows/${personalWorkflow}/test-runs/new`).send({ concurrency: 11 }),
		);
		expect(record).toMatchSnapshot();
	});

	test('without the licence quota', async () => {
		testServer.license.setQuota(LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT, 0);
		const record = {
			list: await asEachUser((agent) => agent.get(`/workflows/${personalWorkflow}/test-runs`)),
			'start with a body that is not valid': await asEachUser((agent) =>
				agent.post(`/workflows/${personalWorkflow}/test-runs/new`).send({ concurrency: 11 }),
			),
			cancel: await asEachUser(
				(agent) => agent.post(`/workflows/${personalWorkflow}/test-runs/run-running/cancel`),
				reseedAll,
			),
		};
		testServer.license.reset();
		expect(record).toMatchSnapshot();
	});
});
