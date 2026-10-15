// Fork test (not in upstream n8n): the worker view as a black box: the orchestration store and the
// page Settings > Workers. The test gives the store worker statuses as the push messages do, lets
// time pass, and records the state of the store, the requests, and what a user sees (text, test
// ids, controls, icons), the toasts, the telemetry and the navigation. It records no markup and no
// styles. The snapshot was recorded against the enterprise files, and the fork files give the same
// snapshot. See `../../FORK.md`.
import type { WorkerStatus } from '@n8n/api-types';

import { fireEvent } from '@testing-library/vue';
import { nextTick } from 'vue';

import { createComponentRenderer } from '@/__tests__/render';
import {
	finishPages,
	installRecorders,
	isRecord,
	normalize,
	pinia,
	plain,
	raw,
	record,
	route,
	router,
	ServerError,
	settle,
	takeLog,
	type Scenario,
} from '@/features/ai/evaluation/__tests__/golden/harness';

import { GB, job, status } from './fixtures';
import { act, effects, mountComponent, prepare, screen, type Step } from './recording';
import * as subject from './subject';

// The charts draw on a canvas, which jsdom has not. The stub shows the type, the labels and the
// points of each data set, and the options without callbacks.
vi.mock('vue-chartjs', async () => {
	const { defineComponent, h } = await import('vue');
	const withoutFunctions = (value: unknown): unknown => {
		if (typeof value === 'function') return '<function>';
		if (Array.isArray(value)) return value.map(withoutFunctions);
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, withoutFunctions(entry)]),
			);
		}
		return value;
	};
	const stub = (type: string) =>
		defineComponent({
			name: `ChartStub_${type}`,
			props: {
				type: { type: String, default: undefined },
				data: { type: Object, default: undefined },
				options: { type: Object, default: undefined },
			},
			setup(props) {
				return () => {
					const datasets = (props.data?.datasets ?? []) as Array<Record<string, unknown>>;
					const chart = {
						type: props.type ?? type,
						...(props.data?.labels ? { labels: props.data.labels } : {}),
						datasets: datasets.map((dataset) => ({
							...(dataset.label ? { label: dataset.label } : {}),
							points: dataset.data ?? [],
						})),
						options: withoutFunctions(props.options ?? null),
					};
					return h('div', { 'data-chart': JSON.stringify(chart) });
				};
			},
		});
	return {
		Chart: stub('chart'),
		Line: stub('line'),
		Bar: stub('bar'),
		Doughnut: stub('doughnut'),
		Pie: stub('pie'),
		Scatter: stub('scatter'),
		Bubble: stub('bubble'),
		Radar: stub('radar'),
		PolarArea: stub('polarArea'),
	};
});

// #region Helpers

function server() {
	return () => {
		route('POST', /^(\/rest)?\/orchestration\/worker\/status$/, () => raw(''));
	};
}

const SCENARIO: Scenario = { path: '/settings/workers' };

/** A worker status as its sender, its uptime and its number of jobs. */
function brief(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(brief);
	if (!isRecord(value)) return value;
	if ('senderId' in value) {
		const jobs = value.runningJobsSummary;
		return `<status ${String(value.senderId)} uptime ${String(value.uptime)} jobs ${Array.isArray(jobs) ? jobs.length : '?'}>`;
	}
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, brief(entry)]));
}

/**
 * The state of the store as plain data. The statuses are brief, and the history of each worker is
 * its length and its first and last entries.
 */
function state() {
	const store = subject.useOrchestrationStore();
	const value = plain(store.$state) as Record<string, unknown>;
	const history = value.workersHistory as Record<string, unknown[]> | undefined;
	if (history) {
		value.workersHistory = Object.fromEntries(
			Object.entries(history).map(([id, entries]) => [
				id,
				{ length: entries.length, first: entries[0], last: entries[entries.length - 1] },
			]),
		);
	}
	if (value.statusInterval !== null && value.statusInterval !== undefined) {
		value.statusInterval = `<${typeof value.statusInterval}>`;
	}
	return brief(value) as Record<string, unknown>;
}

