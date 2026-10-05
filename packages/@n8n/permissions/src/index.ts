export * from './types';
export * from './constants';
export type * from './principal';

export * from './roles/scopes/global-scopes';
export * from './scope-information';
export * from './roles/role-maps';
export * from './roles/all-roles';

export {
	systemProjectRoleSchema,
	assignableProjectRoleSchema,
	assignableGlobalRoleSchema,
	projectRoleSchema,
	teamRoleSchema,
	roleSchema,
	type Role,
	scopeSchema,
} from './schemas';

export { hasScope } from './utilities/has-scope';
export { hasGlobalScope } from './utilities/has-global-scope';
export { combineScopes } from './utilities/combine-scopes';
export * from './roles/custom-role-scopes';
export { staticRolesWithScope } from './utilities/static-roles-with-scope';
export { getGlobalScopes } from './utilities/get-global-scopes';
export { getRoleScopes, getAuthPrincipalScopes } from './utilities/get-role-scopes';
export { getResourcePermissions } from './utilities/get-resource-permissions';
export type { PermissionsRecord } from './utilities/get-resource-permissions';
export * from './public-api-permissions';
