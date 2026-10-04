import type { AuthPrincipal, Scope, ScopeOptions } from '../types';
import { getGlobalScopes } from './get-global-scopes';
import { hasScope } from './has-scope';

/** Check the global scopes of a user. See `hasScope` for the modes. */
export function hasGlobalScope(
	principal: AuthPrincipal,
	scope: Scope | Scope[],
	options: ScopeOptions = { mode: 'oneOf' },
): boolean {
	return hasScope(scope, { global: getGlobalScopes(principal) }, undefined, options);
}
