// Fork test (not in upstream n8n): the evaluation page of a workflow as a black box: the licence
// states, the setup steps, the list of runs and the detail of a run. The test runs the route views
// against a fake server, clicks their controls, and records what a user sees (text, test ids,
// controls, icons, the data of the charts), the requests, the navigation, the toasts, the
// telemetry and the opened windows. It records no markup and no styles. The snapshot was
// recorded against the enterprise files, and the fork files give the same snapshot. See
// `../../FORK.md`.
import englishBaseText from '@n8n/i18n/locales/en.json';
import { fireEvent } from '@testing-library/vue';
import type { INode } from 'n8n-workflow';
import { effectScope } from 'vue';

import { createComponentRenderer } from '@/__tests__/render';
import { VIEWS } from '@/app/constants';
import { ChartJSPlugin } from '@/app/plugins/chartjs';
import { useUIStore } from '@/app/stores/ui.store';

import {
	describeDom,
	finishPages,
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
	CompareCollectionView,
	EvaluationsListSwitcher,
	EvaluationsRootView,
	TestRunDetailView,
	useEvaluationsLicense,
	useEvaluationStore,
	useWorkflowEvaluationState,
} from './subject';

// The charts draw on a canvas, which jsdom has not. The stub shows the points of each data set:
// the values on the x and y axes, read with the parsing keys of chart.js when the points are
// objects. Colours, sizes and callbacks are styling, and the stub leaves them out.
vi.mock('vue-chartjs', async () => {
	const { defineComponent, h } = await import('vue');
	const read = (item: unknown, path: unknown) =>
		typeof path === 'string'
			? path
					.split('.')
					.reduce<unknown>(
						(value, key) =>
							value && typeof value === 'object'
								? (value as Record<string, unknown>)[key]
								: undefined,
						item,
					)
			: item;
	const stub = (type: string) =>
		defineComponent({
			name: `ChartStub_${type}`,
			props: {
				data: { type: Object, default: undefined },
				options: { type: Object, default: undefined },
			},
			setup(props) {
				return () => {
					const datasets = (props.data?.datasets ?? []) as Array<Record<string, unknown>>;
					const chart = {
						type,
						...(props.data?.labels ? { labels: props.data.labels } : {}),
						datasets: datasets.map((dataset) => {
							const parsing = dataset.parsing as
								| { xAxisKey?: string; yAxisKey?: string }
								| undefined;
							const points = ((dataset.data ?? []) as unknown[]).map((item) =>
								parsing ? [read(item, parsing.xAxisKey), read(item, parsing.yAxisKey)] : item,
							);
							return { ...(dataset.label ? { label: dataset.label } : {}), points };
						}),
					};
					return h('div', { 'data-chart': JSON.stringify(chart) });
				};
			},
		});
	return {
		Line: stub('line'),
		Bar: stub('bar'),
		Doughnut: stub('doughnut'),
		Scatter: stub('scatter'),
	};
});

// #region The workflow and the server

const evaluationRoutes = [
	{
		path: '/workflow/:workflowId/evaluation',
		name: VIEWS.EVALUATION,
		component: EvaluationsRootView,
		props: true,
		children: [
			{ path: '', name: VIEWS.EVALUATION_EDIT, component: EvaluationsListSwitcher, props: true },
			{
				path: 'test-runs/:runId',
				name: VIEWS.EVALUATION_RUNS_DETAIL,
				component: TestRunDetailView,
				props: true,
			},
			{
				path: 'collections/:collectionId/compare',
				name: VIEWS.EVALUATION_COLLECTION_COMPARE,
				component: CompareCollectionView,
				props: true,
			},
		],
	},
];

const node = (
	name: string,
	type: string,
	typeVersion: number,
	parameters: INode['parameters'],
	x: number,
): INode => ({ id: name, name, type, typeVersion, position: [x, 0], parameters });

