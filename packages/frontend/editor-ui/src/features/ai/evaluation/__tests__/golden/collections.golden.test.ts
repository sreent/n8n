// Fork test (not in upstream n8n): the collections of evaluations as a black box: the list of
// collections and ungrouped runs, the dialog of a new collection, and the comparison of the
// versions of a collection. The test runs the route views against a fake server, clicks and types
// into their controls, lets the clock run, and records what a user sees (text, test ids, controls,
// icons), the requests, the navigation, the toasts and the telemetry. It records no markup and no
// styles. The snapshot was recorded against the enterprise files, and the fork files give the same
// snapshot. See `../../FORK.md`.
import { fireEvent } from '@testing-library/vue';
import type { INode } from 'n8n-workflow';

import { createComponentRenderer } from '@/__tests__/render';
import { VIEWS } from '@/app/constants';
import { ChartJSPlugin } from '@/app/plugins/chartjs';
import { usePostHog } from '@/app/stores/posthog.store';
import { useUIStore } from '@/app/stores/ui.store';

import {
	describeDom,
	finishPages,
	installRecorders,
	loadNodeTypes,
	normalize,
	pinia,
	plain,
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
	EvalCollectionsListView,
	EvaluationsListSwitcher,
	EvaluationsRootView,
	TestRunDetailView,
} from './subject';

// The runs list above the collections draws a chart. The evaluation page test records its data.
vi.mock('vue-chartjs', async () => {
	const { defineComponent, h } = await import('vue');
	const stub = defineComponent({ name: 'ChartStub', render: () => h('div') });
	return { Line: stub, Bar: stub, Doughnut: stub, Scatter: stub };
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

const node = (name: string, type: string, typeVersion: number, x: number): INode => ({
	id: name,
	name,
	type,
	typeVersion,
	position: [x, 0],
	parameters: {},
});
const manual = node("When clicking 'Execute workflow'", 'n8n-nodes-base.manualTrigger', 1, 0);
const agent = node('AI Agent', '@n8n/n8n-nodes-langchain.agent', 3, 200);
const CONNECTIONS = { [manual.name]: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] } };

const testRun = (
	id: string,
	status: string,
	metrics: Record<string, number> | null,
	extra: Record<string, unknown> = {},
) => ({
	id,
	workflowId: 'wf1',
	status,
	runAt: '2026-01-01T10:00:00.000Z',
	completedAt: status === 'running' || status === 'new' ? null : '2026-01-01T10:05:00.000Z',
	metrics,
	errorCode: null,
	errorDetails: null,
	createdAt: '2026-01-01T10:00:00.000Z',
	updatedAt: '2026-01-01T10:05:00.000Z',
	runningInstanceId: null,
	cancelRequested: false,
	workflowVersionId: null,
	evaluationConfigId: 'cfg-1',
	evaluationConfigSnapshot: null,
	collectionId: null,
	testCaseCount: 2,
	finalResult: status === 'completed' ? 'success' : null,
	...extra,
});

const testCase = (
	runId: string,
	runIndex: number,
	metrics: Record<string, number>,
	question: string,
	output: string,
) => ({
	id: `${runId}-${runIndex}`,
	testRunId: runId,
	executionId: `${runId}-exec-${runIndex}`,
	status: 'success',
	runAt: '2026-01-01T00:00:00Z',
	completedAt: '2026-01-01T00:00:10Z',
	errorCode: null,
	errorDetails: null,
	runIndex,
	metrics,
	inputs: { question },
	outputs: { output },
});

const V1 = 'a1b2c3d4-1d2e-4c3b-9a8f-111111111111';
const V2 = 'b2c3d4e5-1d2e-4c3b-9a8f-222222222222';
const V3 = 'c3d4e5f6-1d2e-4c3b-9a8f-333333333333';

const CASES: Record<string, unknown[]> = {
	'run-a': [
		testCase('run-a', 0, { helpfulness: 2.5, accuracy: 0.5 }, 'Capital of France?', 'Paris'),
		testCase('run-a', 1, { helpfulness: 4, accuracy: 1 }, 'What is 2+2?', '4'),
	],
	'run-b': [
		testCase(
			'run-b',
			0,
			{ helpfulness: 4.5, accuracy: 1 },
			'Capital of France?',
			'The capital of France is Paris.',
		),
		testCase('run-b', 1, { helpfulness: 4.4, accuracy: 1 }, 'What is 2+2?', '2 + 2 equals 4.'),
	],
	'run-c': [
		testCase('run-c', 0, { helpfulness: 3, accuracy: 1 }, 'Capital of France?', 'Paris, France'),
	],
};

