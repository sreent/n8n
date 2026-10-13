import type { ExecutionsConfig } from '@n8n/config';
import { LICENSE_QUOTAS } from '@n8n/constants';

import type { License } from '@/license';

/**
 * The number of test cases that run at the same time, by licence plan, when the licence gives no
 * concurrency quota. A plan that is not in the list gets the value of `Community`.
 */
export const EVALUATION_TIER_DEFAULTS: Record<string, number> = {
	Community: 1,
	Pro: 1,
	Business: 3,
	Enterprise: 5,
};

/** Where the limit comes from: the environment variable or the licence. */
export type EvaluationConcurrencyLimitSource = 'env' | 'tier';

const LIMIT_ENV_VAR = 'N8N_CONCURRENCY_EVALUATION_LIMIT';

/**
 * Fork code (not in upstream n8n). `env` when the environment sets
 * `N8N_CONCURRENCY_EVALUATION_LIMIT`, also to an empty or invalid value. See `FORK.md` in this
 * folder.
 */
export function getEvaluationConcurrencyLimitSource(
	_config: ExecutionsConfig,
): EvaluationConcurrencyLimitSource {
	return process.env[LIMIT_ENV_VAR] !== undefined ? 'env' : 'tier';
}

/**
 * Fork code (not in upstream n8n): the evaluation concurrency limit, `-1` for no limit. The
 * environment variable wins (its parsed config value). Then the concurrency quota of the licence,
 * when it is a positive number or `-1`. Then the default of the licence plan.
 */
export function resolveEvaluationConcurrencyLimit(
	config: ExecutionsConfig,
	license: License,
): number {
	if (getEvaluationConcurrencyLimitSource(config) === 'env') {
		return config.concurrency.evaluationLimit;
	}

	const quota = license.getValue(LICENSE_QUOTAS.EVALUATION_CONCURRENCY_LIMIT);
	if (typeof quota === 'number' && (quota > 0 || quota === -1)) return quota;

	return EVALUATION_TIER_DEFAULTS[license.getPlanName()] ?? EVALUATION_TIER_DEFAULTS.Community;
}
