// Fork test (not in upstream n8n): a golden test of `resolveEvaluationConcurrencyLimit`. It records
// the limit for a matrix of the configured limit and the licence values. The snapshot was recorded
// against the enterprise file, and the fork file gives the same snapshot. See
// `packages/cli/src/evaluation/FORK.md`.
import type { ExecutionsConfig } from '@n8n/config';
import { mock } from 'vitest-mock-extended';

import {
	EVALUATION_TIER_DEFAULTS,
	getEvaluationConcurrencyLimitSource,
	resolveEvaluationConcurrencyLimit,
} from '@/evaluation/evaluation-concurrency.helper';
import type { License } from '@/license';

/** A licence that answers from a table of values, as the licence server does. */
function licenseWith(values: Record<string, unknown>) {
	const license = mock<License>();
	license.getValue.mockImplementation((feature: string) => values[feature] as never);
	license.isLicensed.mockImplementation((feature: string) => values[feature] === true);
	license.getPlanName.mockImplementation(() => (values.planName as string) ?? 'Community');
	return license;
}

test('the evaluation concurrency limit', () => {
	const configured = [-1, 0, 1, 4, 20];
	const licences: Array<[string, Record<string, unknown>]> = [
		['no licence values', {}],
		['quota 3', { 'quota:evaluations:concurrencyLimit': 3 }],
		['quota unlimited', { 'quota:evaluations:concurrencyLimit': -1 }],
		['quota 0', { 'quota:evaluations:concurrencyLimit': 0 }],
		['enterprise plan', { planName: 'Enterprise' }],
		['business plan', { planName: 'Business' }],
		['pro plan', { planName: 'Pro' }],
		['starter plan', { planName: 'Starter' }],
		['one workflow with evaluations', { 'quota:evaluations:maxWorkflows': 1 }],
		['unlimited workflows with evaluations', { 'quota:evaluations:maxWorkflows': -1 }],
	];
	const record: Record<string, unknown> = {};
	for (const evaluationLimit of configured) {
		for (const [name, values] of licences) {
			const config = mock<ExecutionsConfig>({
				concurrency: { productionLimit: -1, evaluationLimit },
			});
			const attempt = (call: () => unknown) => {
				try {
					return call();
				} catch (error) {
					return `${(error as Error).constructor.name}: ${(error as Error).message}`;
				}
			};
			record[`configured ${evaluationLimit}, ${name}`] = {
				limit: attempt(() => resolveEvaluationConcurrencyLimit(config, licenseWith(values))),
				source: attempt(() => getEvaluationConcurrencyLimitSource(config)),
			};
			// The same with the environment variable of the configured value set.
			for (const env of [String(evaluationLimit), '0', 'abc', '']) {
				process.env.N8N_CONCURRENCY_EVALUATION_LIMIT = env;
				record[`configured ${evaluationLimit}, env "${env}", ${name}`] = {
					limit: attempt(() => resolveEvaluationConcurrencyLimit(config, licenseWith(values))),
					source: attempt(() => getEvaluationConcurrencyLimitSource(config)),
				};
				delete process.env.N8N_CONCURRENCY_EVALUATION_LIMIT;
			}
		}
	}
	expect({ tierDefaults: EVALUATION_TIER_DEFAULTS, matrix: record }).toMatchSnapshot();
});
