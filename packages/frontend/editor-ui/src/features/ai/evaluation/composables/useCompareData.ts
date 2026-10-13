// Fork code (not in upstream n8n): the data of the comparison of a collection: its versions, the
// score of each metric for each version, and the score of each case for each version. It replaces
// the enterprise composable of the same name. See `../FORK.md`.
import type { EvaluationCollectionDetail, MetricScale } from '@n8n/api-types';
import { normalizedScores } from '@n8n/api-types';
import { computed, type Ref } from 'vue';

import { versionLabel } from '../evalCollections.utils';
import type { TestCaseExecutionRecord } from '../evaluation.types';

export type CompareTab = 'cases' | 'outputs' | 'metrics' | 'workflowDiff';

export type CompareVersion = {
	index: number;
	testRunId: string;
	workflowVersionId: string | null;
	label: string;
	status: string;
	avgScore: number | null;
	isBest: boolean;
};

export type CompareMetricGroup = {
	key: string;
	/** The score of each version, in the order of the versions. */
	values: Array<number | null>;
};

export type CompareCaseRow = {
	/** The position of the case in the dataset, from 0. */
	runIndex: number;
	input: string;
	/** The average score of the case for each version. */
	values: Array<number | null>;
	bestIndex: number | null;
	/** The version with the largest fall from the best version, and the fall. */
	worst: { index: number; delta: number } | null;
	inputs: Record<string, unknown>;
	outputs: Array<Record<string, unknown> | null>;
	metrics: Array<Record<string, number>>;
	executionIds: Array<string | null>;
};

/** The first value of an object as text, for the input or the output of a case. */
export function firstText(values: Record<string, unknown> | null | undefined): string {
	const first = Object.values(values ?? {})[0];
	if (first === undefined || first === null) return '';
	return typeof first === 'string' ? first : JSON.stringify(first);
}

const average = (values: number[]) =>
	values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function useCompareData(
	detail: Ref<EvaluationCollectionDetail | undefined>,
	casesByRunId: Ref<Record<string, TestCaseExecutionRecord[]>>,
) {
	const scalesOf = (index: number): Record<string, MetricScale> => {
		const run = detail.value?.runs[index];
		return run?.metricScales ?? detail.value?.metricScales ?? {};
	};

	const versions = computed((): CompareVersion[] => {
		const runs = detail.value?.runs ?? [];
		const scores = runs.map((run) => run.avgScore);
		const best = Math.max(...scores.filter((score): score is number => score !== null));
		return runs.map((run, index) => ({
			index,
			testRunId: run.testRunId,
			workflowVersionId: run.workflowVersionId,
			label: versionLabel(run),
			status: run.status,
			avgScore: run.avgScore,
			isBest: run.avgScore !== null && run.avgScore === best,
		}));
	});

	const metricGroups = computed((): CompareMetricGroup[] => {
		const runs = detail.value?.runs ?? [];
		const scores = runs.map((run, index) => normalizedScores(run.metrics, scalesOf(index)));
		const keys = [...new Set(scores.flatMap((score) => Object.keys(score)))];
		return keys.map((key) => ({ key, values: scores.map((score) => score[key] ?? null) }));
	});

	/** The count of cases of each version that completed. A failed version has no cases to count. */
	const caseCounts = computed(() =>
		(detail.value?.runs ?? [])
			.filter((run) => run.status === 'completed')
			.map((run) => casesByRunId.value[run.testRunId]?.length ?? 0),
	);

	/** The counts of cases of the versions when they differ, else null. */
	const datasetMismatch = computed(() =>
		new Set(caseCounts.value).size > 1 ? caseCounts.value : null,
	);

	const caseRows = computed((): CompareCaseRow[] => {
		const runs = detail.value?.runs ?? [];
		const byIndex = new Map<number, CompareCaseRow>();
		runs.forEach((run, versionIndex) => {
			for (const testCase of casesByRunId.value[run.testRunId] ?? []) {
				const runIndex = testCase.runIndex ?? 0;
				let row = byIndex.get(runIndex);
				if (!row) {
					row = {
						runIndex,
						input: firstText(testCase.inputs),
						values: runs.map(() => null),
						bestIndex: null,
						worst: null,
						inputs: testCase.inputs ?? {},
						outputs: runs.map(() => null),
						metrics: runs.map(() => ({})),
						executionIds: runs.map(() => null),
					};
					byIndex.set(runIndex, row);
				}
				const scores = normalizedScores(testCase.metrics, scalesOf(versionIndex));
				row.metrics[versionIndex] = scores;
				row.values[versionIndex] = average(Object.values(scores));
				row.outputs[versionIndex] = testCase.outputs ?? null;
				row.executionIds[versionIndex] = testCase.executionId;
			}
		});
		const rows = [...byIndex.values()].sort((a, b) => a.runIndex - b.runIndex);
		for (const row of rows) {
			const scored = row.values
				.map((value, index) => ({ value, index }))
				.filter((item): item is { value: number; index: number } => item.value !== null);
			if (scored.length === 0) continue;
			const best = scored.reduce((top, item) => (item.value > top.value ? item : top));
			row.bestIndex = best.index;
			const others = scored.filter((item) => item.index !== best.index);
			if (others.length) {
				const worst = others.reduce((low, item) => (item.value < low.value ? item : low));
				row.worst = { index: worst.index, delta: worst.value - best.value };
			}
		}
		return rows;
	});

	return { versions, metricGroups, caseRows, datasetMismatch, caseCounts };
}
