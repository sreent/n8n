import type { z } from 'zod';

import { FORK_API_KEY_SCOPES, type ForkApiKeyResource, type ForkApiKeyScope } from './fork-scopes';
import type { API_KEY_RESOURCES, RESOURCES } from './permission-data.generated';
import {
	assignableProjectRoleSchema,
	type assignableGlobalRoleSchema,
	type credentialSharingRoleSchema,
	type globalRoleSchema,
	type Role,
	type roleNamespaceSchema,
	type secretsProviderConnectionSharingRoleSchema,
	type systemProjectRoleSchema,
	type teamRoleSchema,
	type workflowSharingRoleSchema,
} from './schemas';
import { ALL_API_KEY_SCOPES } from './scope-information';

export type Resource = keyof typeof RESOURCES;

export type ResourceScope<
	R extends Resource,
	Operation extends string = (typeof RESOURCES)[R][number],
> = `${R}:${Operation}`;

/** Every scope as `resource:operation`. An operation is valid only for its own resource. */
export type Scope = { [R in Resource]: ResourceScope<R> }[Resource];

/** The resources of API key scopes: the generated ones and the ones of fork features. */
export type ApiKeyResource = keyof typeof API_KEY_RESOURCES | ForkApiKeyResource;

/**
 * The scopes that an API key can hold. Some of them exist only for API keys. The fork adds the
 * scopes of `fork-scopes.ts`.
 */
export type ApiKeyScope =
	| {
			[R in keyof typeof API_KEY_RESOURCES]: `${R}:${(typeof API_KEY_RESOURCES)[R][number]}`;
	  }[keyof typeof API_KEY_RESOURCES]
	| ForkApiKeyScope;

export type ScopeInformation = {
	displayName: string;
	description?: string | null;
};

/** The scopes that a user has at each level. */
export type ScopeLevels = {
	global: Scope[];
	project?: Scope[];
	resource?: Scope[];
};

/** Masks limit the project and resource scopes. They never limit the global scopes. */
export type MaskLevels = {
	sharing: Scope[];
};

export type ScopeMode = 'oneOf' | 'allOf';

export type ScopeOptions = { mode: ScopeMode };

export type RoleNamespace = z.infer<typeof roleNamespaceSchema>;
export type GlobalRole = z.infer<typeof globalRoleSchema>;
export type AssignableGlobalRole = z.infer<typeof assignableGlobalRoleSchema>;
export type CredentialSharingRole = z.infer<typeof credentialSharingRoleSchema>;
export type WorkflowSharingRole = z.infer<typeof workflowSharingRoleSchema>;
export type SecretsProviderConnectionSharingRole = z.infer<
	typeof secretsProviderConnectionSharingRoleSchema
>;
/** A system project role. */
export type ProjectRole = z.infer<typeof systemProjectRoleSchema>;
export type TeamProjectRole = z.infer<typeof teamRoleSchema>;
export type AssignableProjectRole = z.infer<typeof assignableProjectRoleSchema>;

/** The slugs of all system roles. */
export type AllRoleTypes =
	| GlobalRole
	| ProjectRole
	| WorkflowSharingRole
	| CredentialSharingRole
	| SecretsProviderConnectionSharingRole;

/** The roles of each namespace, as the roles endpoint returns them. */
export type AllRolesMap = { [N in RoleNamespace]: Role[] };

/** The role of a user, as the permission checks need it. A `User` entity fits this type. */
export type AuthPrincipal = {
	role: {
		slug: string;
		scopes: Array<{ slug: Scope }>;
	};
};

export function isApiKeyScope(scope: string): scope is ApiKeyScope {
	return (ALL_API_KEY_SCOPES as ReadonlySet<string>).has(scope) || FORK_API_KEY_SCOPES.has(scope);
}

/** Check if a user can get this project role. */
export function isAssignableProjectRoleSlug(slug: string): slug is AssignableProjectRole {
	return assignableProjectRoleSchema.safeParse(slug).success;
}
