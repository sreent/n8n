// Fork code (not in upstream n8n): the helpers of the collections of evaluations. See `FORK.md`
// in this folder.
import type { EvaluationCollectionDetail, EvaluationCollectionRunSummary } from '@n8n/api-types';
import { i18n } from '@n8n/i18n';
import dateformat from 'dateformat';

const isActive = (status: string) => status === 'running' || status === 'new';

export type CollectionState =
	| { kind: 'running'; completed: number; total: number }
	| { kind: 'failed' }
	| { kind: 'done' };

/**
 * A collection runs while one of its runs runs or waits. It failed when all its runs failed.
 * Else it is done.
 */
export function collectionState(detail: EvaluationCollectionDetail): CollectionState {
	const total = detail.runs.length;
	if (detail.runs.some((run) => isActive(run.status))) {
		return {
			kind: 'running',
			completed: detail.runs.filter((run) => !isActive(run.status)).length,
			total,
		};
	}
	if (total > 0 && detail.runs.every((run) => run.status === 'error')) return { kind: 'failed' };
	return { kind: 'done' };
}

/** The label of the state of a collection: "Done", "Failed" or "Running · 1/2 versions finished". */
export function collectionStateLabel(state: CollectionState): string {
	if (state.kind === 'running') {
		return i18n.baseText('evaluation.collections.card.runningProgress', {
			interpolate: { completed: state.completed, total: state.total },
		});
	}
	return state.kind === 'failed'
		? i18n.baseText('evaluation.collections.card.failed')
		: i18n.baseText('evaluation.collections.card.done');
}

/** The insights compare versions, so they need two or more runs that all completed. */
export const canHaveInsights = (detail: EvaluationCollectionDetail) =>
	detail.runs.length >= 2 && detail.runs.every((run) => run.status === 'completed');

const isToday = (date: Date) =>
	dateformat(date, 'yyyy-mm-dd') === dateformat(new Date(), 'yyyy-mm-dd');

/** The end of the last run of a collection: "today, 02:05 PM" or "Jan 1, 02:05 PM". */
export function formatLastRun(runs: EvaluationCollectionRunSummary[]): string | undefined {
	const times = runs
		.map((run) => run.completedAt ?? run.runAt)
		.filter((time): time is string => !!time)
		.map((time) => new Date(time));
	if (times.length === 0) return undefined;
	const last = new Date(Math.max(...times.map((time) => time.getTime())));
	const time = dateformat(last, 'hh:MM TT');
	return isToday(last)
		? i18n.baseText('evaluation.collections.card.lastRunToday', { interpolate: { time } })
		: i18n.baseText('evaluation.collections.card.lastRunOn', {
				interpolate: { date: dateformat(last, 'mmm d'), time },
			});
}

/** The short name of the version of a run: the current draft, or the start of the version ID. */
export function versionLabel(run: Pick<EvaluationCollectionRunSummary, 'workflowVersionId'>) {
	return run.workflowVersionId === null
		? i18n.baseText('evaluation.collections.card.currentDraft')
		: run.workflowVersionId.slice(0, 7);
}
