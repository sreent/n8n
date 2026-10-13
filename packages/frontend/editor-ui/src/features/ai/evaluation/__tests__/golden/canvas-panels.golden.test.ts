// Fork test (not in upstream n8n): the evaluation panels of the canvas as a black box: the empty
// state of the evaluation page with the evaluation configs on, the info card on the canvas, the
// Tests panel of the focus sidebar, and the dataset modal. The test mounts them against a fake
// server, clicks and types into their controls, lets the clock run, and records what a user sees
// (text, test ids, controls, icons), the requests, the navigation, the toasts, the telemetry and
// the local storage. It records no markup and no styles. The snapshot was recorded against the
// enterprise files, and the fork files give the same snapshot. See `../../FORK.md`.
import { fireEvent } from '@testing-library/vue';
import { stringify } from 'flatted';
import type { INode } from 'n8n-workflow';
import { computed, defineComponent, effectScope, h } from 'vue';

import { createComponentRenderer } from '@/__tests__/render';
import { ADD_EXECUTION_TO_DATASET_MODAL_KEY, VIEWS } from '@/app/constants';
import { useFocusPanelStore } from '@/app/stores/focusPanel.store';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import { useUsageStore } from '@/features/settings/usage/usage.store';

import {
	describeDom,
	installRecorders,
	loadNodeTypes,
	normalize,
	pinia,
	plain,
	raw,
	route,
	RouteHost,
	router,
	ServerError,
	setUnmount,
	setWorkflow,
	settle,
	setup,
	takeLog,
	type Scenario,
} from './harness';
import {
	AddExecutionToDatasetModal,
	EvaluationsCanvasInfoCard,
	TestsPanel,
	useAddExecutionToDataset,
	useEvaluationsWizardSidepanelStore,
} from './panels-subject';
import { EvaluationsListSwitcher, EvaluationsRootView } from './subject';

// #region The workflow

const node = (
	name: string,
	type: string,
	typeVersion: number,
	x: number,
	parameters: INode['parameters'] = {},
): INode => ({ id: name, name, type, typeVersion, position: [x, 0], parameters });

const manual = node("When clicking 'Execute workflow'", 'n8n-nodes-base.manualTrigger', 1, 0);
const agent = node('AI Agent', '@n8n/n8n-nodes-langchain.agent', 3, 200, {
	promptType: 'define',
	text: '={{ $json.chatInput }}',
	options: {},
});
const secondAgent = node('Second Agent', '@n8n/n8n-nodes-langchain.agent', 3, 400, {
	promptType: 'define',
	text: '={{ $json.output }}',
	options: {},
});
const prepare = node('Prepare', 'n8n-nodes-base.set', 3.4, 100, {
	mode: 'manual',
	assignments: {
		assignments: [{ id: 'a1', name: 'prompt', value: '={{ $json.chatInput }}', type: 'string' }],
	},
	options: {},
});
const model: INode = {
	...node('OpenAI Chat Model', '@n8n/n8n-nodes-langchain.lmChatOpenAi', 1.2, 200, {
		model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' },
		options: {},
	}),
	credentials: { openAiApi: { id: 'cred1', name: 'OpenAI account' } },
};
const link = (to: string) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
const languageModel = (...to: string[]) => ({
	ai_languageModel: [to.map((name) => ({ node: name, type: 'ai_languageModel', index: 0 }))],
});

type Shape = 'empty' | 'manual' | 'agent' | 'two-agents' | 'prepared' | 'no-credential';

const WORKFLOWS: Record<Shape, { nodes: INode[]; connections: Record<string, unknown> }> = {
	empty: { nodes: [], connections: {} },
	manual: { nodes: [manual], connections: {} },
	agent: {
		nodes: [manual, agent, model],
		connections: { [manual.name]: link('AI Agent'), [model.name]: languageModel('AI Agent') },
	},
	'two-agents': {
		nodes: [manual, agent, model, secondAgent],
		connections: {
			[manual.name]: link('AI Agent'),
			'AI Agent': link('Second Agent'),
			[model.name]: languageModel('AI Agent', 'Second Agent'),
		},
	},
	prepared: {
		nodes: [
			manual,
			prepare,
			{ ...agent, parameters: { ...agent.parameters, text: '={{ $json.prompt }}' } },
			model,
		],
		connections: {
			[manual.name]: link('Prepare'),
			Prepare: link('AI Agent'),
			[model.name]: languageModel('AI Agent'),
		},
	},
	'no-credential': {
		nodes: [manual, agent, { ...model, credentials: undefined }],
		connections: { [manual.name]: link('AI Agent'), [model.name]: languageModel('AI Agent') },
	},
};

