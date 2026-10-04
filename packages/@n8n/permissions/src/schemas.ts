import { z } from 'zod';

import {
	GLOBAL_ADMIN_ROLE_SLUG,
	GLOBAL_CHAT_USER_ROLE_SLUG,
	GLOBAL_MEMBER_ROLE_SLUG,
	GLOBAL_OWNER_ROLE_SLUG,
	PROJECT_ADMIN_ROLE_SLUG,
	PROJECT_CHAT_USER_ROLE_SLUG,
	PROJECT_EDITOR_ROLE_SLUG,
	PROJECT_OWNER_ROLE_SLUG,
	PROJECT_VIEWER_ROLE_SLUG,
} from './constants';
import { ALL_SCOPES } from './scope-information';
import type { Scope } from './types';

export const roleNamespaceSchema = z.enum([
	'global',
	'project',
	'credential',
	'workflow',
	'secretsProviderConnection',
]);

export const globalRoleSchema = z.enum([
	GLOBAL_OWNER_ROLE_SLUG,
	GLOBAL_ADMIN_ROLE_SLUG,
	GLOBAL_MEMBER_ROLE_SLUG,
	GLOBAL_CHAT_USER_ROLE_SLUG,
]);

/** Any global role that a user can get: a system role other than the owner, or a custom role. */
export const assignableGlobalRoleSchema = z
	.string()
	.min(1)
	.refine((role) => role !== GLOBAL_OWNER_ROLE_SLUG, {
		message: 'This global role value is not assignable',
	});

export const systemProjectRoleSchema = z.enum([
	PROJECT_OWNER_ROLE_SLUG,
	PROJECT_ADMIN_ROLE_SLUG,
	PROJECT_EDITOR_ROLE_SLUG,
	PROJECT_VIEWER_ROLE_SLUG,
	PROJECT_CHAT_USER_ROLE_SLUG,
]);

/** A project role that is not a system role. */
export const customProjectRoleSchema = z
	.string()
	.min(1)
	.refine((role) => !systemProjectRoleSchema.safeParse(role).success, {
		message: 'This is a system project role',
	});

export const projectRoleSchema = z.union([systemProjectRoleSchema, customProjectRoleSchema]);

/** A role in a team project: a system role other than the personal owner, or a custom role. */
export const teamRoleSchema = z.union([
	z.enum([
		PROJECT_ADMIN_ROLE_SLUG,
		PROJECT_EDITOR_ROLE_SLUG,
		PROJECT_VIEWER_ROLE_SLUG,
		PROJECT_CHAT_USER_ROLE_SLUG,
	]),
	customProjectRoleSchema,
]);

/** Any project role that a user can get. The personal owner role comes only with the user. */
export const assignableProjectRoleSchema = z
	.string()
	.min(1)
	.refine((role) => role !== PROJECT_OWNER_ROLE_SLUG, {
		message: 'This project role value is not assignable',
	});

export const credentialSharingRoleSchema = z.enum(['credential:owner', 'credential:user']);

export const workflowSharingRoleSchema = z.enum(['workflow:owner', 'workflow:editor']);

export const secretsProviderConnectionSharingRoleSchema = z.enum([
	'secretsProviderConnection:owner',
	'secretsProviderConnection:user',
]);

const allScopes: ReadonlySet<string> = new Set(ALL_SCOPES);

export const scopeSchema = z.custom<Scope>(
	(value) => typeof value === 'string' && allScopes.has(value),
	{ message: 'Invalid scope' },
);

export const roleSchema = z.object({
	slug: z.string().min(1),
	displayName: z.string().min(1),
	description: z.string().nullable(),
	systemRole: z.boolean(),
	roleType: roleNamespaceSchema,
	licensed: z.boolean(),
	// The scopes as the database holds them. A custom role can hold scopes that are gone.
	scopes: z.array(z.string()),
	createdAt: z.date().optional(),
	updatedAt: z.date().optional(),
	usedByUsers: z.number().optional(),
	usedByProjects: z.number().optional(),
});

export type Role = z.infer<typeof roleSchema>;
