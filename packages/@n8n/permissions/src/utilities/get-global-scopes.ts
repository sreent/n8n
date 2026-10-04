import type { AuthPrincipal, Scope } from '../types';

/** The global scopes of a user: the scopes of its global role. */
export function getGlobalScopes(principal: AuthPrincipal): Scope[] {
	return principal.role.scopes.map((scope) => scope.slug);
}
