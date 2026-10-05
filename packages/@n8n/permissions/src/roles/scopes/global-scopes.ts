import { SYSTEM_ROLE_SCOPES } from '../../permission-data.generated';
import type { Scope } from '../../types';

export const GLOBAL_OWNER_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['global:owner']];

export const GLOBAL_ADMIN_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['global:admin']];

export const GLOBAL_MEMBER_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['global:member']];

export const GLOBAL_CHAT_USER_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['global:chatUser']];