const manual = node("When clicking 'Execute workflow'", 'n8n-nodes-base.manualTrigger', 1, {}, 0);
const agent = node('AI Agent', '@n8n/n8n-nodes-langchain.agent', 3, { options: {} }, 200);
const trigger = node(
	'When fetching a dataset row',
	'n8n-nodes-base.evaluationTrigger',
	4.7,
	{ source: 'dataTable', dataTableId: { __rl: true, mode: 'id', value: 'dt1' } },
	0,
);
const setOutputs = node(
	'Set outputs',
	'n8n-nodes-base.evaluation',
	4.8,
	{
		operation: 'setOutputs',
		source: 'dataTable',
		dataTableId: { __rl: true, mode: 'id', value: 'dt1' },
		outputs: { values: [{ outputName: 'answer', outputValue: '={{ $json.output }}' }] },
	},
	400,
);
const setMetrics = node(
	'Set metrics',
	'n8n-nodes-base.evaluation',
	4.8,
	{
		operation: 'setMetrics',
		metric: 'customMetrics',
		metrics: { assignments: [{ id: 'a1', name: 'accuracy', value: '={{ 1 }}', type: 'number' }] },
	},
	600,
);
const link = (to: string) => ({ main: [[{ node: to, type: 'main' as const, index: 0 }]] });
const ALL_NODES = [manual, agent, trigger, setOutputs, setMetrics];
const BUILT_IN_NODES = [
	manual,
	trigger,
	// The operation of the Evaluation node is "Set outputs" when the parameter is missing.
	node('Default operation', 'n8n-nodes-base.evaluation', 4.8, { source: 'dataTable' }, 400),
	node(
		'Correctness check',
		'n8n-nodes-base.evaluation',
		4.8,
		{ operation: 'setMetrics', metric: 'correctness' },
		600,
	),
	node(
		'Similarity check',
		'n8n-nodes-base.evaluation',
		4.8,
		{ operation: 'setMetrics', metric: 'stringSimilarity', options: { metricName: 'Similarity' } },
		800,
	),
	node(
		'Old metrics',
		'n8n-nodes-base.evaluation',
		4.6,
		{
			operation: 'setMetrics',
			metrics: { assignments: [{ id: 'b1', name: 'legacy', value: 1, type: 'number' }] },
		},
		1000,
	),
	{
		...node(
			'Disabled metrics',
			'n8n-nodes-base.evaluation',
			4.8,
			{
				operation: 'setMetrics',
				metric: 'customMetrics',
				metrics: { assignments: [{ id: 'b2', name: 'ignored', value: 1, type: 'number' }] },
			},
			1200,
		),
		disabled: true,
	},
	node(
		'Tools check',
		'n8n-nodes-base.evaluation',
		4.7,
		{ operation: 'setMetrics', metric: 'toolsUsed' },
		1400,
	),
	node(
		'Category check',
		'n8n-nodes-base.evaluation',
		4.7,
		{ operation: 'setMetrics', metric: 'categorization' },
		1600,
	),
	node(
		'Helpfulness check',
		'n8n-nodes-base.evaluation',
		4.7,
		{ operation: 'setMetrics', metric: 'helpfulness', options: { metricName: 'Helpful' } },
		1800,
	),
];
const DISABLED_NODES = [
	manual,
	{ ...trigger, disabled: true },
	{ ...setOutputs, disabled: true },
	{ ...setMetrics, disabled: true },
];
const ALL_CONNECTIONS = {
	[manual.name]: link('AI Agent'),
	[trigger.name]: link('AI Agent'),
	'AI Agent': link('Set outputs'),
	'Set outputs': link('Set metrics'),
};

type Run = Record<string, unknown> & { id: string };

const run = (
	id: string,
	status: string,
	metrics: Record<string, number | boolean> | null,
	extra: Record<string, unknown> = {},
): Run => ({
	id,
	workflowId: 'wf1',
	status,
	runAt: '2026-01-01T10:00:00.000Z',
	completedAt: status === 'running' || status === 'new' ? null : '2026-01-01T10:01:00.000Z',
	metrics,
	errorCode: null,
	errorDetails: null,
	createdAt: '2026-01-01T10:00:00.000Z',
	updatedAt: '2026-01-01T10:01:00.000Z',
	runningInstanceId: null,
	cancelRequested: false,
	workflowVersionId: null,
	evaluationConfigId: null,
	evaluationConfigSnapshot: null,
	collectionId: null,
	testCaseCount: 2,
	finalResult: status === 'completed' ? 'success' : null,
	...extra,
});

