import type { CredentialResolverConfiguration } from '@n8n/decorators';
import { CredentialResolverValidationError } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { createEnvProvider, createEnvProviderState, Expression } from 'n8n-workflow';

/**
 * Evaluates the expressions (`={{ ... }}`) in the configuration of a resolver. The stored
 * configuration keeps the expressions; each use of a resolver evaluates them again. An expression
 * can use `$env` when the instance allows the access to environment variables.
 */
@Service()
export class ResolverConfigExpressionService {
	resolve(config: CredentialResolverConfiguration): CredentialResolverConfiguration {
		const resolved: CredentialResolverConfiguration = {};
		for (const [key, value] of Object.entries(config)) {
			resolved[key] = this.resolveValue(value);
		}
		return resolved;
	}

	private resolveValue(value: unknown): unknown {
		if (typeof value === 'string') {
			return value.startsWith('=') ? this.evaluate(value.slice(1)) : value;
		}
		if (Array.isArray(value)) return value.map((entry: unknown) => this.resolveValue(entry));
		if (value !== null && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, this.resolveValue(entry)]),
			);
		}
		return value;
	}

	private evaluate(expression: string): unknown {
		try {
			// The evaluator gives `undefined` for most errors. It throws for expression errors, for
			// example a blocked access to environment variables.
			return Expression.resolveWithoutWorkflow(expression, {
				$env: createEnvProvider(0, 0, createEnvProviderState()),
			});
		} catch (error) {
			throw new CredentialResolverValidationError(
				`Invalid expression in resolver config: ${ensureError(error).message}`,
			);
		}
	}
}
