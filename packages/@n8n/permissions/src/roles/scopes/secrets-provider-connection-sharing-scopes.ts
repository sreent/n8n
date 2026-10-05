import { SYSTEM_ROLE_SCOPES } from '../../permission-data.generated';
import type { Scope } from '../../types';

export const SECRETS_PROVIDER_CONNECTION_SHARING_OWNER_SCOPES: Scope[] = [
	...SYSTEM_ROLE_SCOPES['secretsProviderConnection:owner'],
];

export const SECRETS_PROVIDER_CONNECTION_SHARING_USER_SCOPES: Scope[] = [
	...SYSTEM_ROLE_SCOPES['secretsProviderConnection:user'],
];
