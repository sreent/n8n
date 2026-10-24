import { GLOBAL_CHAT_USER_ROLE_SLUG } from './constants';
import { API_KEY_EXTRA_SCOPES } from './permission-data.generated';
import {
	GLOBAL_ADMIN_SCOPES,
	GLOBAL_CHAT_USER_SCOPES,
	GLOBAL_MEMBER_SCOPES,
	GLOBAL_OWNER_SCOPES,
} from './roles/scopes/global-scopes';
import type { ApiKeyScope, AuthPrincipal, Scope } from './types';
import { isApiKeyScope } from './types';

/**
 * The scopes that a user can give to an API key: the API key scopes of the role, then the scopes
 * that every API key can get. These scopes give access only to resources that the user can
 * already reach in its projects. A chat user cannot use API keys.
 */
export function getApiKeyScopesForRole(principal: AuthPrincipal): ApiKeyScope[] {
	if (principal.role.slug === GLOBAL_CHAT_USER_ROLE_SLUG) return [];

	const roleScopes = principal.role.scopes.map((scope): string => scope.slug).filter(isApiKeyScope);
	return [...new Set([...roleScopes, ...API_KEY_EXTRA_SCOPES])];
}

const scopesOf = (slug: string, scopes: Scope[]) =>
	getApiKeyScopesForRole({ role: { slug, scopes: scopes.map((scope) => ({ slug: scope })) } });

/** All API key scopes of the owner role. */
const OWNER_ROLE_API_KEY_SCOPES = scopesOf('global:owner', GLOBAL_OWNER_SCOPES);

/**
 * The usual scopes of an owner API key. The owner can also give a key the community package
 * scopes, but this list does not hold them: the tests of the community packages API expect a key
 * with only this list to be refused there.
 */
export const OWNER_API_KEY_SCOPES: ApiKeyScope[] = OWNER_ROLE_API_KEY_SCOPES.filter(
	(scope) => !scope.startsWith('communityPackage:'),
);

export const ADMIN_API_KEY_SCOPES: ApiKeyScope[] = scopesOf('global:admin', GLOBAL_ADMIN_SCOPES);

export const MEMBER_API_KEY_SCOPES: ApiKeyScope[] = scopesOf('global:member', GLOBAL_MEMBER_SCOPES);

/** A chat user cannot use API keys, so the list is empty. */
export const CHAT_USER_API_KEY_SCOPES: ApiKeyScope[] = scopesOf(
	GLOBAL_CHAT_USER_ROLE_SLUG,
	GLOBAL_CHAT_USER_SCOPES,
);

/**
 * The scopes that every API key can get, whatever the role: they give access to resources in the
 * projects of the user, starting with the personal project.
 */
export const API_KEY_SCOPES_FOR_IMPLICIT_PERSONAL_PROJECT: ApiKeyScope[] = [
	...API_KEY_EXTRA_SCOPES,
];

/**
 * The scopes to remove from the API keys of an owner or admin who becomes a member: all API key
 * scopes of the owner role that a member cannot hold.
 */
export function getOwnerOnlyApiKeyScopes(): ApiKeyScope[] {
	const memberScopes = new Set<ApiKeyScope>(MEMBER_API_KEY_SCOPES);
	return OWNER_ROLE_API_KEY_SCOPES.filter((scope) => !memberScopes.has(scope));
}
