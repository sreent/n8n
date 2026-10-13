// Fork test (not in upstream n8n): the rerun of an evaluation collection. The golden test of the
// collections does not record a rerun: on SQLite the enterprise rerun waited for the write lock
// and failed. This test checks the fork rerun. See `packages/cli/src/evaluation/FORK.md`.
import { createTeamProject, createWorkflowWithHistory } from '@n8n/backend-test-utils';
import {
	CONFIG_EVALUATIONS_ENABLED_VARIANT,
	CONFIG_EVALUATIONS_FLAG,
	EVAL_COLLECTIONS_FLAG,
} from '@n8n/api-types';
import { LICENSE_QUOTAS } from '@n8n/constants';
import {
	GLOBAL_OWNER_ROLE,
	TestRunRepository,
	WorkflowHistoryRepository,
	type User,
} from '@n8n/db';
import { Container } from '@n8n/di';
import type { INode, IWorkflowBase } from 'n8n-workflow';

import '@/evaluation/evaluation-config.controller';
import '@/evaluation/evaluation-collections.controller';
import { EvaluationCollectionService } from '@/evaluation/evaluation-collection.service';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { PostHogClient } from '@/posthog';
import { createUserShell } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';
import { loadNodesFromDist } from '@test-integration/utils/node-types-data';

const testServer = utils.setupTestServer({
	endpointGroups: ['workflows', 'evaluation'],
	enabledFeatures: ['feat:sharing'],
	quotas: {
		[LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT]: -1,
		[LICENSE_QUOTAS.TEAM_PROJECT_LIMIT]: -1,
	},
	modules: ['data-table'],
});

const setNode = (name: string, x: number, field: string, value: string): INode => ({
	id: name,
	name,
	type: 'n8n-nodes-base.set',
	typeVersion: 3.4,
	position: [x, 0],
	parameters: {
		assignments: { assignments: [{ id: `${name}-1`, name: field, value, type: 'string' }] },
		includeOtherFields: true,
		options: {},
	},
});

const nodes: INode[] = [
	{
		id: 'trigger',
		name: 'When clicking',
		type: 'n8n-nodes-base.manualTrigger',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	},
	setNode('Prepare', 200, 'answer', '={{ $json.question.toUpperCase() }}'),
	setNode('Answer', 400, 'final', '={{ $json.answer }}'),
];

const connections = {
	'When clicking': { main: [[{ node: 'Prepare', type: 'main' as const, index: 0 }]] },
	Prepare: { main: [[{ node: 'Answer', type: 'main' as const, index: 0 }]] },
};

const FINISHED = ['completed', 'error', 'cancelled'];

let owner: User;
let agent: SuperAgentTest;
let workflow: IWorkflowBase;
let configId: string;

async function waitForRuns(runIds: string[]) {
	const testRuns = Container.get(TestRunRepository);
	for (let attempt = 0; attempt < 300; attempt++) {
		const runs = await Promise.all(runIds.map(async (id) => await testRuns.findOneBy({ id })));
		const finished = runs.every(
			(run) => run && FINISHED.includes(run.status) && run.runningInstanceId === null,
		);
		if (finished) return runs;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`The test runs ${runIds.join(', ')} did not finish`);
}

async function runsOfCollection(collectionId: string) {
	const runs = await Container.get(TestRunRepository).findBy({ collectionId });
	return runs.map((run) => run.id).sort();
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
	agent = testServer.authAgentFor(owner);
	const project = await createTeamProject('Evals', owner);
	const tables = Container.get(DataTableService);
	const table = await tables.createDataTable(project.id, {
		name: 'cases',
		columns: [
			{ name: 'question', type: 'string' },
			{ name: 'expected', type: 'string' },
		],
	});
	await tables.insertRows(table.id, project.id, [
		{ question: 'a', expected: 'A' },
		{ question: 'b', expected: 'B' },
	]);

	workflow = await createWorkflowWithHistory({ name: 'evaluated', nodes, connections }, project);
	// A second version in the history, with an answer that keeps the case of the question.
	const history = Container.get(WorkflowHistoryRepository);
	await history.insert(
		history.create({
			workflowId: workflow.id,
			versionId: 'version-2',
			nodes: nodes.map((node) =>
				node.name === 'Prepare' ? setNode('Prepare', 200, 'answer', '={{ $json.question }}') : node,
			),
			connections,
			authors: 'Test User',
		}),
	);

	const config = await agent.post(`/workflows/${workflow.id}/evaluation-configs`).send({
		name: 'Config',
		datasetSource: 'data_table',
		datasetRef: { dataTableId: table.id },
		startNodeName: 'Prepare',
		endNodeName: 'Answer',
		metrics: [
			{
				id: 'exact',
				name: 'Exact',
				type: 'expression',
				config: { expression: '={{ $json.final === $json.expected }}', outputType: 'boolean' },
			},
		],
	});
	expect(config.statusCode).toBe(200);
	configId = config.body.data.id;
});

