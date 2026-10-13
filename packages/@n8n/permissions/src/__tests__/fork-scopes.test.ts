// Fork test (not in upstream n8n): the API key scopes that fork features add (../fork-scopes.ts).
import { FORK_API_KEY_RESOURCES, FORK_API_KEY_SCOPES } from '@/fork-scopes';
import {
	getApiKeyScopesForRole,
	getOwnerOnlyApiKeyScopes,
	MEMBER_API_KEY_SCOPES,
	OWNER_API_KEY_SCOPES,
} from '@/public-api-permissions';
import {
	GLOBAL_ADMIN_SCOPES,
	GLOBAL_CHAT_USER_SCOPES,
	GLOBAL_MEMBER_SCOPES,
	GLOBAL_OWNER_SCOPES,
} from '@/roles/scopes/global-scopes';
import { ALL_API_KEY_SCOPES, ALL_SCOPES } from '@/scope-information';
import type { ApiKeyScope, Scope } from '@/types';
import { isApiKeyScope } from '@/types';

const principal = (slug: string, scopes: Scope[]) => ({
	role: { slug, scopes: scopes.map((scope) => ({ slug: scope })) },
});

describe('fork API key scopes', () => {
	test('the fork adds the audit log scope', () => {
		expect([...FORK_API_KEY_SCOPES]).toEqual(['auditLogs:manage']);
		expect(FORK_API_KEY_RESOURCES).toEqual({ auditLogs: ['manage'] });
	});

	test('each fork scope is a scope that a role can hold', () => {
		for (const scope of FORK_API_KEY_SCOPES) {
			expect(ALL_SCOPES).toContain(scope);
		}
	});

	// When upstream makes a fork scope an API key scope, remove it from the fork list.
	test('no fork scope is in the generated API key scopes', () => {
		for (const scope of FORK_API_KEY_SCOPES) {
			expect(ALL_API_KEY_SCOPES.has(scope as ApiKeyScope)).toBe(false);
		}
	});

	test('a fork scope is an API key scope', () => {
		expect(isApiKeyScope('auditLogs:manage')).toBe(true);
		expect(isApiKeyScope('auditLogs:read')).toBe(false);
		expect(isApiKeyScope('workflow:read')).toBe(true);
	});

	test('the owner and the admins can give it to an API key', () => {
		expect(getApiKeyScopesForRole(principal('global:owner', GLOBAL_OWNER_SCOPES))).toContain(
			'auditLogs:manage',
		);
		expect(getApiKeyScopesForRole(principal('global:admin', GLOBAL_ADMIN_SCOPES))).toContain(
			'auditLogs:manage',
		);
		expect(OWNER_API_KEY_SCOPES).toContain('auditLogs:manage');
	});

	test('a member and a chat user cannot', () => {
		expect(getApiKeyScopesForRole(principal('global:member', GLOBAL_MEMBER_SCOPES))).not.toContain(
			'auditLogs:manage',
		);
		expect(MEMBER_API_KEY_SCOPES).not.toContain('auditLogs:manage');
		expect(getApiKeyScopesForRole(principal('global:chatUser', GLOBAL_CHAT_USER_SCOPES))).toEqual(
			[],
		);
	});

	test('a custom role with the scope can give it to an API key', () => {
		expect(
			getApiKeyScopesForRole(principal('global:auditor-abc123', ['auditLogs:manage'])),
		).toContain('auditLogs:manage');
	});

	test('an owner or admin who becomes a member loses it from their API keys', () => {
		expect(getOwnerOnlyApiKeyScopes()).toContain('auditLogs:manage');
	});
});