/** The ids of the workers that the store keeps. */
const workerIds = () => Object.keys(subject.useOrchestrationStore().workers).sort();

/** A list as runs of equal values: a value, or `[value, count]` for a run of more than one. */
function runs(values: unknown): unknown {
	if (!Array.isArray(values)) return values;
	const result: unknown[] = [];
	let index = 0;
	while (index < values.length) {
		let end = index + 1;
		while (end < values.length && Object.is(values[end], values[index])) end++;
		result.push(end - index > 1 ? [values[index], end - index] : values[index]);
		index = end;
	}
	return result;
}

/** The charts on the page, as the stub shows them, with the labels and the points as runs. */
function charts() {
	return [...document.body.querySelectorAll('[data-chart]')].map((element) => {
		const chart = JSON.parse(element.getAttribute('data-chart') ?? '{}') as Record<string, unknown>;
		const datasets = (chart.datasets ?? []) as Array<Record<string, unknown>>;
		return {
			...chart,
			labels: runs(chart.labels),
			datasets: datasets.map((dataset) => ({ ...dataset, points: runs(dataset.points) })),
		};
	});
}

/** The text of each worker card. */
const cards = () =>
	[...document.body.querySelectorAll('[data-test-id="worker-card"]')].map((element) =>
		normalize(element.textContent),
	);

type PageStep = Step | ['push', WorkerStatus] | ['stop polling'];

/** Clicks the n-th innermost element with this text. */
function clickText(text: string, position = 0): Step {
	return [
		'run',
		`click ${text} #${position}`,
		async () => {
			const matches = [...document.body.querySelectorAll('*')].filter(
				(element) =>
					normalize(element.textContent) === text &&
					![...element.children].some((child) => normalize(child.textContent) === text),
			);
			const element = matches[position];
			if (!element) return 'missing';
			await fireEvent.click(element);
			return undefined;
		},
	];
}

async function pageSteps(scenario: Scenario, steps: PageStep[]) {
	await prepare(scenario, server());
	await mountComponent(subject.WorkerView);
	const withCharts = (entry: Record<string, unknown>) => {
		const shown = charts();
		return shown.length ? { ...entry, charts: shown } : entry;
	};
	const result: unknown[] = [
		withCharts({ mount: true, title: document.title, ...effects(), screen: screen() }),
	];
	for (const step of steps) {
		if (Array.isArray(step) && step[0] === 'push') {
			subject.useOrchestrationStore().updateWorkerStatus(step[1]);
			result.push(withCharts(await act(['run', `push ${step[1].senderId}`, () => undefined])));
			continue;
		}
		if (Array.isArray(step) && step[0] === 'stop polling') {
			result.push(
				withCharts(
					await act([
						'run',
						'stop polling',
						() => subject.useOrchestrationStore().stopWorkerStatusPolling(),
					]),
				),
			);
			continue;
		}
		result.push(withCharts(await act(step as Step)));
	}
	return result;
}

/**
 * The text of the cards at exact times after a status. The times count from the push, and the
 * requests of the polling are counted.
 */
async function ages(offsets: number[], pushes: Record<number, WorkerStatus> = {}) {
	const store = subject.useOrchestrationStore();
	const result: unknown[] = [];
	let now = 0;
	for (const offset of offsets) {
		await vi.advanceTimersByTimeAsync(offset - now);
		now = offset;
		if (pushes[offset]) store.updateWorkerStatus(pushes[offset]);
		await nextTick();
		await nextTick();
		const taken = takeLog() as unknown[][];
		const requests = taken.filter((entry) => entry[0] === 'request').length;
		const other = taken.filter((entry) => entry[0] !== 'request');
		result.push({
			at: offset,
			...(pushes[offset] ? { push: pushes[offset].senderId } : {}),
			requests,
			...(other.length ? { effects: other } : {}),
			workers: workerIds(),
			cards: cards(),
			...(cards().length ? {} : { page: normalize(document.body.textContent) }),
		});
	}
	return result;
}

// #endregion