describe('POST /workflows/:workflowId/eval-collections/:collectionId/rerun', () => {
	test('starts a new run for each version and moves the old runs out of the collection', async () => {
		const base = `/workflows/${workflow.id}/eval-collections`;
		const created = await agent.post(base).send({
			name: 'Compare',
			evaluationConfigId: configId,
			versions: [
				{ workflowVersionId: null, label: 'Draft' },
				{ workflowVersionId: 'version-2', label: 'Second' },
			],
		});
		expect(created.statusCode).toBe(200);
		const collectionId: string = created.body.data.id;
		const firstRunIds: string[] = created.body.data.runsStartedIds;
		expect(firstRunIds).toHaveLength(2);
		const firstRuns = await waitForRuns(firstRunIds);

		const rerun = await agent.post(`${base}/${collectionId}/rerun`);

		expect(rerun.statusCode).toBe(200);
		expect(rerun.body.data).toMatchObject({ id: collectionId, name: 'Compare', runCount: 2 });
		const newRunIds: string[] = rerun.body.data.runsStartedIds;
		expect(newRunIds).toHaveLength(2);
		expect(newRunIds.some((id) => firstRunIds.includes(id))).toBe(false);

		const newRuns = await waitForRuns(newRunIds);
		expect(newRuns.map((run) => run?.status)).toEqual(['completed', 'completed']);
		// The new runs test the same versions as the old runs.
		expect(newRuns.map((run) => run?.workflowVersionId).sort()).toEqual(
			firstRuns.map((run) => run?.workflowVersionId).sort(),
		);
		expect(await runsOfCollection(collectionId)).toEqual([...newRunIds].sort());
		// The old runs stay, outside the collection.
		const oldRuns = await Promise.all(
			firstRunIds.map(async (id) => await Container.get(TestRunRepository).findOneBy({ id })),
		);
		expect(oldRuns.map((run) => run?.collectionId)).toEqual([null, null]);

		const detail = await agent.get(`${base}/${collectionId}`);
		expect(detail.statusCode).toBe(200);
		expect(detail.body.data.runs.map((run: { testRunId: string }) => run.testRunId).sort()).toEqual(
			[...newRunIds].sort(),
		);
	});

	test('rejects a second rerun of the same collection while the first starts its runs', async () => {
		const created = await agent.post(`/workflows/${workflow.id}/eval-collections`).send({
			name: 'Busy',
			evaluationConfigId: configId,
			versions: [{ workflowVersionId: null, label: 'Draft' }],
		});
		const collectionId: string = created.body.data.id;
		await waitForRuns(created.body.data.runsStartedIds);
		const service = Container.get(EvaluationCollectionService);

		// The first call takes the lock before its first await.
		const first = service.rerunCollection(workflow.id, collectionId, owner);
		const second = service.rerunCollection(workflow.id, collectionId, owner);

		await expect(second).rejects.toThrow(
			expect.objectContaining({
				httpStatusCode: 409,
				message: 'The collection is already starting new runs',
			}),
		);
		const started = await first;
		expect(started.runsStartedIds).toHaveLength(1);
		await waitForRuns(started.runsStartedIds);
	});

	test('returns 404 for an unknown collection', async () => {
		const response = await agent.post(`/workflows/${workflow.id}/eval-collections/unknown/rerun`);

		expect(response.statusCode).toBe(404);
	});

	test('keeps no lock after a rerun fails', async () => {
		const service = Container.get(EvaluationCollectionService);
		await expect(service.rerunCollection(workflow.id, 'unknown', owner)).rejects.toThrow(
			'Collection not found',
		);
		await expect(service.rerunCollection(workflow.id, 'unknown', owner)).rejects.toThrow(
			'Collection not found',
		);
	});
});