const collectionRecord = (id: string, name: string, runCount: number) => ({
	id,
	name,
	description: null,
	workflowId: 'wf1',
	evaluationConfigId: 'cfg-1',
	createdById: 'u-1',
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z',
	runCount,
});

const runSummary = (
	testRunId: string,
	workflowVersionId: string | null,
	status: string,
	metrics: Record<string, number> | null,
	avgScore: number | null,
	completedAt: string | null = '2026-01-01T09:06:00Z',
) => ({
	testRunId,
	workflowVersionId,
	status,
	runAt: '2026-01-01T00:00:00Z',
	completedAt,
	avgScore,
	metrics,
	metricScales: { helpfulness: 'oneToFive', accuracy: 'unit' },
});

const DETAILS: Record<string, Record<string, unknown>> = {
	'col-done': {
		...collectionRecord('col-done', 'Tone tuning experiment', 2),
		metricScales: { helpfulness: 'oneToFive', accuracy: 'unit' },
		runs: [
			runSummary('run-a', V1, 'completed', { helpfulness: 3.25, accuracy: 0.75 }, 0.7),
			runSummary('run-b', V2, 'completed', { helpfulness: 4.45, accuracy: 1 }, 0.95),
		],
	},
	'col-running': {
		...collectionRecord('col-running', 'Prompt rewrite', 2),
		metricScales: { helpfulness: 'oneToFive', accuracy: 'unit' },
		runs: [
			runSummary(
				'run-c',
				V3,
				'completed',
				{ helpfulness: 3, accuracy: 1 },
				0.8,
				'2026-03-01T08:15:00Z',
			),
			runSummary('run-d', null, 'running', null, null, null),
		],
	},
	'col-mixed': {
		...collectionRecord('col-mixed', 'One broken version', 2),
		metricScales: { helpfulness: 'oneToFive', accuracy: 'unit' },
		runs: [
			runSummary('run-a', V1, 'completed', { helpfulness: 3.25, accuracy: 0.75 }, 0.7),
			runSummary('run-e', V2, 'error', null, null),
		],
	},
	'col-failed': {
		...collectionRecord('col-failed', 'Broken model', 1),
		metricScales: { helpfulness: 'oneToFive', accuracy: 'unit' },
		runs: [runSummary('run-e', V1, 'error', null, null)],
	},
};

const CONFIG = {
	id: 'cfg-1',
	workflowId: 'wf1',
	name: 'Support answers',
	status: 'valid',
	invalidReason: null,
	startNodeName: 'AI Agent',
	endNodeName: 'AI Agent',
	datasetSource: 'data_table',
	datasetRef: { dataTableId: 'dt1' },
	metrics: [
		{
			id: 'm1',
			name: 'helpfulness',
			type: 'llm_judge',
			config: {
				preset: 'helpfulness',
				provider: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
				credentialId: 'cred1',
				model: 'gpt-4o-mini',
				outputType: 'numeric',
				inputs: { actualAnswer: '={{ $json.output }}', userQuery: '={{ $json.question }}' },
			},
		},
		{
			id: 'm2',
			name: 'accuracy',
			type: 'expression',
			config: {
				expression: '={{ $json.output === $json.expected ? 1 : 0 }}',
				outputType: 'numeric',
			},
		},
	],
};

const INSIGHTS = {
	generatedAt: '2026-01-01T09:07:00Z',
	modelUsed: 'deterministic',
	status: 'fallback',
	insights: {
		winner: { versionLabel: 'B', headline: 'B wins', body: 'Higher helpfulness across cases.' },
		regressions: [
			{
				versionLabel: 'A',
				metric: 'helpfulness',
				delta: -24,
				headline: 'A trails on helpfulness',
				body: 'A scores 24 points lower.',
			},
		],
		suggestedNext: {
			headline: 'Try C',
			body: 'Raise the temperature.',
			hypothesis: 'More varied phrasing may help.',
		},
	},
};