const project = {
	id: 'p1',
	type: 'personal',
	name: 'Test User <user@example.com>',
	icon: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

// #endregion

// #region The server

type ServerState = {
	shape?: Shape;
	/** The workflow is published. */
	active?: boolean;
	/** The successful executions: ID, question and answer. */
	executions?: Array<[string, string, string]>;
	/** The trigger gives a question and a context, not a chat input. */
	twoFields?: boolean;
	/** A saved data table with two cases, a saved config and a completed run. */
	saved?: boolean;
	/** The executions of the cases of a run exist. */
	caseExecutions?: boolean;
	/** The saved config has each kind of check. */
	allChecks?: boolean;
	/** The number of evaluation configs, or -1 for an error. */
	configs?: number;
	/** The limit of workflows with evaluations in the licence. */
	limit?: number;
	/** The start of a run fails. */
	startFails?: boolean;
	/** The dataset candidate of an execution fails to load. */
	candidateFails?: boolean;
	/** A new row of a dataset fails to save. */
	addRowFails?: boolean;
};

const DATE = '2026-03-01T12:00:00.000Z';

function server(state: ServerState = {}) {
	return () => {
		const shape = WORKFLOWS[state.shape ?? 'agent'];
		const executions = state.executions ?? [];
		const triggerJson = (question: string): Record<string, unknown> =>
			state.twoFields ? { question, context: 'docs' } : { chatInput: question };
		const middle = state.shape === 'prepared';
		const runData = (question: string, answer: string) => ({
			resultData: {
				runData: {
					[manual.name]: [
						{
							startTime: 1,
							executionTime: 1,
							executionIndex: 0,
							executionStatus: 'success',
							source: [],
							data: { main: [[{ json: triggerJson(question) }]] },
						},
					],
					...(middle
						? {
								Prepare: [
									{
										startTime: 2,
										executionTime: 1,
										executionIndex: 1,
										executionStatus: 'success',
										source: [{ previousNode: manual.name }],
										data: { main: [[{ json: { prompt: `Q: ${question}` } }]] },
									},
								],
							}
						: {}),
					[agent.name]: [
						{
							startTime: 3,
							executionTime: 5,
							executionIndex: 2,
							executionStatus: 'success',
							source: [{ previousNode: middle ? 'Prepare' : manual.name }],
							data: {
								main: [
									[
										{
											json: {
												output: answer,
												intermediateSteps: [{ action: { tool: 'calculator' } }],
											},
										},
									],
								],
							},
						},
					],
				},
				lastNodeExecuted: agent.name,
			},
		});
		const summary = (id: string) => ({
			id,
			finished: true,
			mode: 'manual',
			status: 'success',
			retryOf: null,
			retrySuccessId: null,
			waitTill: null,
			createdAt: '2026-02-28T10:00:00.000Z',
			startedAt: '2026-02-28T10:00:00.000Z',
			stoppedAt: '2026-02-28T10:00:05.000Z',
			workflowId: 'wf1',
			workflowName: 'Evaluated',
			annotation: { vote: null, tags: [] },
		});
		const fullExecution = (id: string, question: string, answer: string) => ({
			...summary(id),
			workflowData: {
				id: 'wf1',
				name: 'Evaluated',
				nodes: shape.nodes,
				connections: shape.connections,
				active: false,
				settings: {},
			},
			data: stringify(runData(question, answer)),
		});

		route('GET', /.*/, () => []);
		route('POST', /.*/, () => ({ success: true }));
		route('GET', /^(\/rest)?\/license$/, () => ({
			usage: {
				activeWorkflowTriggers: { limit: -1, value: 0, warningThreshold: 0.8 },
				workflowsHavingEvaluations: { value: 0, limit: state.limit ?? -1 },
			},
			license: { planId: '', planName: 'Community' },
		}));

		// The data tables of the project.
		type Table = {
			id: string;
			name: string;
			columns: Array<{ id: string; name: string; type: string; index: number }>;
			rows: Array<Record<string, unknown>>;
		};
		const tables: Table[] = [];
		const strip = (table: Table) => ({
			id: table.id,
			name: table.name,
			projectId: 'p1',
			columns: table.columns,
			createdAt: DATE,
			updatedAt: DATE,
			sizeBytes: 0,
		});
		const findTable = (id: string) => {
			const table = tables.find((item) => item.id === id);
			if (!table) throw new ServerError(404, 'Data table not found');
			return table;
		};
		route('GET', /^\/projects\/p1\/data-tables$/, (request) => {
			const filter = (request.params as { filter?: { name?: string } } | undefined)?.filter;
			const found = tables.filter((table) => !filter?.name || table.name === filter.name);
			return { count: found.length, data: found.map(strip) };
		});
		route('POST', /^\/projects\/p1\/data-tables$/, (request) => {
			const body = request.data as {
				name: string;
				columns?: Array<{ name: string; type: string }>;
			};
			const table: Table = {
				id: `dt${tables.length + 1}`,
				name: body.name,
				columns: (body.columns ?? []).map((column, index) => ({
					id: `c${index + 1}`,
					name: column.name,
					type: column.type,
					index,
				})),
				rows: [],
			};
			tables.push(table);
			return strip(table);
		});
		route('POST', /^\/projects\/p1\/data-tables\/([^/]+)\/columns$/, (request, match) => {
			const table = findTable(match[1]);
			const body = request.data as { name: string; type: string };
			const column = {
				id: `c${table.columns.length + 1}`,
				name: body.name,
				type: body.type,
				index: table.columns.length,
			};
			table.columns.push(column);
			return column;
		});
		route('POST', /^\/projects\/p1\/data-tables\/([^/]+)\/insert$/, (request, match) => {
			const table = findTable(match[1]);
			const body = request.data as { data: Array<Record<string, unknown>> };
			const inserted = body.data.map((row, index) => ({
				id: table.rows.length + index + 1,
				...row,
				createdAt: DATE,
				updatedAt: DATE,
			}));
			table.rows.push(...inserted);
			return inserted;
		});
		route('GET', /^\/projects\/p1\/data-tables\/([^/]+)\/rows$/, (request, match) => {
			const table = findTable(match[1]);
			const params = (request.params ?? {}) as { skip?: number; take?: number };
			const skip = Number(params.skip ?? 0);
			const rows = table.rows.slice(skip, skip + Number(params.take ?? 1000));
			return { count: table.rows.length, data: rows };
		});
		type Filter = { filters: Array<{ columnName: string; value: unknown }> };
		const matches = (row: Record<string, unknown>, filter: Filter) =>
			filter.filters.some((item) => row[item.columnName] === item.value);
		route('PATCH', /^\/projects\/p1\/data-tables\/([^/]+)\/rows$/, (request, match) => {
			const table = findTable(match[1]);
			const body = request.data as { data: Record<string, unknown>; filter: Filter };
			for (const row of table.rows) if (matches(row, body.filter)) Object.assign(row, body.data);
			return true;
		});
		route('DELETE', /^\/projects\/p1\/data-tables\/([^/]+)\/rows$/, (request, match) => {
			const table = findTable(match[1]);
			const params = request.params as { filter: Filter };
			table.rows = table.rows.filter((row) => !matches(row, params.filter));
			return true;
		});

		// The evaluation configs.
		const configs: Array<Record<string, unknown>> = Array.from(
			{ length: Math.max(state.configs ?? 0, 0) },
			(_, index) => ({
				id: `cfg-${index + 1}`,
				workflowId: 'wf1',
				name: 'Evaluation: Evaluated',
				status: 'valid',
				invalidReason: null,
				startNodeName: 'AI Agent',
				endNodeName: 'AI Agent',
				datasetSource: 'data_table',
				datasetRef: { dataTableId: 'dt-other' },
				metrics: [],
				createdAt: DATE,
				updatedAt: DATE,
			}),
		);
		if (state.saved) {
			tables.push({
				id: 'dt1',
				name: 'Evaluation: Evaluated',
				columns: [
					{ id: 'c1', name: 'chatInput', type: 'string', index: 0 },
					{ id: 'c2', name: 'expectedAnswer', type: 'string', index: 1 },
					{ id: 'c3', name: 'caseName', type: 'string', index: 2 },
				],
				rows: [
					{
						id: 1,
						chatInput: 'What is n8n?',
						expectedAnswer: 'n8n is a workflow tool.',
						caseName: '',
						createdAt: '2026-02-01T00:00:00.000Z',
						updatedAt: '2026-02-01T00:00:00.000Z',
					},
					{
						id: 2,
						chatInput: 'Capital of France?',
						expectedAnswer: 'Paris',
						caseName: 'Geography',
						createdAt: '2026-02-01T00:00:00.000Z',
						updatedAt: '2026-02-01T00:00:00.000Z',
					},
				],
			});
			configs.push({
				id: 'cfg-saved',
				workflowId: 'wf1',
				name: 'Evaluation: Evaluated',
				status: 'valid',
				invalidReason: null,
				startNodeName: 'AI Agent',
				endNodeName: 'AI Agent',
				datasetSource: 'data_table',
				datasetRef: { dataTableId: 'dt1' },
				metrics: [
					...(state.allChecks ? ALL_CHECKS : []),
					{
						id: 'm1',
						name: 'correctness',
						type: 'llm_judge',
						config: {
							preset: 'correctness',
							provider: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
							credentialId: 'cred1',
							model: 'gpt-4o-mini',
							outputType: 'numeric',
							inputs: {
								actualAnswer: "={{ JSON.stringify($('AI Agent').first().json) }}",
								expectedAnswer:
									"={{ $('When clicking \\'Execute workflow\\'').first().json['expectedAnswer'] }}",
							},
						},
					},
				],
				createdAt: '2026-02-01T00:00:00.000Z',
				updatedAt: '2026-02-01T00:00:00.000Z',
			});
		}
		route('GET', /^\/workflows\/wf1\/evaluation-configs$/, () => {
			if (state.configs === -1) throw new ServerError(500, 'The configs failed to load');
			return configs;
		});
		route('POST', /^\/workflows\/wf1\/evaluation-configs$/, (request) => {
			const config = {
				id: `cfg-${configs.length + 1}`,
				workflowId: 'wf1',
				status: 'valid',
				invalidReason: null,
				createdAt: DATE,
				updatedAt: DATE,
				...(request.data as object),
			};
			configs.push(config);
			return config;
		});
		route('PUT', /^\/workflows\/wf1\/evaluation-configs\/([^/]+)$/, (request, match) => {
			const index = configs.findIndex((config) => config.id === match[1]);
			if (index === -1) throw new ServerError(404, 'Config not found');
			configs[index] = { ...configs[index], ...(request.data as object) };
			return configs[index];
		});

		// The runs. A new run is running for a while, then completes with one case.
		const runs: Array<Record<string, unknown>> = state.saved
			? [
					{
						id: 'run-0',
						workflowId: 'wf1',
						status: 'completed',
						runAt: '2026-02-20T09:00:00.000Z',
						completedAt: '2026-02-20T09:00:05.000Z',
						metrics: { correctness: 3.5 },
						errorCode: null,
						errorDetails: null,
						createdAt: '2026-02-20T09:00:00.000Z',
						updatedAt: '2026-02-20T09:00:05.000Z',
						evaluationConfigId: 'cfg-saved',
						collectionId: null,
						workflowVersionId: null,
						testCaseCount: 2,
					},
				]
			: [];
		const caseMetrics = {
			correctness: 4,
			promptTokens: 120,
			completionTokens: 30,
			totalTokens: 150,
			executionTime: 900,
		};
		const runCase = (runId: string, index: number) => ({
			id: `${runId}-case-${index}`,
			testRunId: runId,
			executionId: `${runId}-exec-${index}`,
			status: 'success',
			runAt: '2026-03-01T12:00:01.000Z',
			completedAt: '2026-03-01T12:00:03.000Z',
			errorCode: null,
			errorDetails: null,
			runIndex: index,
			metrics: caseMetrics,
			inputs: { chatInput: 'What is n8n?' },
			outputs: { output: 'n8n is an automation tool.' },
		});
		// A new run completes 1200 ms after its start, whoever asks for it.
		const startedAt = new Map<string, number>();
		const advance = () => {
			for (const run of runs) {
				if (run.status !== 'running') continue;
				if (Date.now() - (startedAt.get(String(run.id)) ?? 0) >= 1200) {
					run.status = 'completed';
					run.completedAt = '2026-03-01T12:00:03.000Z';
					run.metrics = caseMetrics;
				}
			}
		};
		const casesOf = (runId: string) => {
			advance();
			if (runId === 'run-0') {
				return [
					{ ...runCase('run-0', 0), metrics: { correctness: 4 } },
					{
						...runCase('run-0', 1),
						status: 'error',
						errorCode: 'FAILED_TO_EXECUTE_WORKFLOW',
						metrics: {},
						inputs: { chatInput: 'Capital of France?' },
						outputs: {},
					},
				];
			}
			const run = runs.find((item) => item.id === runId);
			return run?.status === 'completed' ? [runCase(runId, 0)] : [];
		};
		route('POST', /^\/workflows\/wf1\/test-runs\/new$/, (request) => {
			if (state.startFails) throw new ServerError(500, 'The run failed to start');
			const body = (request.data ?? {}) as { evaluationConfigId?: string };
			const id = `run-${runs.length + 1}`;
			startedAt.set(id, Date.now());
			runs.unshift({
				id,
				workflowId: 'wf1',
				status: 'running',
				runAt: DATE,
				completedAt: null,
				metrics: null,
				errorCode: null,
				errorDetails: null,
				createdAt: DATE,
				updatedAt: DATE,
				evaluationConfigId: body.evaluationConfigId ?? null,
				collectionId: null,
				workflowVersionId: null,
				testCaseCount: 1,
			});
			return raw({ success: true, testRunId: id });
		});
		route('GET', /^\/workflows\/wf1\/test-runs$/, () => {
			advance();
			return runs;
		});
		route('GET', /^\/workflows\/wf1\/test-runs\/([^/]+)$/, (_request, match) => {
			advance();
			const run = runs.find((item) => item.id === match[1]);
			if (!run) throw new ServerError(404, 'Test run not found');
			return { ...run, testCaseExecutions: casesOf(match[1]) };
		});
		route('GET', /^\/workflows\/wf1\/test-runs\/([^/]+)\/test-cases$/, (_request, match) =>
			casesOf(match[1]),
		);

		// The dataset of a config: the columns of its table and the fields of an execution.
		route(
			'GET',
			/^\/workflows\/wf1\/evaluation-configs\/([^/]+)\/dataset-candidate$/,
			(_request, match) => {
				if (state.candidateFails) throw new ServerError(500, 'The execution has no data');
				const second = match[1] === 'cfg-2';
				return {
					dataTableId: second ? 'dt2' : 'dt1',
					columns: second
						? [{ name: 'question', type: 'string' }]
						: [
								{ name: 'chatInput', type: 'string' },
								{ name: 'expectedAnswer', type: 'string' },
								{ name: 'score', type: 'number' },
							],
					fields: {
						inputs: [{ key: 'chatInput', sample: 'What is n8n?' }],
						outputs: [
							{ key: 'output', sample: 'n8n is a workflow tool.' },
							{ key: 'intermediateSteps', sample: [{ action: { tool: 'calculator' } }] },
						],
					},
					suggestedMapping: second
						? { question: null }
						: {
								chatInput: { source: 'input', field: 'chatInput' },
								expectedAnswer: null,
								score: null,
							},
				};
			},
		);
		route('POST', /^\/workflows\/wf1\/evaluation-configs\/([^/]+)\/dataset-rows$/, (request) => {
			if (state.addRowFails) throw new ServerError(500, 'The row failed to save');
			return { dataTableId: 'dt1', row: { id: 7, ...(request.data as object) } };
		});

		// The executions.
		route('GET', /^\/executions$/, () => ({
			count: executions.length,
			results: executions.map(([id]) => summary(id)),
			estimated: false,
			nextCursor: null,
		}));
		route('GET', /^\/executions\/([^/]+)$/, (_request, match) => {
			const found = executions.find(([id]) => id === match[1]);
			if (found) return fullExecution(...found);
			if (state.caseExecutions && match[1].includes('-exec-')) {
				return { ...fullExecution(match[1], 'Case question', 'Case answer'), mode: 'evaluation' };
			}
			throw new ServerError(404, 'Execution not found');
		});

		setWorkflow({
			id: 'wf1',
			nodes: shape.nodes,
			connections: shape.connections as never,
			...({
				homeProject: project,
				shared: [{ role: 'workflow:owner', project }],
				...(state.active ? { active: true, activeVersionId: 'v-active' } : {}),
			} as object),
		});
		useProjectsStore().setCurrentProject({ ...project, relations: [], scopes: [] } as never);
		useCredentialsStore().setCredentialTypes([
			{ name: 'openAiApi', displayName: 'OpenAI', properties: [] },
		] as never);
		useCredentialsStore().setCredentials([
			{
				id: 'cred1',
				name: 'OpenAI account',
				type: 'openAiApi',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				isManaged: false,
				scopes: ['credential:read', 'credential:update'],
				homeProject: project,
				sharedWithProjects: [],
			},
		] as never);
		loadNodeTypes([
			'n8n-nodes-base.manualTrigger',
			'n8n-nodes-base.evaluation',
			'n8n-nodes-base.evaluationTrigger',
			'@n8n/n8n-nodes-langchain.agent',
			'@n8n/n8n-nodes-langchain.lmChatOpenAi',
		]);
	};
}

const TRIGGER_FIELD = (field: string) =>
	`={{ $('When clicking \\'Execute workflow\\'').first().json['${field}'] }}`;

/** A saved check of each other kind. */
const ALL_CHECKS = [
	{
		id: 'm2',
		name: 'helpfulness',
		type: 'llm_judge',
		config: {
			preset: 'helpfulness',
			provider: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
			credentialId: 'cred1',
			model: 'gpt-4o',
			outputType: 'numeric',
			inputs: {
				actualAnswer: "={{ JSON.stringify($('AI Agent').first().json) }}",
				userQuery: TRIGGER_FIELD('chatInput'),
			},
		},
	},
	{
		id: 'm3',
		name: 'stringSimilarity',
		type: 'string_similarity',
		config: {
			inputs: {
				actualAnswer: '={{ $json.output }}',
				expectedAnswer: TRIGGER_FIELD('expectedAnswer'),
			},
		},
	},
	{
		id: 'm4',
		name: 'categorization',
		type: 'categorization',
		config: {
			inputs: {
				actualAnswer: '={{ $json.output }}',
				expectedAnswer: TRIGGER_FIELD('expectedAnswer'),
			},
		},
	},
	{
		id: 'm5',
		name: 'toolsUsed',
		type: 'tools_used',
		config: {
			inputs: {
				expectedTools: TRIGGER_FIELD('expectedTools'),
				intermediateSteps: "={{ $('AI Agent').first().json.intermediateSteps }}",
			},
		},
	},
	{
		id: 'm6',
		name: 'Length',
		type: 'expression',
		config: { expression: '={{ $json.output.length > 3 }}', outputType: 'boolean' },
	},
];

const EXECUTIONS: Array<[string, string, string]> = [
	['100', 'What is n8n?', 'n8n is a workflow tool.'],
	['101', 'Capital of France?', 'Paris'],
];

// #endregion

// #region Steps

const vueErrors: string[] = [];
let container: Element;

/**
 * How the page opens: a route view, the info card on the canvas, the Tests panel, or the preview
 * of an execution with the dataset modal.
 */
type Page = 'evaluation' | 'card' | 'panel' | 'panel from the card' | 'execution';

// Modals.vue shows the dataset modal while the UI store has it open.
const ExecutionPreview = defineComponent({
	setup() {
		const ui = useUIStore();
		return () => {
			const modal = ui.modalsById[ADD_EXECUTION_TO_DATASET_MODAL_KEY];
			return h('div', [
				modal?.open
					? h(AddExecutionToDatasetModal, {
							modalName: ADD_EXECUTION_TO_DATASET_MODAL_KEY,
							data: modal.data ?? {},
						})
					: null,
			]);
		};
	},
});

const Canvas = defineComponent({
	setup: () => () => h('div', [h(EvaluationsCanvasInfoCard)]),
});
// The focus sidebar shows the Tests panel when its tab is "evaluations".
const Sidebar = defineComponent({
	setup() {
		const focusPanel = useFocusPanelStore();
		return () =>
			focusPanel.focusPanelActive && focusPanel.selectedTab === 'evaluations'
				? h('div', { 'data-test-id': 'sidebar' }, [h(TestsPanel)])
				: h('div', { 'data-test-id': 'sidebar-closed' });
	},
});

function routesOf(page: Page): Scenario['routes'] {
	if (page === 'evaluation') {
		return [
			{
				path: '/workflow/:workflowId/evaluation',
				name: VIEWS.EVALUATION,
				component: EvaluationsRootView,
				props: true,
				children: [
					{
						path: '',
						name: VIEWS.EVALUATION_EDIT,
						component: EvaluationsListSwitcher,
						props: true,
					},
				],
			},
		];
	}
	if (page === 'execution') {
		return [
			{
				path: '/workflow/:workflowId/executions',
				name: VIEWS.WORKFLOW_EXECUTIONS,
				component: ExecutionPreview,
				children: [
					{
						path: ':executionId/:nodeId?',
						name: VIEWS.EXECUTION_PREVIEW,
						component: defineComponent({ render: () => null }),
					},
				],
			},
		];
	}
	const component =
		page === 'card'
			? Canvas
			: defineComponent({ setup: () => () => h('div', [h(Canvas), h(Sidebar)]) });
	return [{ path: '/workflow/:workflowId/:nodeId?', name: VIEWS.WORKFLOW, component }];
}

type Options = {
	page?: Page;
	evaluation?: Scenario['evaluation'];
	storage?: Record<string, string>;
	/** A successful execution that the executions page hands over to the Tests panel. */
	seed?: string;
};

async function mount(options: Options, prepare: () => void) {
	vueErrors.length = 0;
	localStorage.clear();
	for (const [key, value] of Object.entries(options.storage ?? {})) {
		localStorage.setItem(key, value);
	}
	const page = options.page ?? 'panel';
	await setup({
		routes: routesOf(page),
		path:
			page === 'evaluation'
				? '/workflow/wf1/evaluation'
				: page === 'execution'
					? '/workflow/wf1/executions/100'
					: '/workflow/wf1',
		evaluation: { quota: -1, configEvalsEnabled: true, ...options.evaluation },
	});
	prepare();
	// The app loads the licence before it shows the panels.
	await useUsageStore().getLicenseInfo();
	if (options.seed) {
		const { useExecutionsStore } = await import('@/features/execution/executions/executions.store');
		const execution = await useExecutionsStore().fetchExecution(options.seed);
		if (execution) useEvaluationsWizardSidepanelStore().setPendingSeedExecution(execution);
	}
	if (page === 'panel') {
		// The user picks the tab of the focus sidebar.
		useFocusPanelStore().setSelectedTab('evaluations');
		useFocusPanelStore().openFocusPanel();
	}
	takeLog();
	const rendered = createComponentRenderer(RouteHost, {
		global: {
			plugins: [router],
			config: {
				errorHandler: (error: unknown) => {
					vueErrors.push(String(error));
				},
				warnHandler: () => {},
			},
		},
	})({ pinia });
	setUnmount(rendered.unmount);
	container = rendered.container;
	await settle(60);
}

// The IDs of metrics and custom checks are random.
const withoutRandomIds = (value: unknown): unknown =>
	JSON.parse(
		JSON.stringify(value)
			.replace(/(?<='id':')[A-Za-z0-9_-]{21}(?=')/g, '<id>')
			.replace(/(-custom-(?:remove-|expression-)?)[A-Za-z0-9_-]{21}/g, '$1<id>'),
	);

/**
 * The log of a step: the requests (sorted, each time it was sent), and the other effects in their
 * order. The order of the requests of one step depends on the timing of the code, not on what a
 * user sees.
 */
function effects() {
	const entries = takeLog();
	const isRequest = (entry: unknown): entry is ['request', string] =>
		Array.isArray(entry) && entry[0] === 'request';
	const requests = entries
		.filter(isRequest)
		.map((entry) => entry[1])
		.sort();
	const others = entries.filter((entry) => !isRequest(entry));
	const result: Record<string, unknown> = {};
	if (requests.length) result.requests = requests;
	if (others.length) result.effects = others;
	if (vueErrors.length) result.errors = [...new Set(vueErrors)];
	vueErrors.length = 0;
	return withoutRandomIds(result) as Record<string, unknown>;
}

function view() {
	const outside = (element: Element) => !container.contains(element);
	const dialogs = [...document.body.querySelectorAll('[role="dialog"]')]
		.filter(outside)
		.map((element) => plain(describeDom(element)));
	const menus = [...document.body.querySelectorAll('[role="menu"][data-state="open"]')]
		.filter(outside)
		.map((element) => plain(describeDom(element)));
	const listboxes = [...document.body.querySelectorAll('.el-popper [role="listbox"]')]
		.filter(outside)
		.filter((element) => element.closest<HTMLElement>('.el-popper')?.style.display !== 'none')
		.map((element) =>
			[...element.querySelectorAll('li')].map((option) => normalize(option.textContent)),
		);
	const modals = Object.entries(useUIStore().modalsById)
		.filter(([, modal]) => modal.open)
		.map(([name]) => name);
	const focusPanel = useFocusPanelStore();
	const storage = Object.fromEntries(
		Object.keys(localStorage)
			.filter((key) => key.startsWith('N8N_EVALUATION'))
			.sort()
			.map((key) => [key, localStorage.getItem(key)]),
	);
	return withoutRandomIds({
		...(plain(describeDom(container)) as object),
		...(dialogs.length ? { dialogs } : {}),
		...(menus.length ? { menus } : {}),
		...(listboxes.length ? { listboxes } : {}),
		...(modals.length ? { modals } : {}),
		...(Object.keys(storage).length ? { storage } : {}),
		focusPanel: focusPanel.focusPanelActive ? focusPanel.selectedTab : 'closed',
		route: router.currentRoute.value.fullPath,
	});
}

/**
 * Finds a control: by a CSS selector after `css:`, by its test id, or by its text. A `#n` at the
 * end picks the n-th match.
 */
function find(target: string): Element | undefined {
	if (target.startsWith('css:')) {
		const [selector, position] = target.slice(4).split('#');
		return [...document.body.querySelectorAll(selector)][Number(position ?? 0)];
	}
	const [testId, position] = target.split('#');
	const byTestId = [...document.body.querySelectorAll(`[data-test-id="${testId}"]`)];
	if (byTestId.length) return byTestId[Number(position ?? 0)];
	// The options of an open dropdown come first: each select keeps its options in the page.
	const isOpen = (element: Element) =>
		element.closest<HTMLElement>('.el-popper')?.style.display === '';
	const candidates = [
		...document.body.querySelectorAll(
			'button, a, [role="button"], [role="option"], [role="menuitem"], li',
		),
	].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)));
	const exact = candidates.find((element) => normalize(element.textContent) === target);
	if (exact) return exact;
	return [...document.body.querySelectorAll('*')]
		.filter((element) => normalize(element.textContent) === target)
		.pop();
}

