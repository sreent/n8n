/** The metric values of one case: numbers and booleans. A boolean counts as 1 or 0. */
export type CaseMetrics = Record<string, number | boolean>;

/**
 * Fork code (not in upstream n8n): the average of each metric over the successful cases of a test
 * run. A metric keeps the place where a case first gave it. See `../FORK.md`.
 */
export class EvaluationMetrics {
	private readonly totals = new Map<string, { sum: number; count: number }>();

	/** Adds the values of one case. Gives the values that it added. */
	addResults(result: CaseMetrics): CaseMetrics {
		const added: CaseMetrics = {};
		for (const [name, value] of Object.entries(result)) {
			const numeric = typeof value === 'boolean' ? Number(value) : value;
			if (typeof numeric !== 'number' || !Number.isFinite(numeric)) continue;
			const total = this.totals.get(name) ?? { sum: 0, count: 0 };
			total.sum += numeric;
			total.count += 1;
			this.totals.set(name, total);
			added[name] = value;
		}
		return added;
	}

	/** The average of each metric. */
	getAggregatedMetrics(): Record<string, number> {
		const aggregated: Record<string, number> = {};
		for (const [name, { sum, count }] of this.totals) aggregated[name] = sum / count;
		return aggregated;
	}
}
