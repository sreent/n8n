import type {
	AiInsightsPayload,
	AiInsightsRegression,
	AiInsightsResponse,
	AiInsightsSuggestedNext,
	MetricScale,
} from '@n8n/api-types';
import { averageNormalizedScore, metricScalesFromConfig, normalizedScores } from '@n8n/api-types';
import type { TestRun, User } from '@n8n/db';
import { EvaluationCollectionRepository, EvaluationConfigRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, NotFoundError } from '@n8n/errors';

import { Telemetry } from '@/telemetry';

import { runMetricScales } from '../metric-scales';

/** The `modelUsed` of insights that the fork computes from the aggregates, without a model. */
export const DETERMINISTIC_MODEL_TAG = 'deterministic';

type RunScores = {
	label: string;
	average: number;
	scores: Record<string, number>;
};

const percent = (score: number) => Math.round(score * 100);
const points = (delta: number) => Math.abs(delta).toFixed(1);

/**
 * Fork code (not in upstream n8n): the insights of an evaluation collection: the winner, the
 * regressions of the other runs and a next experiment. The fork computes them from the
 * aggregated metrics of the runs, without a language model, so the status is always `fallback`.
 * See `../FORK.md`.
 */
@Service()
export class EvalInsightsService {
	constructor(
		private readonly evaluationCollectionRepository: EvaluationCollectionRepository,
		private readonly evaluationConfigRepository: EvaluationConfigRepository,
		private readonly telemetry: Telemetry,
	) {}

	async generateInsights(
		workflowId: string,
		collectionId: string,
		user: User,
	): Promise<AiInsightsResponse> {
		const startedAt = Date.now();
		const detail = await this.evaluationCollectionRepository.getDetailByIdAndWorkflowId(
			collectionId,
			workflowId,
		);
		if (!detail) throw new NotFoundError('Collection not found');

		const config = await this.evaluationConfigRepository.findByIdAndWorkflowId(
			detail.collection.evaluationConfigId,
			workflowId,
		);
		const collectionScales = config ? metricScalesFromConfig(config.metrics) : undefined;
		const runs = detail.runs.map((run, index) => this.summariseRun(run, index, collectionScales));
		const insights = this.buildDeterministicInsights(runs);

		this.telemetry.track('Eval collection insights generated', {
			user_id: user.id,
			workflow_id: workflowId,
			collection_id: collectionId,
			status: 'fallback',
			model_used: DETERMINISTIC_MODEL_TAG,
			regressions_found: insights.regressions.length,
			duration_ms: Date.now() - startedAt,
		});

		return {
			generatedAt: new Date().toISOString(),
			modelUsed: DETERMINISTIC_MODEL_TAG,
			status: 'fallback',
			insights,
		};
	}

	/** The scores of a run, labelled A, B, C… in the order of the collection. */
	summariseRun(
		run: TestRun,
		index: number,
		collectionScales?: Record<string, MetricScale>,
	): RunScores | null {
		const scales = runMetricScales(run) ?? collectionScales;
		const metrics = run.metrics
			? Object.fromEntries(
					Object.entries(run.metrics).map(([key, value]) => [
						key,
						typeof value === 'boolean' ? Number(value) : value,
					]),
				)
			: null;
		const average = averageNormalizedScore(metrics, scales);
		if (average === null) return null;
		return {
			label: String.fromCharCode(65 + index),
			average,
			scores: normalizedScores(metrics, scales),
		};
	}

	buildDeterministicInsights(summaries: Array<RunScores | null>): AiInsightsPayload {
		const runs = summaries.filter((run): run is RunScores => run !== null);
		const winner = this.pickWinner(runs);
		if (!winner) throw new BadRequestError('The collection has no runs with scores to compare');

		const regressions = runs
			.filter((run) => run !== winner)
			.flatMap((run) => this.collectRegressions(winner, run));
		return {
			winner: {
				versionLabel: winner.label,
				headline: `${winner.label} is the winner`,
				body: `${winner.label} leads on average score (${percent(winner.average)}%) across ${Object.keys(winner.scores).length} metric(s).`,
			},
			regressions,
			suggestedNext: this.composeSuggestedNext(winner, regressions),
		};
	}

	/** The run with the highest average score. On a tie, the first run. */
	pickWinner(runs: RunScores[]): RunScores | undefined {
		return runs.reduce<RunScores | undefined>(
			(best, run) => (!best || run.average > best.average ? run : best),
			undefined,
		);
	}

	/** Each metric on which the run scores lower than the winner. */
	collectRegressions(winner: RunScores, run: RunScores): AiInsightsRegression[] {
		return Object.entries(run.scores).flatMap(([metric, score]) => {
			const best = winner.scores[metric];
			if (best === undefined || score >= best) return [];
			const delta = Math.round((score - best) * 1000) / 10;
			return [
				{
					versionLabel: run.label,
					metric,
					delta,
					headline: `${run.label} regressed on ${metric}`,
					body: `${run.label} scored ${percent(score)}% on ${metric}, ${points(delta)} percentage points below ${winner.label}.`,
				},
			];
		});
	}

	/** The next experiment: isolate the largest regression, or try a new variant of the winner. */
	composeSuggestedNext(
		winner: RunScores,
		regressions: AiInsightsRegression[],
	): AiInsightsSuggestedNext {
		const largest = regressions.reduce<AiInsightsRegression | undefined>(
			(worst, regression) => (!worst || regression.delta < worst.delta ? regression : worst),
			undefined,
		);
		if (!largest) {
			return {
				headline: `Try a new variant of ${winner.label}`,
				body: `${winner.label} scores at least as high as every other version on every metric. Change one part of ${winner.label} at a time to look for more gains.`,
				hypothesis: `If a change to one part of ${winner.label} raises its average score, that part limits the current result.`,
			};
		}
		const { versionLabel, metric, delta } = largest;
		return {
			headline: `Investigate ${metric} regression on ${versionLabel}`,
			body: `${versionLabel} lost ${points(delta)} percentage points on ${metric} vs ${winner.label}. Try a variant that keeps ${winner.label}'s configuration for that metric and changes only the rest.`,
			hypothesis: `If isolating ${winner.label}'s ${metric} configuration into a new variant recovers the lost points, the rest of ${versionLabel}'s changes were the regression's cause.`,
		};
	}
}
