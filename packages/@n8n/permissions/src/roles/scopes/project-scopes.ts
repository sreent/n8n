import { SYSTEM_ROLE_SCOPES } from '../../permission-data.generated';
import type { Scope } from '../../types';

/**
 * The base scopes of the personal owner role. `AuthRolesService` adds the scopes of the personal
 * space settings while those settings are on.
 */
export const PERSONAL_PROJECT_OWNER_SCOPES: Scope[] = [
	...SYSTEM_ROLE_SCOPES['project:personalOwner'],
];

export const REGULAR_PROJECT_ADMIN_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['project:admin']];

export const PROJECT_EDITOR_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['project:editor']];

export const PROJECT_VIEWER_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['project:viewer']];

export const PROJECT_CHAT_USER_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['project:chatUser']];