const METRICS_1 = {
	accuracy: 0.75,
	promptTokens: 120,
	completionTokens: 30,
	totalTokens: 150,
	executionTime: 1500,
};
const METRICS_2 = {
	accuracy: 0.5,
	promptTokens: 100,
	completionTokens: 20,
	totalTokens: 120,
	executionTime: 1200,
};
const completed1 = run('r1', 'completed', METRICS_1);
const completed2 = run('r2', 'completed', METRICS_2, {
	createdAt: '2026-01-02T10:00:00.000Z',
	runAt: '2026-01-02T10:00:00.000Z',
	completedAt: '2026-01-02T10:01:00.000Z',
});
const running = run('r3', 'running', null, {
	createdAt: '2026-01-03T10:00:00.000Z',
	runAt: '2026-01-03T10:00:00.000Z',
});

const testCase = (
	id: string,
	testRunId: string,
	runIndex: number,
	status: string,
	extra: Record<string, unknown> = {},
) => ({
	id,
	testRunId,
	executionId: String(100 + runIndex),
	status,
	runAt: '2026-01-01T10:00:00.000Z',
	completedAt: status === 'new' || status === 'running' ? null : '2026-01-01T10:00:30.000Z',
	errorCode: null,
	errorDetails: null,
	runIndex,
	metrics: {},
	inputs: { question: `Question ${runIndex}` },
	outputs: {},
	...extra,
});

const CASES: Record<string, unknown[]> = {
	r1: [
		testCase('c1', 'r1', 0, 'success', {
			metrics: {
				accuracy: 1,
				promptTokens: 60,
				completionTokens: 15,
				totalTokens: 75,
				executionTime: 700,
			},
			outputs: { answer: '4' },
		}),
		testCase('c2', 'r1', 1, 'error', {
			errorCode: 'FAILED_TO_EXECUTE_WORKFLOW',
		}),
	],
	r2: [
		testCase('c3', 'r2', 0, 'success', {
			metrics: {
				accuracy: 0.5,
				promptTokens: 50,
				completionTokens: 10,
				totalTokens: 60,
				executionTime: 600,
			},
		}),
		testCase('c4', 'r2', 1, 'warning', {
			metrics: {
				accuracy: 0.5,
				promptTokens: 50,
				completionTokens: 10,
				totalTokens: 60,
				executionTime: 600,
			},
			errorCode: 'NO_METRICS_COLLECTED',
		}),
	],
	r3: [
		testCase('c5', 'r3', 0, 'success', {
			metrics: {
				accuracy: 1,
				promptTokens: 60,
				completionTokens: 15,
				totalTokens: 75,
				executionTime: 700,
			},
		}),
		testCase('c6', 'r3', 1, 'running', { executionId: null }),
		testCase('c7', 'r3', 2, 'new', { executionId: null }),
	],
};

type ServerState = {
	limit?: number;
	count?: number;
	nodes?: INode[];
	connections?: Record<string, unknown>;
	runs?: Run[];
	/** The runs that the list gives after a new run starts. */
	runsAfterStart?: Run[];
	licenseFails?: boolean;
};

