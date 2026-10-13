// Fork code (not in upstream n8n): the helpers of the evaluation editor. See `FORK.md` in this
// folder.
import dateformat from 'dateformat';

import { convertToDisplayDate } from '@/app/utils/formatters/dateFormatter';

import { FIVE_POINT_METRIC_CATEGORIES, OPERATIONAL_METRIC_KEYS } from './evaluation.constants';
import type {
	MetricCategory,
	MetricValues,
	TestCaseExecutionRecord,
	TestRunRecord,
} from './evaluation.types';

/** A run that the backend has not finished yet. */
export const isActiveRun = (testRun: Pick<TestRunRecord, 'status'>) =>
	testRun.status === 'running' || testRun.status === 'new';

/** A case that runs now. A case with the status `new` waits for its turn. */
export const isRunningTestCase = (testCase: Pick<TestCaseExecutionRecord, 'status'>) =>
	testCase.status === 'running' || testCase.status === 'evaluation_running';

export type IndexedTestRun = TestRunRecord & { index: number };

const startTime = (testRun: TestRunRecord) => (testRun.runAt ? Date.parse(testRun.runAt) : 0);

/**
 * Numbers the runs from the oldest (1) to the newest. A run that has not started counts as the
 * oldest. Runs with the same start time keep their order.
 */
export function indexTestRuns(testRuns: TestRunRecord[]): IndexedTestRun[] {
	return [...testRuns]
		.sort((a, b) => startTime(a) - startTime(b))
		.map((testRun, position) => ({ ...testRun, index: position + 1 }));
}

/**
 * The order of the list of runs: the newest first. A run that has not started counts as started
 * now. Of the runs with the same start time, the run with the higher number comes first.
 */
export function newestFirst(testRuns: IndexedTestRun[]): IndexedTestRun[] {
	const now = Date.now();
	const shownTime = (testRun: TestRunRecord) => (testRun.runAt ? Date.parse(testRun.runAt) : now);
	return [...testRuns].sort((a, b) => shownTime(b) - shownTime(a) || b.index - a.index);
}

/** The start time of a run. A run that has not started shows the current time with its year. */
export function formatRunAt(runAt: string | null): string {
	if (!runAt) return dateformat(new Date(), 'mmm d, yyyy, HH:MM:ss');
	const { date, time } = convertToDisplayDate(runAt);
	return `${date}, ${time}`;
}

export const isOperationalMetric = (key: string) => OPERATIONAL_METRIC_KEYS.includes(key);

/** The metric keys of the runs, in the order of their first use from the oldest run. */
export function collectMetricKeys(testRuns: Array<{ metrics: MetricValues | null }>): string[] {
	const keys = new Set<string>();
	for (const testRun of testRuns) {
		for (const key of Object.keys(testRun.metrics ?? {})) keys.add(key);
	}
	return [...keys];
}

/** The metrics that a workflow sets, without the token counts and the execution time. */
export const userDefinedMetricKeys = (metrics: MetricValues | null | undefined) =>
	Object.keys(metrics ?? {}).filter((key) => !isOperationalMetric(key));

/** A metric value in the table of runs. */
export function formatMetricValue(value: number | boolean | undefined): string {
	if (value === undefined) return '';
	if (typeof value === 'boolean') return value ? '1.00' : '0.00';
	return value.toFixed(2);
}

/** The label of a metric key: the key with a capital first letter. */
export const formatMetricLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * A metric value as a share from 0 to 1. A language model scores from 1 to 5, so its score is
 * divided by 5. A boolean is 1 or 0. Other values above 1 are read as percentages.
 */
export function normalizeMetricValue(value: number | boolean, category?: MetricCategory): number {
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (category && FIVE_POINT_METRIC_CATEGORIES.includes(category)) return value / 5;
	return value > 1 ? value / 100 : value;
}

export const formatPercent = (share: number) => `${Math.round(share * 100)}%`;

/** The change of a metric from the previous run, in percentage points. */
export function formatDelta(delta: number): string {
	const points = Math.round(delta * 100);
	return `${points > 0 ? '+' : ''}${points}%`;
}

const numberFormat = new Intl.NumberFormat('en-US');

export const formatTokens = (tokens: number) => `${numberFormat.format(tokens)}t`;

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export const sortTestCases = (testCases: TestCaseExecutionRecord[]) =>
	[...testCases].sort((a, b) => (a.runIndex ?? 0) - (b.runIndex ?? 0));
