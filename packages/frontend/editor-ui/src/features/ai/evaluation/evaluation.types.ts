// Fork code (not in upstream n8n): the shapes of the evaluation REST API that the editor reads.
// See `FORK.md` in this folder.
import type { EvaluationConfigDto } from '@n8n/api-types';

export type TestRunStatus = 'new' | 'running' | 'completed' | 'error' | 'cancelled';

export type TestCaseExecutionStatus =
	| 'new'
	| 'running'
	| 'evaluation_running'
	| 'success'
	| 'error'
	| 'warning'
	| 'cancelled';

export type MetricValues = Record<string, number | boolean>;

/** The scale of a metric of a run: a score from 0 to 1, or from 1 to 5. */
export type MetricScale = 'unit' | 'fivePoint';

export interface TestRunRecord {
	id: string;
	workflowId: string;
	status: TestRunStatus;
	runAt: string | null;
	completedAt: string | null;
	metrics: MetricValues | null;
	errorCode: string | null;
	errorDetails: Record<string, unknown> | null;
	createdAt: string;
	updatedAt: string;
	runningInstanceId?: string | null;
	cancelRequested?: boolean;
	workflowVersionId?: string | null;
	evaluationConfigId?: string | null;
	collectionId?: string | null;
	testCaseCount?: number;
	finalResult?: 'success' | 'error' | 'warning' | null;
	metricScales?: Record<string, string>;
}

export interface TestCaseExecutionRecord {
	id: string;
	testRunId: string;
	executionId: string | null;
	status: TestCaseExecutionStatus;
	runAt: string | null;
	completedAt: string | null;
	errorCode: string | null;
	errorDetails: Record<string, unknown> | null;
	runIndex?: number | null;
	metrics: MetricValues | null;
	inputs?: Record<string, unknown> | null;
	outputs?: Record<string, unknown> | null;
}

export interface StartTestRunResponse {
	success: boolean;
	testRunId: string;
}

export type EvaluationConfig = EvaluationConfigDto;

/** The kind of a metric of a Set Metrics node, as the run detail shows it. */
export type MetricCategory =
	| 'aiBased'
	| 'stringSimilarity'
	| 'categorization'
	| 'toolsUsed'
	| 'custom';

export interface MetricSource {
	category: MetricCategory;
	nodeName: string;
}
