import { GLOBAL_SCOPE_MAP } from '@/roles/role-maps';
import { globalRoleSchema } from '@/schemas';
import type { AuthPrincipal, GlobalRole, Scope } from '@/types';

function createBuildInAuthPrincipal(role: GlobalRole): AuthPrincipal {
	return {
		role: {
			slug: role,
			scopes:
				GLOBAL_SCOPE_MAP[role].map((scope) => {
					return {
						slug: scope,
					};
				}) || [],
		},
	};
}

export function createAuthPrincipal(role: string, scopes: Scope[] = []): AuthPrincipal {
	try {
		const isGlobalRole = globalRoleSchema.parse(role);
		if (isGlobalRole) {
			return createBuildInAuthPrincipal(isGlobalRole);
		}
	} catch (error) {
		// If the role is not a valid global role, we proceed
		// to create a custom role with the provided scopes.
	}
	return {
		role: {
			slug: role,
			scopes:
				scopes.map((scope) => {
					return {
						slug: scope,
					};
				}) || [],
		},
	};
}
