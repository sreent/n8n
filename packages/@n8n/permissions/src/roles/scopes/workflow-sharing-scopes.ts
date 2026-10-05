import { SYSTEM_ROLE_SCOPES } from '../../permission-data.generated';
import type { Scope } from '../../types';

export const WORKFLOW_SHARING_OWNER_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['workflow:owner']];

export const WORKFLOW_SHARING_EDITOR_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['workflow:editor']];
