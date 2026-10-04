import {
	EXTERNAL_SECRETS_ROLE_SCOPES,
	PERSONAL_SPACE_PUBLISHING_SCOPES,
	PERSONAL_SPACE_SHARING_SCOPES,
} from './permission-data.generated';
import type { Scope } from './types';

export { API_KEY_RESOURCES, RESOURCES } from './permission-data.generated';

export const GLOBAL_OWNER_ROLE_SLUG = 'global:owner';
export const GLOBAL_ADMIN_ROLE_SLUG = 'global:admin';
export const GLOBAL_MEMBER_ROLE_SLUG = 'global:member';
export const GLOBAL_CHAT_USER_ROLE_SLUG = 'global:chatUser';

export const PROJECT_OWNER_ROLE_SLUG = 'project:personalOwner';
export const PROJECT_ADMIN_ROLE_SLUG = 'project:admin';
export const PROJECT_EDITOR_ROLE_SLUG = 'project:editor';
export const PROJECT_VIEWER_ROLE_SLUG = 'project:viewer';
export const PROJECT_CHAT_USER_ROLE_SLUG = 'project:chatUser';

/**
 * Settings that change the scopes of system roles. The settings table holds them under `key`.
 * `AuthRolesService` adds the scopes to the role when the setting is on.
 */
export const PERSONAL_SPACE_PUBLISHING_SETTING: { key: string; scopes: Scope[] } = {
	key: 'security.personalSpacePublishing',
	scopes: [...PERSONAL_SPACE_PUBLISHING_SCOPES],
};

export const PERSONAL_SPACE_SHARING_SETTING: { key: string; scopes: Scope[] } = {
	key: 'security.personalSpaceSharing',
	scopes: [...PERSONAL_SPACE_SHARING_SCOPES],
};

export const EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING: {
	key: string;
	roleScopeMap: Record<string, Scope[]>;
} = {
	key: 'externalSecrets.systemRolesEnabled',
	roleScopeMap: {
		[PROJECT_ADMIN_ROLE_SLUG]: [...EXTERNAL_SECRETS_ROLE_SCOPES[PROJECT_ADMIN_ROLE_SLUG]],
		[PROJECT_EDITOR_ROLE_SLUG]: [...EXTERNAL_SECRETS_ROLE_SCOPES[PROJECT_EDITOR_ROLE_SLUG]],
	},
};