function server(state: ServerState = {}) {
	const {
		limit = -1,
		count = 1,
		nodes = ALL_NODES,
		connections = ALL_CONNECTIONS,
		runs = [],
		runsAfterStart,
		licenseFails = false,
	} = state;
	return () => {
		let current = runs;
		route('GET', /.*/, () => []);
		route('POST', /.*/, () => ({ success: true }));
		route('GET', /^(\/rest)?\/license$/, () => {
			if (licenseFails) throw new ServerError(500, 'The licence server failed');
			return {
				usage: {
					activeWorkflowTriggers: { limit: -1, value: 0, warningThreshold: 0.8 },
					workflowsHavingEvaluations: { value: count, limit },
				},
				license: { planId: '', planName: 'Community' },
			};
		});
		route('GET', /^\/workflows\/wf1\/test-runs$/, () => current);
		route('GET', /^\/workflows\/wf1\/test-runs\/([^/]+)$/, (_request, match) => {
			const found = current.find((item) => item.id === match[1]);
			if (!found) throw new ServerError(404, 'Test run not found');
			return { ...found, testCaseExecutions: CASES[match[1]] ?? [] };
		});
		route('GET', /^\/workflows\/wf1\/test-runs\/([^/]+)\/test-cases$/, (_request, match) => {
			return CASES[match[1]] ?? [];
		});
		// The backend answers a start and a cancel without the `data` wrapper.
		route('POST', /^\/workflows\/wf1\/test-runs\/new$/, () => {
			if (runsAfterStart) current = runsAfterStart;
			return raw({ success: true, testRunId: 'r9' });
		});
		route('POST', /^\/workflows\/wf1\/test-runs\/[^/]+\/cancel$/, () => raw({ success: true }));
		setWorkflow({ id: 'wf1', nodes, connections: connections as never });
		loadNodeTypes([
			'n8n-nodes-base.evaluationTrigger',
			'n8n-nodes-base.evaluation',
			'n8n-nodes-base.manualTrigger',
			'@n8n/n8n-nodes-langchain.agent',
			'@n8n/n8n-nodes-langchain.lmChatOpenAi',
		]);
	};
}

// #endregion

// #region Steps

const vueErrors: string[] = [];
let container: Element;

