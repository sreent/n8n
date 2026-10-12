import type { EvaluationMetric, MetricScale } from '@n8n/api-types';
import { metricScalesFromConfig, metricScalesFromSnapshot } from '@n8n/api-types';
import type { EvaluationConfig, TestRun } from '@n8n/db';

/**
 * Fork code (not in upstream n8n): the scale of each metric of a run, from the copy of the config
 * that the run kept. A run without a copy takes the scales of the live config. See `FORK.md`.
 */
export function runMetricScales(
	testRun: Pick<TestRun, 'evaluationConfigSnapshot'>,
	liveConfig?: Pick<EvaluationConfig, 'metrics'> | null,
): Record<string, MetricScale> | null {
	return (
		metricScalesFromSnapshot(testRun.evaluationConfigSnapshot) ??
		(liveConfig ? metricScalesFromConfig(liveConfig.metrics) : null)
	);
}

/** The scales of the metrics of a config, or `null` without a config. */
export function resolveConfigMetricScales(
	metrics: EvaluationMetric[] | undefined,
): Record<string, MetricScale> | null {
	return metrics ? metricScalesFromConfig(metrics) : null;
}
