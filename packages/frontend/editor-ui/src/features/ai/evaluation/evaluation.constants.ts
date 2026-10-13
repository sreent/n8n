// Fork code (not in upstream n8n): the constants of the evaluation editor. See `FORK.md` in this
// folder.
import type { IconName } from '@n8n/design-system';
import type { BaseTextKey } from '@n8n/i18n';

import type { MetricCategory, TestRunStatus } from './evaluation.types';

/** How long the editor waits before it asks for the state of an active run again. */
export const POLLING_INTERVAL_MS = 1000;

export const EVALUATION_DOCS_URL = 'https://docs.n8n.io/advanced-ai/evaluations/overview/';

/** The metrics that the runner adds to each run. They are not scores. */
export const OPERATIONAL_METRIC_KEYS = [
	'promptTokens',
	'completionTokens',
	'totalTokens',
	'executionTime',
];

/** The message of each error code of a run, with an optional second line. */
export const TEST_RUN_ERROR_MESSAGES: Record<
	string,
	{ key: BaseTextKey; description?: BaseTextKey }
> = {
	CANT_FETCH_TEST_CASES: {
		key: 'evaluation.listRuns.error.cantFetchTestCases',
		description: 'evaluation.listRuns.error.cantFetchTestCases.description',
	},
	COMPILATION_FAILED: {
		key: 'evaluation.listRuns.error.compilationFailed',
		description: 'evaluation.listRuns.error.compilationFailed.description',
	},
	EVALUATION_CONFIG_NOT_FOUND: { key: 'evaluation.listRuns.error.evaluationConfigNotFound' },
	EVALUATION_TRIGGER_DISABLED: { key: 'evaluation.listRuns.error.evaluationTriggerDisabled' },
	EVALUATION_TRIGGER_NOT_CONFIGURED: {
		key: 'evaluation.listRuns.error.evaluationTriggerNotConfigured',
	},
	EVALUATION_TRIGGER_NOT_FOUND: { key: 'evaluation.listRuns.error.evaluationTriggerNotFound' },
	INTERRUPTED: { key: 'evaluation.listRuns.error.executionInterrupted' },
	PARTIAL_CASES_FAILED: { key: 'evaluation.runDetail.error.partialCasesFailed' },
	SET_METRICS_NODE_NOT_CONFIGURED: {
		key: 'evaluation.listRuns.error.setMetricsNodeNotConfigured',
	},
	SET_METRICS_NODE_NOT_FOUND: { key: 'evaluation.listRuns.error.setMetricsNodeNotFound' },
	SET_OUTPUTS_NODE_NOT_CONFIGURED: {
		key: 'evaluation.listRuns.error.setOutputsNodeNotConfigured',
	},
	TEST_CASES_NOT_FOUND: {
		key: 'evaluation.listRuns.error.testCasesNotFound',
		description: 'evaluation.listRuns.error.testCasesNotFound.description',
	},
	UNKNOWN_ERROR: { key: 'evaluation.runDetail.error.unknownError' },
};

/** The message of each error code of a test case. */
export const TEST_CASE_ERROR_MESSAGES: Record<string, BaseTextKey> = {
	FAILED_TO_EXECUTE_WORKFLOW: 'evaluation.runDetail.error.executionFailed',
	NO_METRICS_COLLECTED: 'evaluation.runDetail.error.noMetricsCollected',
	INVALID_METRICS: 'evaluation.runDetail.error.invalidMetrics',
	UNKNOWN_ERROR: 'evaluation.runDetail.error.unknownError',
};

/** The icon of a run in the list of runs. A running run shows a spinner, a failed run its error. */
export const TEST_RUN_STATUS_ICONS: Partial<Record<TestRunStatus, IconName>> = {
	new: 'status-new',
	completed: 'status-completed',
	cancelled: 'status-canceled',
};

/** The kind of each built-in metric of the Evaluation node. */
export const BUILT_IN_METRIC_CATEGORIES: Record<string, MetricCategory> = {
	correctness: 'aiBased',
	helpfulness: 'aiBased',
	stringSimilarity: 'stringSimilarity',
	categorization: 'categorization',
	toolsUsed: 'toolsUsed',
};

/** The metric name of each built-in metric when the node does not set one. */
export const BUILT_IN_METRIC_NAMES: Record<string, string> = {
	correctness: 'Correctness',
	helpfulness: 'Helpfulness',
	stringSimilarity: 'String similarity',
	categorization: 'Categorization',
	toolsUsed: 'Tools Used',
};

/** The metrics that a language model scores from 1 to 5. */
export const FIVE_POINT_METRIC_CATEGORIES: MetricCategory[] = ['aiBased'];

export const UPGRADE_SOURCE = 'evaluations';
export const UPGRADE_CAMPAIGN = 'upgrade-evaluations';