/**
 * A click, a text to type into a field, a key to press in a field, a time to let pass, or an
 * execution that the executions page hands over to the Tests panel.
 */
type Step =
	| string
	| ['type', string, string]
	| ['key', string, string]
	| ['wait', number]
	| ['seed', string];

async function act(step: Step) {
	if (typeof step === 'string') {
		const element = find(step);
		if (!element) return { click: step, missing: true };
		await fireEvent.click(element);
		await settle(60);
		return { click: step, ...effects(), view: view() };
	}
	if (step[0] === 'wait') {
		await vi.advanceTimersByTimeAsync(step[1]);
		await settle(30);
		return { wait: step[1], ...effects(), view: view() };
	}
	if (step[0] === 'seed') {
		const { useExecutionsStore } = await import('@/features/execution/executions/executions.store');
		const execution = await useExecutionsStore().fetchExecution(step[1]);
		if (execution) useEvaluationsWizardSidepanelStore().setPendingSeedExecution(execution);
		await settle(60);
		return { seed: step[1], ...effects(), view: view() };
	}
	const [kind, target, text] = step;
	const element = find(target);
	const input = element?.matches('input, textarea')
		? element
		: element?.querySelector('input, textarea');
	if (!input) return { [kind]: target, missing: true };
	if (kind === 'key') {
		await fireEvent.keyDown(input, { key: text });
		await settle(60);
		return { key: target, text, ...effects(), view: view() };
	}
	await fireEvent.update(input, text);
	await settle(60);
	return { type: target, text, ...effects(), view: view() };
}