const VERSIONS = {
	evaluationConfigId: 'cfg-1',
	versions: [
		{
			workflowVersionId: null,
			label: 'Current draft',
			sourceLabel: 'Draft',
			isCurrent: true,
			lastRun: null,
		},
		{
			workflowVersionId: V2,
			label: 'Published Jan 2',
			sourceLabel: 'Published',
			isCurrent: false,
			lastRun: {
				testRunId: 'run-b',
				runAt: '2026-01-02T09:30:00Z',
				status: 'completed',
				avgScore: 0.95,
				isBest: true,
				isCritical: false,
			},
		},
		{
			workflowVersionId: V1,
			label: 'Saved Jan 1',
			sourceLabel: 'Saved',
			isCurrent: false,
			lastRun: {
				testRunId: 'run-a',
				runAt: '2026-01-01T08:00:00Z',
				status: 'completed',
				avgScore: 0.3,
				isBest: false,
				isCritical: true,
			},
		},
	],
};

type ServerState = {
	collections?: string[];
	/** The collection `col-running` finishes from this request of its detail on. */
	finishAt?: number;
	runs?: unknown[];
	insights?: unknown;
	insightsFail?: boolean;
	detailFail?: number;
	casesOverride?: Record<string, unknown[]>;
};

function server(state: ServerState = {}) {
	return () => {
		const runs = state.runs ?? [
			testRun(
				'run-a',
				'completed',
				{ helpfulness: 3.25, accuracy: 0.75 },
				{ collectionId: 'col-done', workflowVersionId: V1 },
			),
			testRun(
				'run-b',
				'completed',
				{ helpfulness: 4.45, accuracy: 1 },
				{ collectionId: 'col-done', workflowVersionId: V2, runAt: '2026-01-01T10:01:00.000Z' },
			),
			testRun(
				'run-c',
				'completed',
				{ helpfulness: 3, accuracy: 1 },
				{ collectionId: 'col-running', workflowVersionId: V3, runAt: '2026-01-01T10:02:00.000Z' },
			),
			testRun(
				'run-f',
				'completed',
				{ helpfulness: 2, accuracy: 0.5 },
				{ createdAt: '2026-01-02T09:05:00.000Z', runAt: '2026-01-02T09:05:00.000Z' },
			),
			testRun('run-g', 'error', null, {
				errorCode: 'UNKNOWN_ERROR',
				createdAt: '2026-01-03T10:00:00.000Z',
				runAt: '2026-01-03T10:00:00.000Z',
				evaluationConfigId: null,
			}),
		];
		const cases = { ...CASES, ...state.casesOverride };
		route('GET', /.*/, () => []);
		route('POST', /.*/, () => ({ success: true }));
		route('GET', /^(\/rest)?\/license$/, () => ({
			usage: {
				activeWorkflowTriggers: { limit: -1, value: 0, warningThreshold: 0.8 },
				workflowsHavingEvaluations: { value: 1, limit: -1 },
			},
			license: { planId: '', planName: 'Community' },
		}));
		route('GET', /^\/workflows\/wf1\/test-runs$/, () => runs);
		route('GET', /^\/workflows\/wf1\/test-runs\/([^/]+)$/, (_request, match) => ({
			...(runs as Array<{ id: string }>).find((item) => item.id === match[1]),
			testCaseExecutions: cases[match[1]] ?? [],
		}));
		route(
			'GET',
			/^\/workflows\/wf1\/test-runs\/([^/]+)\/test-cases$/,
			(_request, match) => cases[match[1]] ?? [],
		);
		route('GET', /^\/workflows\/wf1\/evaluation-configs$/, () => [CONFIG]);
		const details: Record<string, Record<string, unknown>> = { ...DETAILS };
		const listed = [...(state.collections ?? ['col-done', 'col-running', 'col-failed'])];
		route('GET', /^\/workflows\/wf1\/eval-collections$/, () =>
			listed.map((id) => {
				const { runs: _runs, metricScales: _scales, ...record } = details[id];
				return record;
			}),
		);
		let runningRequests = 0;
		route('GET', /^\/workflows\/wf1\/eval-collections\/([^/]+)$/, (_request, match) => {
			if (state.detailFail) throw new ServerError(state.detailFail, 'The collection failed');
			if (match[1] === 'col-running' && state.finishAt && ++runningRequests >= state.finishAt) {
				return {
					...DETAILS['col-running'],
					runs: [
						runSummary('run-c', V3, 'completed', { helpfulness: 3, accuracy: 1 }, 0.8),
						runSummary('run-d', null, 'completed', { helpfulness: 5, accuracy: 1 }, 1),
					],
				};
			}
			const detail = details[match[1]];
			if (!detail) throw new ServerError(404, 'Not found');
			return detail;
		});
		route('POST', /^\/workflows\/wf1\/eval-collections\/([^/]+)\/insights$/, () => {
			if (state.insightsFail) throw new ServerError(500, 'The insights failed');
			return state.insights ?? INSIGHTS;
		});
		route('POST', /^\/workflows\/wf1\/eval-collections\/([^/]+)\/rerun$/, (_request, match) => ({
			...DETAILS[match[1]],
			runs: [
				runSummary('run-r1', V1, 'new', null, null, null),
				runSummary('run-r2', V2, 'new', null, null, null),
			],
		}));
		route('POST', /^\/workflows\/wf1\/eval-collections$/, () => {
			const created = {
				...collectionRecord('col-new', 'March prompts', 3),
				metricScales: { helpfulness: 'oneToFive', accuracy: 'unit' },
				runs: [
					runSummary('run-n', null, 'new', null, null, null),
					runSummary('run-b', V2, 'completed', { helpfulness: 4.45, accuracy: 1 }, 0.95),
					runSummary('run-a', V1, 'completed', { helpfulness: 3.25, accuracy: 0.75 }, 0.7),
				],
			};
			details['col-new'] = created;
			listed.unshift('col-new');
			return created;
		});
		route('GET', /^\/workflows\/wf1\/eval-versions$/, () => VERSIONS);
		route('GET', /^\/workflow-history\/workflow\/wf1\/version\/([^/]+)$/, (_request, match) => ({
			versionId: match[1],
			workflowId: 'wf1',
			name: null,
			description: null,
			authors: 'Test User',
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
			nodes: [manual, agent],
			connections: CONNECTIONS,
		}));
		route('GET', /^\/workflows\/wf1$/, () => ({
			id: 'wf1',
			name: 'Evaluated',
			active: false,
			nodes: [manual, agent],
			connections: CONNECTIONS,
			versionId: V2,
			settings: {},
			tags: [],
			scopes: ['workflow:read', 'workflow:update', 'workflow:execute'],
		}));
		setWorkflow({ id: 'wf1', nodes: [manual, agent], connections: CONNECTIONS as never });
		loadNodeTypes(['n8n-nodes-base.manualTrigger', '@n8n/n8n-nodes-langchain.agent']);
		usePostHog().overrides = { '084_eval_collections': { value: true } };
	};
}