async function mount(scenario: Scenario, prepare: () => void) {
	vueErrors.length = 0;
	await setup({ routes: evaluationRoutes, evaluation: { quota: -1 }, ...scenario });
	prepare();
	const rendered = createComponentRenderer(RouteHost, {
		global: {
			plugins: [router, ChartJSPlugin],
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
	await settle();
}

/** The log of a step: the distinct requests (sorted), and the other effects in their order. */
function effects() {
	const entries = takeLog();
	const requests = [
		...new Set(
			entries
				.filter(
					(entry): entry is ['request', string] => Array.isArray(entry) && entry[0] === 'request',
				)
				.map((entry) => entry[1]),
		),
	].sort();
	const others = entries.filter((entry) => !(Array.isArray(entry) && entry[0] === 'request'));
	const result: Record<string, unknown> = {};
	if (requests.length) result.requests = requests;
	if (others.length) result.effects = others;
	if (vueErrors.length) result.errors = [...new Set(vueErrors)];
	vueErrors.length = 0;
	return result;
}

// A case that runs shows one of these verbs at random, for example "Baking…".
const PROGRESS_VERBS = Object.entries(englishBaseText).flatMap(([key, text]) =>
	key.startsWith('evaluation.runDetail.testCase.progress.') && typeof text === 'string'
		? [text]
		: [],
);
const VERB = new RegExp(
	`(${PROGRESS_VERBS.map((verb) => verb.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')).join('|')})…`,
	'g',
);
const withoutVerbs = (value: unknown): unknown =>
	JSON.parse(JSON.stringify(value).replace(VERB, '<verb>…'));

/** What a user sees in the page, with the data of the charts. */
function view(root: Element = container) {
	const charts = [...root.querySelectorAll('[data-chart]')].map((element) =>
		JSON.parse(element.getAttribute('data-chart') ?? '{}'),
	);
	const modals = Object.entries(useUIStore().modalsById)
		.filter(([, modal]) => modal.open)
		.map(([name]) => name);
	return withoutVerbs({
		...(plain(describeDom(root)) as object),
		...(charts.length ? { charts } : {}),
		...(modals.length ? { modals } : {}),
		route: router.currentRoute.value.fullPath,
	});
}

/** Finds a control by its test id or its text. */
function find(target: string): Element | undefined {
	const byTestId = container.querySelector(`[data-test-id="${target}"]`);
	if (byTestId) return byTestId;
	const candidates = [...container.querySelectorAll('button, a, [role="button"], [role="option"]')];
	const exact = candidates.find((element) => normalize(element.textContent) === target);
	if (exact) return exact;
	// The deepest element with this text, for example a cell of a table.
	return [...container.querySelectorAll('*')]
		.filter((element) => normalize(element.textContent) === target)
		.pop();
}

async function click(target: string) {
	const element = find(target);
	if (!element) return { click: target, missing: true };
	await fireEvent.click(element);
	await settle();
	return { click: target, ...effects(), view: view() };
}

/** Steps on one page: the page after the mount, then each click. */
async function steps(scenario: Scenario, prepare: () => void, clicks: string[] = []) {
	await mount(scenario, prepare);
	const result: unknown[] = [{ mounted: true, ...effects(), view: view() }];
	for (const target of clicks) result.push(await click(target));
	return result;
}

// #endregion

beforeEach(() => {
	installRecorders();
	// The page asks for the state of a running run again after some time, and shows dates. Fake
	// timers and a fixed date make each run of the test see the same requests and texts.
	vi.useFakeTimers({
		now: new Date('2026-03-01T12:00:00.000Z'),
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(finishPages);

describe('the evaluation page', () => {
	test('the licence states', async () => {
		expect({
			'the licence fails to load': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({ licenseFails: true }),
			),
			// Fork: the paywall has no button, because the fork has no registration (FORK.md).
			'a limit of 0 workflows': await steps(
				{ path: '/workflow/wf1/evaluation', evaluation: { quota: 0 } },
				server({ limit: 0, count: 0 }),
			),
			'a limit of 1 workflow, used by another workflow': await steps(
				{ path: '/workflow/wf1/evaluation', evaluation: { quota: 1 } },
				server({ limit: 1, count: 1 }),
				['See plans', 'Skip'],
			),
			'a limit of 1 workflow, used by this workflow': await steps(
				{ path: '/workflow/wf1/evaluation', evaluation: { quota: 1 } },
				server({ limit: 1, count: 1, runs: [completed1] }),
			),
		}).toMatchSnapshot();
	});

	test('the setup steps', async () => {
		expect({
			'no evaluation nodes': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({
					count: 0,
					nodes: [manual, agent],
					connections: { [manual.name]: link('AI Agent') },
				}),
				['Add evaluation trigger'],
			),
			'a trigger only': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({
					count: 0,
					nodes: [manual, agent, trigger],
					connections: { [manual.name]: link('AI Agent'), [trigger.name]: link('AI Agent') },
				}),
				["Add 'set outputs' node"],
			),
			'a trigger and outputs': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({
					count: 0,
					nodes: [manual, agent, trigger, setOutputs],
					connections: {
						[manual.name]: link('AI Agent'),
						[trigger.name]: link('AI Agent'),
						'AI Agent': link('Set outputs'),
					},
				}),
				["Add 'Set metrics' node"],
			),
			'all nodes, then a first run': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({ count: 0, runsAfterStart: [run('r9', 'running', null)] }),
				['Run evaluation'],
			),
		}).toMatchSnapshot();
	});

	test('the list of runs', async () => {
		const errorCodes = [
			'CANT_FETCH_TEST_CASES',
			'COMPILATION_FAILED',
			'EVALUATION_CONFIG_NOT_FOUND',
			'EVALUATION_TRIGGER_DISABLED',
			'EVALUATION_TRIGGER_NOT_CONFIGURED',
			'EVALUATION_TRIGGER_NOT_FOUND',
			'INTERRUPTED',
			'PARTIAL_CASES_FAILED',
			'SET_METRICS_NODE_NOT_CONFIGURED',
			'SET_METRICS_NODE_NOT_FOUND',
			'SET_OUTPUTS_NODE_NOT_CONFIGURED',
			'TEST_CASES_NOT_FOUND',
			'UNKNOWN_ERROR',
		];
		const errorRuns = errorCodes.map((code, index) =>
			run(`e${index}`, 'error', null, {
				errorCode: code,
				createdAt: `2026-02-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
				runAt: `2026-02-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
			}),
		);
		expect({
			'two completed runs': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({
					runs: [completed2, completed1],
					runsAfterStart: [run('r9', 'running', null), completed2, completed1],
				}),
				['Run Test', '#1'],
			),
			'a running run': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({ runs: [running, completed1] }),
				['Stop Test'],
			),
			'runs with each error code': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({ runs: [...errorRuns].reverse() }),
			),
			'new and cancelled runs': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({
					runs: [
						run('r5', 'new', null, { createdAt: '2026-01-05T10:00:00.000Z' }),
						run('r4', 'cancelled', null, { createdAt: '2026-01-04T10:00:00.000Z' }),
						completed1,
					],
				}),
			),
			'a concurrency limit of 5': await steps(
				{ path: '/workflow/wf1/evaluation', settings: { evaluationConcurrencyLimit: 5 } },
				server({ runs: [completed1] }),
				['parallel-eval-toggle', 'Run Test'],
			),
			'a concurrency limit of 1': await steps(
				{ path: '/workflow/wf1/evaluation', settings: { evaluationConcurrencyLimit: 1 } },
				server({ runs: [completed1] }),
				['Run Test'],
			),
		}).toMatchSnapshot();
	});

	test('a running run asks for its state again', async () => {
		const timeline: Record<string, unknown> = {};
		await mount({ path: '/workflow/wf1/evaluation' }, server({ runs: [running, completed1] }));
		effects();
		for (const milliseconds of [500, 500, 1000, 3000]) {
			await vi.advanceTimersByTimeAsync(milliseconds);
			timeline[`list, after ${milliseconds} ms more`] = effects();
		}
		await mount(
			{ path: '/workflow/wf1/evaluation/test-runs/r3' },
			server({ runs: [running, completed1] }),
		);
		effects();
		for (const milliseconds of [500, 500, 1000, 3000]) {
			await vi.advanceTimersByTimeAsync(milliseconds);
			timeline[`detail, after ${milliseconds} ms more`] = effects();
		}
		expect(timeline).toMatchSnapshot();
	});

	test('the detail of a run', async () => {
		expect({
			'a completed run': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r1' },
				server({ runs: [completed1] }),
				['test-case-view-link', 'Re-run test', 'Back to runs'],
			),
			'a run after another run': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r2' },
				server({ runs: [completed2, completed1] }),
			),
			'a running run': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r3' },
				server({ runs: [running, completed1] }),
			),
			'a failed run': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/e1' },
				server({
					runs: [run('e1', 'error', null, { errorCode: 'TEST_CASES_NOT_FOUND' }), completed1],
				}),
			),
			'an unknown run': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/missing' },
				server({ runs: [completed1] }),
			),
		}).toMatchSnapshot();
	});

	test('the state that ordinary code reads', async () => {
		const states: Record<string, unknown> = {};
		for (const [name, scenario, state] of [
			['all nodes, quota -1', { evaluation: { quota: -1 } }, {}],
			[
				'no evaluation nodes, quota 0',
				{ evaluation: { quota: 0 } },
				{ nodes: [manual, agent], connections: { [manual.name]: link('AI Agent') } },
			],
			[
				'a trigger and outputs, quota 1',
				{ evaluation: { quota: 1 } },
				{ nodes: [manual, agent, trigger, setOutputs] },
			],
		] as Array<[string, Scenario, ServerState]>) {
			await setup({ routes: evaluationRoutes, ...scenario });
			server(state)();
			const scope = effectScope();
			const workflowState = scope.run(() => useWorkflowEvaluationState());
			await settle();
			states[name] = plain({
				workflowState,
				isEvaluationEnabled: useEvaluationStore().isEvaluationEnabled,
				requests: effects().requests,
			});
			scope.stop();
		}
		expect(states).toMatchSnapshot();
	});

	test('the state of other evaluation nodes', async () => {
		const states: Record<string, unknown> = {};
		for (const [name, nodes] of [
			['built-in metrics, and an output node with the default operation', BUILT_IN_NODES],
			['disabled evaluation nodes', DISABLED_NODES],
		] as Array<[string, INode[]]>) {
			await setup({ routes: evaluationRoutes, evaluation: { quota: -1 } });
			server({ nodes, connections: {} })();
			const scope = effectScope();
			const workflowState = scope.run(() => useWorkflowEvaluationState());
			await settle();
			states[name] = plain({ workflowState, requests: effects().requests });
			scope.stop();
		}
		expect(states).toMatchSnapshot();
	});

	test('more setup steps', async () => {
		const triggerAndOutputs = {
			nodes: [manual, agent, trigger, setOutputs],
			connections: {
				[manual.name]: link('AI Agent'),
				[trigger.name]: link('AI Agent'),
				'AI Agent': link('Set outputs'),
			},
		};
		expect({
			'a limit of 1 workflow, not used yet': await steps(
				{ path: '/workflow/wf1/evaluation', evaluation: { quota: 1 } },
				server({ limit: 1, count: 0, ...triggerAndOutputs }),
				['See plans'],
			),
			'run in the editor': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({ count: 0, ...triggerAndOutputs }),
				['Run in editor'],
			),
			'a limit of 0 workflows, with runs': await steps(
				{ path: '/workflow/wf1/evaluation', evaluation: { quota: 0 } },
				server({ limit: 0, count: 0, runs: [completed1] }),
			),
		}).toMatchSnapshot();
	});

	test('more lists of runs', async () => {
		const ordered = run(
			'r7',
			'completed',
			{
				executionTime: 900,
				zeta: 2,
				alpha: 0.25,
				totalTokens: 50,
				promptTokens: 40,
				completionTokens: 10,
			},
			{ createdAt: '2026-01-07T10:00:00.000Z', runAt: '2026-01-07T10:00:00.000Z' },
		);
		expect({
			'metrics in another order': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({ runs: [ordered, completed1] }),
			),
			'the start fails': await steps(
				{ path: '/workflow/wf1/evaluation' },
				() => {
					server({ runs: [completed1] })();
					route('POST', /^\/workflows\/wf1\/test-runs\/new$/, () => {
						throw new ServerError(500, 'The runner is busy');
					});
				},
				['Run Test'],
			),
			'the stop fails': await steps(
				{ path: '/workflow/wf1/evaluation' },
				() => {
					server({ runs: [running, completed1] })();
					route('POST', /^\/workflows\/wf1\/test-runs\/[^/]+\/cancel$/, () => {
						throw new ServerError(409, 'The run cannot be cancelled');
					});
				},
				['Stop Test'],
			),
			'an error run': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({
					runs: [run('e1', 'error', null, { errorCode: 'TEST_CASES_NOT_FOUND' }), completed1],
				}),
				['#2'],
			),
			'no concurrency limit': await steps(
				{ path: '/workflow/wf1/evaluation', settings: { evaluationConcurrencyLimit: -1 } },
				server({ runs: [completed1] }),
				['parallel-eval-toggle'],
			),
		}).toMatchSnapshot();
	});

	test('the pace of the polling', async () => {
		const pace: Record<string, unknown> = {};
		for (const path of ['/workflow/wf1/evaluation', '/workflow/wf1/evaluation/test-runs/r3']) {
			let state = running;
			await mount({ path }, () => {
				server({ runs: [running, completed1] })();
				route('GET', /^\/workflows\/wf1\/test-runs$/, () => [state, completed1]);
				route('GET', /^\/workflows\/wf1\/test-runs\/r3$/, () => ({
					...state,
					testCaseExecutions: CASES.r3,
				}));
			});
			effects();
			const counts: string[] = [];
			for (let step = 1; step <= 40; step++) {
				if (step === 25) {
					state = run(
						'r3',
						'completed',
						{ accuracy: 1 },
						{
							createdAt: '2026-01-03T10:00:00.000Z',
							runAt: '2026-01-03T10:00:00.000Z',
						},
					);
				}
				await vi.advanceTimersByTimeAsync(100);
				const requests = takeLog().filter(
					(entry) => Array.isArray(entry) && entry[0] === 'request',
				);
				if (requests.length) {
					counts.push(
						`${step * 100} ms: ${requests.map((entry) => (entry as string[])[1]).join(', ')}`,
					);
				}
			}
			pace[path] = { counts, view: view() };
		}
		expect(pace).toMatchSnapshot();
	});

	test('more details of runs', async () => {
		const cancelled = run('r6', 'cancelled', null, {
			createdAt: '2026-01-06T10:00:00.000Z',
			runAt: '2026-01-06T10:00:00.000Z',
		});
		const better = run(
			'r8',
			'completed',
			{
				accuracy: 1,
				Correctness: 4,
				Similarity: 0.5,
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				executionTime: 300,
			},
			{ createdAt: '2026-01-08T10:00:00.000Z', runAt: '2026-01-08T10:00:00.000Z' },
		);
		const same = run(
			'r10',
			'completed',
			{
				accuracy: 0.75,
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				executionTime: 300,
			},
			{ createdAt: '2026-01-10T10:00:00.000Z', runAt: '2026-01-10T10:00:00.000Z' },
		);
		CASES.r6 = [
			testCase('c8', 'r6', 0, 'cancelled', { executionId: null }),
			testCase('c9', 'r6', 1, 'success', {
				metrics: {
					accuracy: 1,
					promptTokens: 1500,
					completionTokens: 500,
					totalTokens: 2000,
					executionTime: 65000,
				},
			}),
		];
		CASES.r8 = [
			testCase('c10', 'r8', 0, 'success', {
				metrics: {
					accuracy: 1,
					Correctness: 4,
					Similarity: 0.5,
					totalTokens: 15,
					executionTime: 300,
				},
			}),
			testCase('c11', 'r8', 1, 'error', {
				executionId: null,
				errorCode: 'UNKNOWN_ERROR',
			}),
		];
		CASES.r10 = [testCase('c12', 'r10', 0, 'success', { metrics: { accuracy: 0.75 } })];
		const large = run(
			'r11',
			'completed',
			{ accuracy: 0.5, score: 42, ratio: 1.5, flag: true },
			{ createdAt: '2026-01-11T10:00:00.000Z', runAt: '2026-01-11T10:00:00.000Z' },
		);
		CASES.r11 = [
			testCase('c13', 'r11', 0, 'success', {
				metrics: { accuracy: 0.5, score: 42, ratio: 1.5, flag: true },
			}),
			testCase('c14', 'r11', 1, 'evaluation_running', { executionId: '120' }),
		];
		const fresh = run('r12', 'new', null, {
			createdAt: '2026-01-12T10:00:00.000Z',
			runAt: null,
		});
		CASES.r12 = [testCase('c15', 'r12', 0, 'new', { executionId: null })];
		expect({
			'a cancelled run': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r6' },
				server({ runs: [cancelled, completed1] }),
			),
			'a better run with built-in metrics': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r8' },
				server({ runs: [better, completed1], nodes: [...ALL_NODES, ...BUILT_IN_NODES.slice(3)] }),
			),
			'a run with the same score': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r10' },
				server({ runs: [same, completed1] }),
			),
			'cancel a pending case': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r3' },
				server({ runs: [running, completed1] }),
				['test-case-cancel-button'],
			),
			'metrics above 1': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r11' },
				server({ runs: [large, completed1] }),
			),
			'a new run': await steps(
				{ path: '/workflow/wf1/evaluation/test-runs/r12' },
				server({ runs: [fresh, completed1] }),
			),
			// The original list fails on a boolean metric, so this list has none.
			'the list with a new run and large metrics': await steps(
				{ path: '/workflow/wf1/evaluation' },
				server({
					runs: [
						fresh,
						run(
							'r13',
							'completed',
							{ accuracy: 0.5, score: 42, ratio: 1.5 },
							{
								createdAt: '2026-01-11T10:00:00.000Z',
								runAt: '2026-01-11T10:00:00.000Z',
							},
						),
						completed1,
					],
				}),
			),
		}).toMatchSnapshot();
	});

	// The licence state keeps its first load for the whole app, so one test checks it once.
	test('the licence state of the side panel', async () => {
		await setup({ routes: evaluationRoutes, evaluation: { quota: 1 } });
		server({ limit: 1, count: 0 })();
		const scope = effectScope();
		const license = scope.run(() => useEvaluationsLicense());
		const before = plain(license);
		await license?.ensureLicenseLoaded();
		await settle();
		const after = plain(license);
		await license?.ensureLicenseLoaded();
		await settle();
		expect({ before, after, requests: effects().requests, again: effects() }).toMatchSnapshot();
		scope.stop();
	});
});