async function steps(options: Options, state: ServerState, actions: Step[] = []) {
	await mount(options, server(state));
	const result: unknown[] = [{ mounted: true, ...effects(), view: view() }];
	for (const action of actions) result.push(await act(action));
	return result;
}

// #endregion

beforeEach(() => {
	installRecorders();
	vi.useFakeTimers({
		now: new Date(DATE),
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('the evaluation panels of the canvas', () => {
	test('the evaluation page with evaluation configs', async () => {
		expect({
			'a workflow with an agent': await steps({ page: 'evaluation' }, { executions: EXECUTIONS }, [
				'evaluations-empty-state-get-started',
			]),
			'a workflow without an agent': await steps(
				{ page: 'evaluation' },
				{ shape: 'manual', executions: EXECUTIONS },
			),
			'the flag off': await steps(
				{ page: 'evaluation', evaluation: { configEvalsEnabled: false } },
				{ executions: EXECUTIONS },
			),
			'no evaluations in the licence': await steps(
				{ page: 'evaluation', evaluation: { quota: 0 } },
				{ executions: EXECUTIONS, limit: 0 },
			),
		}).toMatchSnapshot();
	});

	test('the info card', async () => {
		const DISMISSED = 'N8N_EVALUATIONS_CANVAS_INFO_CARD_DISMISSED';
		expect({
			'a draft workflow': await steps({ page: 'card' }, {}),
			'a published workflow': await steps({ page: 'card' }, { active: true }),
			'a published workflow with a config': await steps(
				{ page: 'card' },
				{ active: true, configs: 1 },
			),
			'the configs fail to load': await steps({ page: 'card' }, { active: true, configs: -1 }),
			'no agent': await steps({ page: 'card' }, { active: true, shape: 'manual' }),
			'the flag off': await steps(
				{ page: 'card', evaluation: { configEvalsEnabled: false } },
				{ active: true },
			),
			'no evaluations in the licence': await steps(
				{ page: 'card', evaluation: { quota: 0 } },
				{ active: true, limit: 0 },
			),
			'dismissed before': await steps(
				{ page: 'card', storage: { [DISMISSED]: 'wf0,wf1' } },
				{ active: true },
			),
			'dismissed for another workflow': await steps(
				{ page: 'card', storage: { [DISMISSED]: 'wf0' } },
				{ active: true },
				['evaluations-canvas-info-card-dismiss'],
			),
			'the setup': await steps(
				{ page: 'panel from the card' },
				{ active: true, executions: EXECUTIONS },
				['evaluations-canvas-info-card-setup'],
			),
		}).toMatchSnapshot();
	});
});

const SELECT_NODE = 'css:[data-test-id="tests-suite-config-ai-node-select"] input';
const CHAT_INPUT = 'css:[data-test-id="tests-detail-input-chatInput"] textarea';
const EXPECTED = 'tests-detail-expected-expectedAnswer';

describe('the Tests panel', () => {
	test('the first states', async () => {
		expect({
			'an empty workflow': await steps({}, { shape: 'empty' }, ['tests-panel-add-node-button']),
			'no executions': await steps({}, {}, ['tests-panel-gate-run']),
			executions: await steps({}, { executions: EXECUTIONS }),
			'two agents': await steps({}, { shape: 'two-agents', executions: EXECUTIONS }, [
				SELECT_NODE,
				'Second Agent',
			]),
		}).toMatchSnapshot();
	});

	test('a case from an execution', async () => {
		expect(
			await steps({}, { executions: EXECUTIONS }, [
				'tests-results-create-case',
				'tests-execution-toggle-100',
				'tests-execution-toggle-100',
				'tests-execution-create-100',
				'Configuration',
				'Configuration',
				'tests-detail-run',
				['wait', 1500],
				'Latest run',
				'tests-detail-breadcrumb-root',
				'tests-result-toggle-0',
				'tests-results-run-all',
				['wait', 1500],
			]),
		).toMatchSnapshot();
	});

	test('a manual case', async () => {
		expect(
			await steps({}, { executions: EXECUTIONS }, [
				'tests-results-create-case',
				'tests-list-create-manual',
				['type', CHAT_INPUT, 'Hello there'],
				['type', EXPECTED, 'General Kenobi'],
				'inline-edit-preview',
				['type', 'inline-edit-input', 'Greeting'],
				['key', 'inline-edit-input', 'Enter'],
				'tests-detail-run',
				['wait', 1500],
				'tests-detail-create-case',
				'tests-list-breadcrumb-root',
			]),
		).toMatchSnapshot();
	});

	test('the checks', async () => {
		expect(
			await steps({}, { executions: EXECUTIONS }, [
				'tests-suite-config-add-metric',
				'tests-suite-config-add-metric-item-stringSimilarity',
				'tests-suite-config-add-metric',
				'tests-suite-config-add-metric-item-toolsUsed',
				'tests-suite-config-add-metric',
				'tests-suite-config-add-metric-item-custom',
				[
					'type',
					'css:[data-test-id^="tests-suite-config-custom"] input',
					'$json.output.length > 3',
				],
				'tests-suite-config-metric-correctness',
				'tests-suite-config-add-metric',
				'tests-suite-config-add-metric-item-correctness',
				'tests-results-create-case',
				'tests-execution-create-100',
				'tests-detail-run',
				['wait', 1500],
				'tests-detail-breadcrumb-root',
				'css:[data-test-id^="tests-suite-config-custom-remove"]',
				['wait', 3000],
			]),
		).toMatchSnapshot();
	});

	test('saved cases', async () => {
		const state: ServerState = { saved: true, caseExecutions: true, executions: EXECUTIONS };
		expect({
			'edit and delete': await steps({}, state, [
				['wait', 1000],
				'tests-result-toggle-0',
				'tests-result-toggle-1',
				'tests-result-edit-1',
				['type', EXPECTED, 'Paris, France'],
				['wait', 3000],
				'tests-detail-menu',
				'tests-detail-menu-item-delete',
				'Delete',
				['wait', 500],
			]),
			'cancel a delete': await steps({}, state, [
				'tests-result-edit-0',
				'tests-detail-menu',
				'tests-detail-menu-item-delete',
				'Cancel',
				'tests-detail-run',
				['wait', 1500],
			]),
			'run all': await steps({}, state, ['tests-results-run-all', ['wait', 1500]]),
			'each kind of check': await steps({}, { ...state, allChecks: true }, [
				['wait', 1600],
				'tests-result-edit-0',
				'tests-detail-breadcrumb-root',
				'tests-suite-config-add-metric',
			]),
		}).toMatchSnapshot();
	});

	test('the input fields', async () => {
		expect({
			'two fields': await steps({}, { twoFields: true, executions: EXECUTIONS }, [
				'tests-results-create-case',
				'tests-execution-toggle-100',
				'tests-execution-create-100',
				'tests-detail-run',
			]),
			'a node before the agent': await steps({}, { shape: 'prepared', executions: EXECUTIONS }, [
				'tests-results-create-case',
				'tests-execution-create-100',
				'tests-detail-run',
				['wait', 1500],
			]),
		}).toMatchSnapshot();
	});

	test('more flows', async () => {
		expect({
			'a second agent': await steps({}, { shape: 'two-agents', executions: EXECUTIONS }, [
				SELECT_NODE,
				'Second Agent',
				'tests-results-create-case',
				'tests-execution-toggle-100',
				'tests-execution-create-100',
				'tests-detail-run',
				['wait', 1500],
			]),
			'an execution while the panel is open': await steps({}, { executions: EXECUTIONS }, [
				['seed', '101'],
				'tests-detail-breadcrumb-root',
			]),
			'the configs fail to load': await steps({}, { configs: -1, executions: EXECUTIONS }),
			'a new name for a saved case': await steps({}, { saved: true, caseExecutions: true }, [
				'tests-result-edit-1',
				'inline-edit-preview',
				['type', 'inline-edit-input', 'Capitals'],
				['key', 'inline-edit-input', 'Enter'],
				['wait', 1600],
				'tests-detail-breadcrumb-root',
			]),
			'a draft without a run': await steps({}, { executions: EXECUTIONS }, [
				'tests-results-create-case',
				'tests-execution-create-100',
				['type', EXPECTED, 'A tool'],
				['wait', 1600],
				'tests-detail-breadcrumb-root',
			]),
		}).toMatchSnapshot();
	});

	test('an execution from the executions page', async () => {
		expect(
			await steps({ seed: '101' }, { executions: EXECUTIONS }, ['tests-detail-run']),
		).toMatchSnapshot();
	});

	test('errors', async () => {
		expect({
			'no credential for the judge': await steps(
				{},
				{ shape: 'no-credential', executions: EXECUTIONS },
				['tests-results-create-case', 'tests-execution-create-100', 'tests-detail-run'],
			),
			'the run fails to start': await steps({}, { startFails: true, executions: EXECUTIONS }, [
				'tests-results-create-case',
				'tests-execution-create-100',
				'tests-detail-run',
			]),
		}).toMatchSnapshot();
	});
});

const DATASET_CONFIG = (id: string, name: string, source = 'data_table') => ({
	id,
	workflowId: 'wf1',
	name,
	status: 'valid',
	invalidReason: null,
	startNodeName: 'AI Agent',
	endNodeName: 'AI Agent',
	datasetSource: source,
	datasetRef: source === 'data_table' ? { dataTableId: id === 'cfg-2' ? 'dt2' : 'dt1' } : {},
	metrics: [],
	createdAt: DATE,
	updatedAt: DATE,
});

/** Steps of the dataset modal: the composable loads the configs and opens the modal. */
async function datasetSteps(
	options: Options & { configs?: Array<ReturnType<typeof DATASET_CONFIG>> },
	state: ServerState,
	actions: Step[] = [],
) {
	await mount({ ...options, page: 'execution' }, () => {
		server(state)();
		route('GET', /^\/workflows\/wf1\/evaluation-configs$/, () => options.configs ?? []);
	});
	const scope = effectScope();
	const dataset = scope.run(() => useAddExecutionToDataset(computed(() => 'wf1')));
	const members = () => ({
		isFeatureEnabled: dataset?.isFeatureEnabled.value,
		hasDataTableConfig: dataset?.hasDataTableConfig.value,
	});
	const result: unknown[] = [{ composable: Object.keys(dataset ?? {}).sort(), ...members() }];
	await dataset?.fetchDataTableConfigs();
	await settle();
	result.push({ fetched: true, ...members(), ...effects() });
	dataset?.openModal('100');
	await settle(60);
	result.push({ opened: true, ...effects(), view: view() });
	for (const action of actions) result.push(await act(action));
	scope.stop();
	return result;
}

const MODAL_SELECT = (index: number) =>
	`css:[data-test-id="add-execution-to-dataset-modal"] input[role="combobox"]#${index}`;

describe('the dataset modal', () => {
	test('the configs and the modal', async () => {
		const one = [DATASET_CONFIG('cfg-1', 'Evaluation: Evaluated')];
		const two = [
			...one,
			DATASET_CONFIG('cfg-2', 'Second'),
			DATASET_CONFIG('cfg-3', 'A sheet', 'google_sheets'),
		];
		expect({
			'one config': await datasetSteps({ configs: one }, {}, [
				MODAL_SELECT(1),
				'output (output)',
				MODAL_SELECT(2),
				'intermediateSteps (output)',
				'add-execution-to-dataset-submit',
			]),
			'all columns empty': await datasetSteps({ configs: one }, {}, [
				MODAL_SELECT(0),
				'Leave empty',
			]),
			cancel: await datasetSteps({ configs: one }, {}, ['add-execution-to-dataset-cancel']),
			'the row fails to save': await datasetSteps({ configs: one }, { addRowFails: true }, [
				'add-execution-to-dataset-submit',
			]),
			'two configs': await datasetSteps({ configs: two }, {}, [MODAL_SELECT(0), 'Second']),
			'no configs': await datasetSteps({ configs: [] }, {}, ['add-execution-to-dataset-submit']),
			'the flag off': await datasetSteps(
				{ configs: one, evaluation: { configEvalsEnabled: false } },
				{},
			),
			'the candidate fails': await datasetSteps({ configs: one }, { candidateFails: true }),
		}).toMatchSnapshot();
	});
});
