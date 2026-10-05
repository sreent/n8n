import type { MaskLevels, Scope, ScopeLevels, ScopeOptions } from '../types';
import { combineScopes } from './combine-scopes';

/**
 * Check if the combined scopes of all levels hold `scope`. For a list of scopes, the `oneOf` mode
 * (the default) needs one of them, and the `allOf` mode needs all of them. An empty list fails.
 */
export function hasScope(
	scope: Scope | Scope[],
	userScopes: ScopeLevels,
	masks?: MaskLevels,
	options: ScopeOptions = { mode: 'oneOf' },
): boolean {
	const scopes = Array.isArray(scope) ? scope : [scope];
	if (scopes.length === 0) return false;

	const held = combineScopes(userScopes, masks);
	return options.mode === 'allOf'
		? scopes.every((s) => held.has(s))
		: scopes.some((s) => held.has(s));
}