beforeEach(() => {
	installRecorders();
	Object.defineProperty(document, 'execCommand', {
		configurable: true,
		value: (...args: unknown[]) => {
			record('document.execCommand', args[0]);
			return true;
		},
	});
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				record('clipboard.writeText', text);
			},
			readText: async () => '',
		},
	});
	vi.useFakeTimers({
		now: new Date('2026-03-01T12:00:00.000Z'),
		toFake: [
			'setTimeout',
			'clearTimeout',
			'setInterval',
			'clearInterval',
			'Date',
			'requestAnimationFrame',
			'cancelAnimationFrame',
		],
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(finishPages);

describe('the worker view', () => {
	test('the store', async () => {
		await prepare(SCENARIO, server());
		const store = subject.useOrchestrationStore();
		const result: Record<string, unknown> = {
			WORKER_HISTORY_LENGTH: subject.WORKER_HISTORY_LENGTH,
			id: store.$id,
			members: Object.keys(store)
				.filter((key) => !key.startsWith('$') && !key.startsWith('_'))
				.sort(),
			'initial state': state(),
		};

		store.updateWorkerStatus(status('worker-a'));
		result['one status'] = plain(store.$state);

		await vi.advanceTimersByTimeAsync(1_000);
		store.updateWorkerStatus(status('worker-b', { poolName: 'gpu', queueName: 'jobs-gpu' }));
		result['a second worker'] = state();

		await vi.advanceTimersByTimeAsync(1_000);
		store.updateWorkerStatus(
			status('worker-a', { runningJobsSummary: [job('101')], uptime: 12_346 }),
		);
		result['a new status of the first worker'] = state();

		result.getters = {
			'getWorkerLastUpdated(worker-a)': plain(store.getWorkerLastUpdated('worker-a')),
			'getWorkerLastUpdated(unknown)': plain(store.getWorkerLastUpdated('unknown')),
			'getWorkerStatus(worker-b)': plain(store.getWorkerStatus('worker-b')),
			'getWorkerStatus(unknown)': plain(store.getWorkerStatus('unknown')),
			'getWorkerStatusHistory(worker-a)': plain(store.getWorkerStatusHistory('worker-a')),
			'getWorkerStatusHistory(unknown)': plain(store.getWorkerStatusHistory('unknown')),
		};

		const length = Number(subject.WORKER_HISTORY_LENGTH);
		for (let index = 0; index < length + 5; index++) {
			await vi.advanceTimersByTimeAsync(100);
			store.updateWorkerStatus(status('worker-c', { uptime: index }));
		}
		result['more statuses than the history keeps'] = state();
		result['the history of worker-c'] = (
			plain(store.getWorkerStatusHistory('worker-c')) as Array<Record<string, unknown>>
		).map((entry) => ({
			...entry,
			data: (entry.data as Record<string, unknown> | undefined)?.uptime ?? entry.data,
		}));

		result.effects = effects();
		expect(result).toMatchSnapshot();
	});

	test('the removal of stale workers', async () => {
		await prepare(SCENARIO, server());
		const store = subject.useOrchestrationStore();
		const result: Record<string, unknown> = {};
		const removedAt = (ids: string[]) => ids.filter((id) => !workerIds().includes(id));

		// A coarse search, one call each second.
		store.updateWorkerStatus(status('worker-old'));
		await vi.advanceTimersByTimeAsync(10_000);
		store.updateWorkerStatus(status('worker-new'));
		const coarse: unknown[] = [];
		let lastGone = '';
		for (let elapsed = 10_000; elapsed <= 160_000; elapsed += 1_000) {
			store.removeStaleWorkers();
			const gone = removedAt(['worker-old', 'worker-new']);
			if (JSON.stringify(gone) !== lastGone) coarse.push({ elapsed, gone, workers: workerIds() });
			lastGone = JSON.stringify(gone);
			await vi.advanceTimersByTimeAsync(1_000);
		}
		result['a call each second'] = coarse;
		result['the state after all workers are gone'] = state();

		// A fine search around each whole second from 100 s to 130 s.
		const fine: string[] = [];
		for (let second = 100; second <= 130; second++) {
			for (const offset of [-1, 0, 1]) {
				const age = second * 1_000 + offset;
				store.updateWorkerStatus(status('worker-probe'));
				await vi.advanceTimersByTimeAsync(age);
				store.removeStaleWorkers();
				fine.push(`${age}: ${workerIds().includes('worker-probe') ? 'kept' : 'removed'}`);
				store.removeStaleWorkers();
				await vi.advanceTimersByTimeAsync(200_000);
				store.removeStaleWorkers();
			}
		}
		result['a status of each age'] = fine.filter(
			(entry, index) => index === 0 || entry.split(': ')[1] !== fine[index - 1].split(': ')[1],
		);
		result['the ages'] = fine.length;

		// Other workers keep their status and their history.
		store.updateWorkerStatus(status('worker-a'));
		await vi.advanceTimersByTimeAsync(60_000);
		store.updateWorkerStatus(status('worker-b'));
		await vi.advanceTimersByTimeAsync(80_000);
		store.removeStaleWorkers();
		result['one stale worker of two'] = state();
		result.effects = effects();
		expect(result).toMatchSnapshot();
	});

	test('the polling of the store', async () => {
		await prepare(SCENARIO, server());
		const store = subject.useOrchestrationStore();
		const result: Record<string, unknown> = {};
		const steps: unknown[] = [];
		const run = async (name: string, action: () => unknown) => {
			let outcome: unknown = 'done';
			try {
				const value = await action();
				if (value !== undefined && name.startsWith('st')) outcome = plain(value);
			} catch (error) {
				outcome = { error: String(error) };
			}
			const taken = takeLog() as unknown[][];
			steps.push({
				step: name,
				outcome,
				requests: taken.filter((entry) => entry[0] === 'request').length,
				...(taken.some((entry) => entry[0] !== 'request')
					? { effects: taken.filter((entry) => entry[0] !== 'request') }
					: {}),
				state: state(),
			});
		};
		const wait = async (ms: number) =>
			await run(`wait ${ms}`, () => vi.advanceTimersByTimeAsync(ms));
		await run('start', () => store.startWorkerStatusPolling());
		for (const ms of [999, 1, 500, 500, 1_000, 2_000, 5_000]) await wait(ms);
		await wait(500);
		await run('start again, half way to the next request', () => store.startWorkerStatusPolling());
		for (const ms of [499, 1, 499, 1, 5_000]) await wait(ms);
		await run('stop', () => store.stopWorkerStatusPolling());
		await wait(10_000);
		await run('stop again', () => store.stopWorkerStatusPolling());
		store.updateWorkerStatus(status('worker-a'));
		await run('a status, then start', () => store.startWorkerStatusPolling());
		await wait(5_000);
		await wait(60_000);
		await wait(60_000);
		await wait(60_000);
		await run('stop', () => store.stopWorkerStatusPolling());

		// A request that fails, with a stale worker. The rejections of the requests are recorded.
		route('POST', /^(\/rest)?\/orchestration\/worker\/status$/, () => {
			throw new ServerError(500, 'Redis is down');
		});
		store.updateWorkerStatus(status('worker-stale'));
		await vi.advanceTimersByTimeAsync(125_000);
		const rejections: string[] = [];
		const listeners = process.listeners('unhandledRejection');
		process.removeAllListeners('unhandledRejection');
		const onRejection = (reason: unknown) =>
			rejections.push(reason instanceof Error ? reason.message : String(reason));
		process.on('unhandledRejection', onRejection);
		try {
			await run('start with a failing server', () => store.startWorkerStatusPolling());
			await wait(1_000);
			await new Promise((resolve) => setImmediate(resolve));
			await wait(2_000);
			await new Promise((resolve) => setImmediate(resolve));
			await run('stop', () => store.stopWorkerStatusPolling());
		} finally {
			process.off('unhandledRejection', onRejection);
			for (const listener of listeners) process.on('unhandledRejection', listener);
		}
		result.rejections = rejections;
		result.steps = steps;
		result.errors = effects();
		expect(result).toMatchSnapshot();
	});

	test('the page with workers', async () => {
		const result: Record<string, unknown> = {};
		result['no status yet'] = await pageSteps(SCENARIO, [
			['wait', 1_000],
			['wait', 5_000],
		]);
		result.workers = await pageSteps(SCENARIO, [
			['push', status('worker-a')],
			[
				'push',
				status('worker-b', {
					poolName: 'gpu',
					queueName: 'jobs-gpu',
					isInContainer: true,
					runningJobsSummary: [
						job('101'),
						job('102', { mode: 'retry', retryOf: '99', workflowName: 'Retry of a sync' }),
						job('103', { mode: 'manual', startedAt: '2026-03-01T10:00:00.000Z' }),
					],
				}),
			],
			['wait', 1_000],
			['push', status('worker-a', { uptime: 12_346, loadAvg: [1, 2, 4] })],
			['push', status('worker-c', { hostname: 'worker-c-host' })],
		]);
		expect(result).toMatchSnapshot();
	});

	test('the age of a status on the page', async () => {
		const result: Record<string, unknown> = {};
		await prepare(SCENARIO, server());
		await mountComponent(subject.WorkerView);
		takeLog();
		const offsets = [
			0, 1, 400, 499, 500, 501, 999, 1_000, 1_001, 1_499, 1_500, 2_000, 5_000, 9_000, 9_499, 9_500,
			9_999, 10_000, 10_001, 10_499, 10_500, 10_999, 11_000, 11_001, 12_000, 15_000, 20_000, 30_000,
			31_000, 45_000, 60_000, 90_000, 119_000, 120_000, 121_000, 125_000, 150_000, 180_000,
		];
		result['one status'] = await ages(offsets, { 0: status('worker-a') });
		result['the page without workers'] = screen();
		expect(result).toMatchSnapshot();
	});

	test('the clock of the age', async () => {
		const result: Record<string, unknown> = {};
		await prepare(SCENARIO, server());
		await mountComponent(subject.WorkerView);
		takeLog();
		const offsets: number[] = [];
		for (let offset = 0; offset <= 3_000; offset += 50) offsets.push(offset);
		for (let offset = 3_000; offset <= 6_000; offset += 25) offsets.push(offset + 1_234);
		const samples = await ages(
			[...new Set(offsets)].sort((a, b) => a - b),
			{
				0: status('worker-a'),
				1_100: status('worker-b'),
				4_234: status('worker-a', { uptime: 1 }),
			},
		);
		// Only the samples where the text of the card changes.
		let last = '';
		result.samples = samples.filter((sample) => {
			const text = JSON.stringify((sample as { cards: unknown }).cards);
			const changed = text !== last;
			last = text;
			return changed || (sample as { push?: string }).push;
		});
		expect(result).toMatchSnapshot();
	});

	test('the page with statuses from before', async () => {
		const result: Record<string, unknown> = {};
		await prepare(SCENARIO, server());
		const store = subject.useOrchestrationStore();
		store.updateWorkerStatus(status('worker-a'));
		await vi.advanceTimersByTimeAsync(5_300);
		store.updateWorkerStatus(status('worker-b'));
		await vi.advanceTimersByTimeAsync(12_000);
		await mountComponent(subject.WorkerView);
		result.mount = { ...effects(), screen: screen() };
		result.ages = await ages([0, 1, 349, 350, 351, 499, 500, 501, 849, 850, 1_000, 1_350, 1_500]);
		expect(result).toMatchSnapshot();
	});

	test('the age of a status with new statuses and without polling', async () => {
		const result: Record<string, unknown> = {};
		await prepare(SCENARIO, server());
		await mountComponent(subject.WorkerView);
		takeLog();
		result['new statuses'] = await ages(
			[0, 3_000, 5_000, 5_500, 6_000, 8_000, 12_000, 14_000, 16_000, 20_000],
			{
				0: status('worker-a'),
				5_000: status('worker-a'),
				8_000: status('worker-a', { uptime: 99 }),
				14_000: status('worker-b'),
			},
		);
		subject.useOrchestrationStore().stopWorkerStatusPolling();
		result['without polling'] = await ages([20_000, 21_000, 25_000, 40_000, 200_000]);
		expect(result).toMatchSnapshot();
	});

	test('the formats of a worker card', async () => {
		const result: Record<string, unknown> = {};
		const card = async (name: string, value: WorkerStatus) => {
			result[name] = await pageSteps(SCENARIO, [
				['push', value],
				'Memory Monitoring',
				`Network Interfaces (${value.interfaces.length})`,
				'Performance Monitoring',
			]);
		};
		await card(
			'odd numbers',
			status('worker-a', {
				loadAvg: [1.234, 0.001, 7.777],
				uptime: 200_000.75,
				freeMem: 1.37 * GB,
				totalMem: 7.81 * GB,
				host: { memory: { total: 7.81 * GB, free: 1.37 * GB } },
				process: {
					memory: {
						available: 1.555 * GB,
						constraint: 3.333 * GB,
						rss: 123_456_789,
						heapTotal: 98_765_432,
						heapUsed: 12_345,
					},
					uptime: 59.9,
				},
				runningJobsSummary: [
					job('201', { startedAt: '2026-02-27T08:30:15.000Z' }),
					job('202', { startedAt: '2026-03-01T11:59:59.500Z', mode: 'webhook' }),
					job('203', { startedAt: '2026-03-01T12:00:30.000Z', mode: 'manual' }),
				],
			}),
		);
		await card(
			'a container without a constraint',
			status('worker-b', {
				isInContainer: true,
				loadAvg: [],
				uptime: 0,
				process: {
					memory: { available: 0, constraint: 0, rss: 0, heapTotal: 0, heapUsed: 0 },
					uptime: 0,
				},
				interfaces: [],
				cpus: '',
				platform: 'win32',
				arch: 'arm64',
				version: '',
			}),
		);
		await card(
			'small and large values',
			status('worker-c', {
				loadAvg: [10.5, 20.25, 30.125],
				uptime: 86_399,
				freeMem: 512 * 1024,
				totalMem: 3 * 1024 * GB,
				host: { memory: { total: 3 * 1024 * GB, free: 512 * 1024 } },
				process: {
					memory: {
						available: 900 * 1024 * 1024,
						constraint: 2.5 * GB,
						rss: 1_000,
						heapTotal: 1_048_576,
						heapUsed: 1_048_575,
					},
					uptime: 3_600,
				},
				poolName: 'a pool with a long name',
				queueName: 'jobs-a pool with a long name',
			}),
		);
		expect(result).toMatchSnapshot();
	});

	test('the history in the charts', async () => {
		const result: Record<string, unknown> = {};
		const steps: PageStep[] = ['Performance Monitoring'];
		const pushes: PageStep[] = [];
		for (let index = 0; index < 6; index++) {
			pushes.push(
				[
					'push',
					status('worker-a', {
						loadAvg: [index, index / 2, index / 4],
						freeMem: (index + 1) * GB,
						host: { memory: { total: 8 * GB, free: (index + 1) * GB } },
						process: {
							memory: {
								available: (index + 2) * GB,
								constraint: 4 * GB,
								rss: (index + 1) * 100_000_000,
								heapTotal: 0.25 * GB,
								heapUsed: (index + 1) * 10_000_000,
							},
							uptime: 100 + index,
						},
					}),
				],
				['wait', 1_000],
			);
		}
		result.steps = await pageSteps(SCENARIO, [pushes[0], ...steps, ...pushes.slice(1)]);
		expect(result).toMatchSnapshot();
	});

	test('the order of the cards, the interfaces and the jobs', async () => {
		const result: Record<string, unknown> = {};
		result.steps = await pageSteps(SCENARIO, [
			['push', status('worker-z', { hostname: 'z-host' })],
			['push', status('worker-m', { hostname: 'm-host' })],
			[
				'push',
				status('worker-a', {
					hostname: 'a-host',
					interfaces: [
						{ family: 'IPv6', address: 'fe80::1', internal: false },
						{ family: 'IPv4', address: '192.168.1.1', internal: false },
						{ family: 'IPv4', address: '10.0.0.1', internal: true },
						{ family: 'IPv6', address: '::1', internal: true },
						{ family: 'IPv4', address: '172.16.0.1', internal: false },
					],
					runningJobsSummary: [
						job('305', { startedAt: '2026-03-01T11:00:00.000Z' }),
						job('301', { startedAt: '2026-03-01T11:30:00.000Z' }),
						job('310', { startedAt: '2026-03-01T10:00:00.000Z', workflowName: '' }),
					],
				}),
			],
			['push', status('worker-m', { hostname: 'm-host', uptime: 1 })],
			clickText('Network Interfaces (5)'),
			'172.16.0.1',
		]);
		expect(result).toMatchSnapshot();
	});

	test('the memory of a worker', async () => {
		const result: Record<string, unknown> = {};
		const memory = async (name: string, value: WorkerStatus) => {
			const steps = await pageSteps(SCENARIO, [['push', value], 'Memory Monitoring']);
			result[name] = cards();
			result[`${name}: steps`] = steps.length;
		};
		const base = {
			freeMem: 3 * GB,
			totalMem: 16 * GB,
			host: { memory: { total: 12 * GB, free: 5 * GB } },
			process: {
				memory: {
					available: 1.25 * GB,
					constraint: 6 * GB,
					rss: 300 * 1024 * 1024,
					heapTotal: 200 * 1024 * 1024,
					heapUsed: 100 * 1024 * 1024,
				},
				uptime: 1,
			},
		};
		await memory('a host', status('worker-a', base));
		await memory('a container', status('worker-b', { ...base, isInContainer: true }));
		await memory(
			'a container with a small constraint',
			status('worker-c', {
				...base,
				isInContainer: true,
				process: { ...base.process, memory: { ...base.process.memory, constraint: 512 * 1024 } },
			}),
		);
		expect(result).toMatchSnapshot();
	});

	test('the charts of several workers', async () => {
		const result: Record<string, unknown> = {};
		const pushes: PageStep[] = [];
		for (let index = 0; index < 4; index++) {
			pushes.push(
				[
					'push',
					status('worker-a', {
						runningJobsSummary: Array.from({ length: index }, (_, item) => job(`${index}-${item}`)),
						isInContainer: index % 2 === 1,
						loadAvg: [index * 10, 1, 2],
						process: {
							memory: {
								available: (index + 1) * GB,
								constraint: 5 * GB,
								rss: 1,
								heapTotal: 1,
								heapUsed: 1,
							},
							uptime: index,
						},
					}),
				],
				['push', status('worker-b', { runningJobsSummary: [job(`b-${index}`)] })],
				['wait', 1_000],
			);
		}
		result.steps = await pageSteps(SCENARIO, [
			...pushes.slice(0, 6),
			clickText('Performance Monitoring'),
			clickText('Performance Monitoring', 1),
			...pushes.slice(6),
		]);
		expect(result).toMatchSnapshot();
	});

	test('the values of the charts', async () => {
		const result: Record<string, unknown> = {};
		const values: WorkerStatus[] = [
			status('worker-a', {
				host: { memory: { total: 12 * GB, free: 1 } },
				process: {
					memory: { available: 1.25 * GB, constraint: 0, rss: 1, heapTotal: 1, heapUsed: 1 },
					uptime: 1,
				},
				loadAvg: [1.1, 2.2, 3.3],
			}),
			status('worker-a', {
				host: { memory: { total: 7.81 * GB, free: 1 } },
				process: {
					memory: { available: 1.555 * GB, constraint: 0, rss: 1, heapTotal: 1, heapUsed: 1 },
					uptime: 1,
				},
				loadAvg: [0.1, 0.2],
			}),
			status('worker-a', {
				isInContainer: true,
				process: {
					memory: {
						available: 1.555 * GB,
						constraint: 3.333 * GB,
						rss: 1,
						heapTotal: 1,
						heapUsed: 1,
					},
					uptime: 1,
				},
				loadAvg: [],
			}),
			status('worker-a', {
				isInContainer: true,
				process: {
					memory: { available: 0, constraint: 0, rss: 1, heapTotal: 1, heapUsed: 1 },
					uptime: 1,
				},
			}),
			status('worker-a', {
				host: { memory: { total: 0, free: 0 } },
				process: {
					memory: { available: 1 * GB, constraint: 0, rss: 1, heapTotal: 1, heapUsed: 1 },
					uptime: 1,
				},
			}),
			status('worker-a'),
		];
		const steps: PageStep[] = [['push', values[0]], 'Performance Monitoring'];
		for (const value of values.slice(1)) steps.push(['push', value]);
		const recorded = await pageSteps(SCENARIO, steps);
		result.charts = (recorded.at(-1) as { charts?: unknown }).charts;
		result.cards = cards();
		expect(result).toMatchSnapshot();
	});

	test('a long history in the charts', async () => {
		const result: Record<string, unknown> = {};
		await prepare(SCENARIO, server());
		await mountComponent(subject.WorkerView);
		const store = subject.useOrchestrationStore();
		for (let index = 0; index < 120; index++) {
			store.updateWorkerStatus(status('worker-a', { loadAvg: [index, index, index] }));
			await vi.advanceTimersByTimeAsync(500);
		}
		await act('Performance Monitoring');
		result['after the open'] = charts();
		store.updateWorkerStatus(status('worker-a', { loadAvg: [500, 500, 500] }));
		await settle();
		result['after one more status'] = charts();
		takeLog();
		expect(result).toMatchSnapshot();
	});

	test('the page without a licence or without queue mode', async () => {
		const result: Record<string, unknown> = {};
		result['without a licence'] = await pageSteps(
			{ ...SCENARIO, settings: { executionMode: 'queue', enterprise: { workerView: false } } },
			[['wait', 5_000], 'See plans', 'More info'],
		);
		result['without queue mode'] = await pageSteps(
			{ ...SCENARIO, settings: { executionMode: 'regular', enterprise: { workerView: true } } },
			[['wait', 5_000]],
		);
		result['without both'] = await pageSteps(
			{ ...SCENARIO, settings: { executionMode: 'regular', enterprise: { workerView: false } } },
			[['wait', 2_000]],
		);
		expect(result).toMatchSnapshot();
	});

	test('the controls of a worker card', async () => {
		const result: Record<string, unknown> = {};
		result.steps = await pageSteps(SCENARIO, [
			[
				'push',
				status('worker-a', {
					runningJobsSummary: [job('101'), job('102', { retryOf: '99', mode: 'retry' })],
				}),
			],
			'Current Jobs (2)',
			'Current Jobs (2)',
			'Network Interfaces (3)',
			'10.0.0.2',
			['inner', '10.0.0.2'],
			'fe80::42:acff:fe11:2',
			'Network Interfaces (3)',
			'Memory Monitoring',
			'Memory Monitoring',
			'Performance Monitoring',
			'Performance Monitoring',
			'Execution 101 - Workflow 101',
			['inner', 'Execution 102 - Workflow 102'],
			'(Open workflow)',
		]);
		expect(result).toMatchSnapshot();
	});

	test('the unmount of the page', async () => {
		const result: Record<string, unknown> = {};
		await prepare(SCENARIO, server());
		const rendered = createComponentRenderer(subject.WorkerView, {
			global: { plugins: [router] },
		})({ pinia });
		await settle();
		result.mount = { ...effects(), state: state() };
		await vi.advanceTimersByTimeAsync(10_000);
		result['after 10 s'] = { requests: takeLog().length, state: state() };
		subject.useOrchestrationStore().updateWorkerStatus(status('worker-a'));
		rendered.unmount();
		await settle();
		result.unmount = { ...effects(), state: state() };
		await vi.advanceTimersByTimeAsync(200_000);
		result['200 s after the unmount'] = { ...effects(), state: state() };
		expect(result).toMatchSnapshot();
	});
});
