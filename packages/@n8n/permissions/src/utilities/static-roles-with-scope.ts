import {
	CREDENTIALS_SHARING_SCOPE_MAP,
	GLOBAL_SCOPE_MAP,
	PROJECT_SCOPE_MAP,
	SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
	WORKFLOW_SHARING_SCOPE_MAP,
} from '../roles/role-maps';
import type { RoleNamespace, Scope } from '../types';

const ROLE_MAPS: Record<RoleNamespace, Record<string, Scope[]>> = {
	global: GLOBAL_SCOPE_MAP,
	project: PROJECT_SCOPE_MAP,
	credential: CREDENTIALS_SHARING_SCOPE_MAP,
	workflow: WORKFLOW_SHARING_SCOPE_MAP,
	secretsProviderConnection: SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
};

/**
 * The system roles of a namespace that hold all the given scopes, in the order of the role map.
 * The role cache uses this when it cannot read the roles from the database.
 */
export function staticRolesWithScope(namespace: RoleNamespace, scopes: Scope | Scope[]): string[] {
	const wanted = Array.isArray(scopes) ? scopes : [scopes];
	return Object.entries(ROLE_MAPS[namespace])
		.filter(([, roleScopes]) => wanted.every((scope) => roleScopes.includes(scope)))
		.map(([role]) => role);
}
