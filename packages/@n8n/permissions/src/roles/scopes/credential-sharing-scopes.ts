import { SYSTEM_ROLE_SCOPES } from '../../permission-data.generated';
import type { Scope } from '../../types';

export const CREDENTIALS_SHARING_OWNER_SCOPES: Scope[] = [
	...SYSTEM_ROLE_SCOPES['credential:owner'],
];

export const CREDENTIALS_SHARING_USER_SCOPES: Scope[] = [...SYSTEM_ROLE_SCOPES['credential:user']];