// #endregion

// #region Steps

const vueErrors: string[] = [];
let container: Element;

async function mount(scenario: Scenario, prepare: () => void) {
	vueErrors.length = 0;
	await setup({
		routes: evaluationRoutes,
		evaluation: { quota: -1, collectionsEnabled: true },
		...scenario,
	});
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

function effects() {
	const entries = takeLog();
	// The requests in a stable order, with a count when a request repeats.
	const counts = new Map<string, number>();
	for (const entry of entries) {
		if (Array.isArray(entry) && entry[0] === 'request') {
			counts.set(String(entry[1]), (counts.get(String(entry[1])) ?? 0) + 1);
		}
	}
	const requests = [...counts.entries()]
		.map(([request, count]) => (count > 1 ? `${request} ×${count}` : request))
		.sort();
	const others = entries.filter((entry) => !(Array.isArray(entry) && entry[0] === 'request'));
	const result: Record<string, unknown> = {};
	if (requests.length) result.requests = requests;
	if (others.length) result.effects = others;
	if (vueErrors.length) result.errors = [...new Set(vueErrors)];
	vueErrors.length = 0;
	return result;
}

/**
 * What a user sees: an open dialog, else the collections list (the runs list above it has its own
 * test) or the comparison.
 */
function view() {
	const dialogs = [...document.body.querySelectorAll('[role="dialog"]')]
		.filter((element) => !container.contains(element))
		.map((element) => plain(describeDom(element)));
	const modals = Object.entries(useUIStore().modalsById)
		.filter(([, modal]) => modal.open)
		.map(([name]) => name);
	const page = container.querySelector('[data-test-id="eval-collections-list-view"]') ?? container;
	return {
		...(dialogs.length ? { dialogs } : (plain(describeDom(page)) as object)),
		...(modals.length ? { modals } : {}),
		route: router.currentRoute.value.fullPath,
	};
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
	const candidates = [
		...document.body.querySelectorAll(
			'button, a, [role="button"], [role="option"], [role="tab"], [role="radio"], li',
		),
	];
	const exact = candidates.find((element) => normalize(element.textContent) === target);
	if (exact) return exact;
	return [...document.body.querySelectorAll('*')]
		.filter((element) => normalize(element.textContent) === target)
		.pop();
}

/** A click, a text to type into a field, or a time to let pass. */
type Step = string | ['type', string, string] | ['wait', number];

const WIZARD = '[data-test-id="setup-collection-wizard"]';
const SOURCE_SELECT = `css:${WIZARD} input[role="combobox"]#1`;
const SORT_SELECT = `css:${WIZARD} input[role="combobox"]#2`;

async function act(step: Step) {
	if (typeof step === 'string') {
		const element = find(step);
		if (!element) return { click: step, missing: true };
		await fireEvent.click(element);
		await settle();
		return { click: step, ...effects(), view: view() };
	}
	if (step[0] === 'wait') {
		await vi.advanceTimersByTimeAsync(step[1]);
		await settle();
		return { wait: step[1], ...effects(), view: view() };
	}
	const [, target, text] = step;
	const element = find(target);
	const input = element?.matches('input, textarea')
		? element
		: element?.querySelector('input, textarea');
	if (!input) return { type: target, missing: true };
	await fireEvent.update(input, text);
	await settle();
	return { type: target, text, ...effects(), view: view() };
}

async function steps(scenario: Scenario, prepare: () => void, actions: Step[] = []) {
	await mount(scenario, prepare);
	const result: unknown[] = [{ mounted: true, ...effects(), view: view() }];
	for (const action of actions) result.push(await act(action));
	return result;
}

// #endregion

// The switcher loads the list view on demand. The reference keeps its module loaded, so that the
// import resolves at once, as it does in the app after the first visit.
const preloaded = [EvalCollectionsListView];

beforeEach(() => {
	expect(preloaded).toHaveLength(1);
	installRecorders();
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

const LIST = { path: '/workflow/wf1/evaluation' };
const compare = (collectionId: string) => ({
	path: `/workflow/wf1/evaluation/collections/${collectionId}/compare`,
});

describe('the collections of evaluations', () => {
	test('the page with the collections flag', async () => {
		const page = async (scenario: Scenario, prepare: () => void) => {
			await mount(scenario, prepare);
			return { ...effects(), page: plain(describeDom(container)) };
		};
		expect({
			'the flag in the settings': await page(LIST, () => {
				server()();
				usePostHog().overrides = {};
			}),
			'the flag in PostHog': await page({ ...LIST, evaluation: { quota: -1 } }, server()),
			'no flag': await page({ ...LIST, evaluation: { quota: -1 } }, () => {
				server()();
				usePostHog().overrides = {};
			}),
		}).toMatchSnapshot();
	});

	test('the list of collections', async () => {
		expect({
			'collections and ungrouped runs': await steps(LIST, server(), [
				'eval-collections-ungrouped-row#1',
				'eval-collections-card-cta#0',
			]),
			'a running collection': await steps(LIST, server(), [
				['wait', 3000],
				'eval-collections-card-cta#1',
			]),
			'a collection finishes': await steps(LIST, server({ finishAt: 2 }), [
				['wait', 3000],
				['wait', 3000],
			]),
			'a failed collection': await steps(LIST, server(), ['eval-collections-card-cta#2']),
			'no collections': await steps(LIST, server({ collections: [] })),
			'the list fails to load': await steps(LIST, () => {
				server()();
				route('GET', /^\/workflows\/wf1\/eval-collections$/, () => {
					throw new ServerError(500, 'The collections failed');
				});
			}),
		}).toMatchSnapshot();
	});

	test('a new collection', async () => {
		expect({
			'pick versions and create': await steps(LIST, server(), [
				'eval-collections-new-button',
				['type', 'setup-collection-wizard-name', 'March prompts'],
				'dataset-picker',
				'Support answers',
				'versions-table-row-checkbox#1',
				'versions-table-row-checkbox#2',
				'versions-table-row-checkbox#0',
				'versions-table-row-checkbox#2',
				'versions-table-row-checkbox#2',
				SORT_SELECT,
				'Oldest',
				SOURCE_SELECT,
				'Published',
				SOURCE_SELECT,
				'All',
				'setup-collection-wizard-submit',
			]),
			'no name': await steps(LIST, server(), [
				'eval-collections-new-button',
				'dataset-picker',
				'Support answers',
				'versions-table-row-checkbox#1',
				'versions-table-row-checkbox#2',
			]),
			'cancel the dialog': await steps(LIST, server(), [
				'eval-collections-new-button',
				'setup-collection-wizard-cancel',
			]),
			'the create fails': await steps(
				LIST,
				() => {
					server()();
					route('POST', /^\/workflows\/wf1\/eval-collections$/, () => {
						throw new ServerError(400, 'The name is taken');
					});
				},
				[
					'eval-collections-new-button',
					['type', 'setup-collection-wizard-name', 'March prompts'],
					'dataset-picker',
					'Support answers',
					'versions-table-row-checkbox#1',
					'versions-table-row-checkbox#2',
					'setup-collection-wizard-submit',
				],
			),
			'the versions fail to load': await steps(
				LIST,
				() => {
					server()();
					route('GET', /^\/workflows\/wf1\/eval-versions$/, () => {
						throw new ServerError(500, 'The versions failed');
					});
				},
				['eval-collections-new-button', 'dataset-picker', 'Support answers'],
			),
		}).toMatchSnapshot();
	});

	test('the comparison of a collection', async () => {
		expect({
			'a done collection': await steps(compare('col-done'), server(), [
				'compare-cases-row#0',
				'compare-outputs-case#1',
				'compare-outputs-inspect#1',
				'Metrics',
				'Per case',
				'compare-header-version#0',
				'compare-rerun',
				['wait', 3000],
			]),
			'sort the cases': await steps(compare('col-done'), server(), ['#', '#', 'Best', 'Δ vs best']),
			'back to the list': await steps(compare('col-done'), server(), ['compare-back']),
			'a running collection': await steps(compare('col-running'), server(), [
				['wait', 3000],
				'compare-header-version#1',
				'Outputs',
			]),
			'a collection finishes': await steps(compare('col-running'), server({ finishAt: 2 }), [
				['wait', 3000],
				['wait', 3000],
			]),
			'a failed collection': await steps(compare('col-failed'), server()),
			'insights fail': await steps(compare('col-done'), server({ insightsFail: true }), ['Retry']),
			'insights without regressions': await steps(
				compare('col-done'),
				server({ insights: { ...INSIGHTS, insights: { ...INSIGHTS.insights, regressions: [] } } }),
			),
			'a collection with a failed version': await steps(compare('col-mixed'), server()),
			'insights from a model': await steps(
				compare('col-done'),
				server({ insights: { ...INSIGHTS, status: 'ok', modelUsed: 'gpt-4o' } }),
			),
			'versions with other case counts': await steps(
				compare('col-done'),
				server({ casesOverride: { 'run-b': CASES['run-b'].slice(0, 1) } }),
			),
			'an unknown collection': await steps(compare('missing'), server()),
			'the collection fails to load': await steps(compare('col-done'), server({ detailFail: 500 })),
			'the rerun fails': await steps(
				compare('col-done'),
				() => {
					server()();
					route('POST', /^\/workflows\/wf1\/eval-collections\/([^/]+)\/rerun$/, () => {
						throw new ServerError(409, 'A rerun is running');
					});
				},
				['compare-rerun'],
			),
			'the workflow diff': await steps(compare('col-done'), server(), [
				'Workflow diff',
				'css:[data-test-id="workflow-diff-source-select"] input#0',
				'B · b2c3d4e',
			]),
		}).toMatchSnapshot();
	});
});
