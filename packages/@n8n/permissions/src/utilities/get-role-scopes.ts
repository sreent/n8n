import {
	CREDENTIALS_SHARING_SCOPE_MAP,
	GLOBAL_SCOPE_MAP,
	PROJECT_SCOPE_MAP,
	SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
	WORKFLOW_SHARING_SCOPE_MAP,
} from '../roles/role-maps';
import type { AllRoleTypes, AuthPrincipal, Resource, Scope } from '../types';

/** The scopes of every system role. */
export const COMBINED_ROLE_MAP: Record<AllRoleTypes, Scope[]> = {
	...GLOBAL_SCOPE_MAP,
	...PROJECT_SCOPE_MAP,
	...CREDENTIALS_SHARING_SCOPE_MAP,
	...WORKFLOW_SHARING_SCOPE_MAP,
	...SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
};

function filterByResource(scopes: Scope[], filters?: Resource[]): Scope[] {
	if (!filters) return scopes;
	return scopes.filter((scope) => filters.some((resource) => scope.startsWith(`${resource}:`)));
}

/** The scopes of a system role. With `filters`, only the scopes of these resources. */
export function getRoleScopes(role: AllRoleTypes, filters?: Resource[]): Scope[] {
	return filterByResource(COMBINED_ROLE_MAP[role], filters);
}

/**
 * The scopes of the role of a user, as the database holds them. With `filters`, only the scopes
 * of these resources.
 */
export function getAuthPrincipalScopes(principal: AuthPrincipal, filters?: Resource[]): Scope[] {
	return filterByResource(
		principal.role.scopes.map((scope) => scope.slug),
		filters,
	);
}
