// The scopes that custom roles can hold, and the options of the role editors in the editor app.
//
// Custom roles need a license. The fork keeps this data so that the editor app and the role
// service work as before, and builds its own custom roles on it later (see FORK-FEATURES.md).

import type { RESOURCES } from '../constants';
import { ALL_SCOPES } from '../scope-information';
import type { Resource, Scope } from '../types';

type OperationsByResource = { [R in Resource]?: ReadonlyArray<(typeof RESOURCES)[R][number]> };

/**
 * The checkboxes of the project role editor: for each resource, the operations in display order.
 * The editor adds the matching `list` scope when it adds a `read` scope.
 */
export const PROJECT_CUSTOM_ROLE_OPERATIONS = {
	project: ['read', 'update', 'delete'],
	folder: ['read', 'update', 'create', 'move', 'delete'],
	workflow: [
		'read',
		'execute',
		'update',
		'create',
		'publish',
		'move',
		'delete',
		'enableRedaction',
		'disableRedaction',
	],
	agent: ['read', 'execute', 'update', 'create', 'publish', 'unpublish', 'delete'],
	credential: ['read', 'update', 'create', 'share', 'unshare', 'move', 'delete', 'createEndUser'],
	execution: ['read', 'delete', 'reveal'],
	externalSecretsProvider: ['read', 'create', 'update', 'delete', 'sync'],
	externalSecret: ['list'],
	dataTable: ['read', 'readRow', 'update', 'writeRow', 'create', 'delete'],
	projectVariable: ['read', 'update', 'create', 'delete'],
	projectAiPreference: ['read', 'update', 'create', 'delete'],
	sourceControl: ['push'],
} as const satisfies OperationsByResource;

/** Scopes that come with another scope and have no checkbox: unpublish comes with publish. */
export const COUPLED_HIDDEN_SCOPES = ['workflow:unpublish'] as const satisfies readonly Scope[];

const allScopes: ReadonlySet<string> = new Set(ALL_SCOPES);

function projectCustomRoleScopes(): Set<string> {
	const scopes = new Set<string>(COUPLED_HIDDEN_SCOPES);
	for (const [resource, operations] of Object.entries(PROJECT_CUSTOM_ROLE_OPERATIONS)) {
		for (const operation of operations) scopes.add(`${resource}:${operation}`);
		// The list scopes that the editor adds with a read scope.
		if (operations.some((operation) => operation === 'read')) {
			scopes.add(resource === 'dataTable' ? 'dataTable:listProject' : `${resource}:list`);
		}
	}
	return new Set([...scopes].filter((scope) => allScopes.has(scope)));
}

/** All scopes that a custom project role can hold. */
export const PROJECT_CUSTOM_ROLE_SCOPES: ReadonlySet<string> = projectCustomRoleScopes();

/**
 * The options of the instance role editor. Each option of a resource grants a fixed list of
 * scopes. A scope belongs to one resource only. `settings` holds the instance-wide settings.
 *
 * The credential options never hold `credential:shareGlobally`, `credential:manageInstance`,
 * `credential:createEndUser` or `credential:connect`. These stay with the owner and admin roles,
 * or exist in projects only.
 */
export const GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS = {
	settings: {
		Manage: [
			'aiPreference:create',
			'aiPreference:read',
			'aiPreference:update',
			'aiPreference:delete',
			'aiPreference:list',
			'aiAssistant:manage',
			'auditLogs:manage',
			'banner:dismiss',
			'community:register',
			'communityPackage:install',
			'communityPackage:uninstall',
			'communityPackage:update',
			'communityPackage:list',
			'credentialTypePolicy:manage',
			'externalSecretsProvider:sync',
			'externalSecretsProvider:create',
			'externalSecretsProvider:read',
			'externalSecretsProvider:update',
			'externalSecretsProvider:delete',
			'externalSecretsProvider:list',
			'externalSecret:list',
			'eventBusDestination:create',
			'eventBusDestination:read',
			'eventBusDestination:update',
			'eventBusDestination:delete',
			'ldap:sync',
			'ldap:manage',
			'license:manage',
			'logStreaming:manage',
			'nodeTypePolicy:manage',
			'orchestration:read',
			'saml:manage',
			'securityAudit:generate',
			'securitySettings:manage',
			'sourceControl:pull',
			'sourceControl:push',
			'sourceControl:manage',
			'workersView:manage',
			'oidc:manage',
			'provisioning:manage',
			'mcp:manage',
			'mcp:oauth',
			'mcpApiKey:create',
			'mcpApiKey:rotate',
			'chatHub:manage',
			'breakingChanges:list',
			'breakingChanges:migrate',
			'encryptionKey:manage',
			'credentialResolver:create',
			'credentialResolver:read',
			'credentialResolver:update',
			'credentialResolver:delete',
			'instanceAi:message',
			'instanceAi:manage',
			'instanceAi:gateway',
			'instanceAi:eval',
			'roleMappingRule:create',
			'roleMappingRule:update',
			'roleMappingRule:delete',
			'roleMappingRule:list',
			'otel:manage',
		],
		'Mcp use': ['mcp:oauth', 'mcpApiKey:create', 'mcpApiKey:rotate'],
		'Mcp manage': ['mcp:manage', 'mcp:oauth', 'mcpApiKey:create', 'mcpApiKey:rotate'],
		'AiAssistant use': ['instanceAi:message', 'instanceAi:gateway'],
		'AiAssistant manage': [
			'aiAssistant:manage',
			'instanceAi:manage',
			'instanceAi:message',
			'instanceAi:gateway',
		],
	},
	user: {
		View: ['user:list'],
		Manage: [
			'user:list',
			'user:read',
			'user:create',
			'user:update',
			'user:delete',
			'user:changeRole',
			'user:resetPassword',
			'user:enforceMfa',
			'user:generateInviteLink',
		],
	},
	role: {
		'Manage project roles': ['role:read', 'role:manageProject'],
		Manage: ['role:read', 'role:manage'],
	},
	apiKey: {
		'Manage own': ['apiKey:create', 'apiKey:update'],
		'Manage all': ['apiKey:create', 'apiKey:update', 'apiKey:manage'],
	},
	tag: {
		View: ['tag:read', 'tag:list'],
		Manage: ['tag:read', 'tag:list', 'tag:create', 'tag:update', 'tag:delete'],
	},
	variable: {
		View: ['variable:list', 'variable:read'],
		Manage: [
			'variable:list',
			'variable:read',
			'variable:create',
			'variable:update',
			'variable:delete',
		],
	},
	credential: {
		View: ['credential:list', 'credential:read'],
		Use: ['credential:list', 'credential:read', 'credential:use'],
		Manage: [
			'credential:list',
			'credential:read',
			'credential:use',
			'credential:create',
			'credential:update',
			'credential:delete',
			'credential:move',
			'credential:share',
			'credential:unshare',
		],
	},
	project: {
		Create: ['project:create'],
	},
	insights: {
		View: ['insights:list', 'insights:read'],
	},
} as const satisfies Record<string, Record<string, readonly Scope[]>>;

type InstanceGroups = typeof GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS;

/**
 * Scopes that the built-in Member role holds and that no option shows. Every custom instance
 * role gets them, so they count toward no option.
 */
export const BASELINE_INSTANCE_SCOPES = [
	'chatHub:message',
	'credentialResolver:list',
	'dataTable:list',
	'eventBusDestination:list',
	'eventBusDestination:test',
] as const satisfies readonly Scope[];

/** The options that every custom instance role has. The editor shows them as locked. */
const MANDATORY_INSTANCE_OPTIONS = [
	['user', 'View'],
	['tag', 'View'],
] as const satisfies ReadonlyArray<
	{ [G in keyof InstanceGroups]: readonly [G, keyof InstanceGroups[G]] }[keyof InstanceGroups]
>;

/** The scopes of the mandatory options, then the baseline scopes. */
export const MANDATORY_INSTANCE_SCOPES: readonly Scope[] = [
	...MANDATORY_INSTANCE_OPTIONS.flatMap(([group, option]) => {
		const options: Record<string, readonly Scope[]> = GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS[group];
		return options[option];
	}),
	...BASELINE_INSTANCE_SCOPES,
];

export function isMandatoryInstanceOption(group: string, option: string): boolean {
	return MANDATORY_INSTANCE_OPTIONS.some(([g, o]) => g === group && o === option);
}

/** Add the mandatory scopes to the scopes of a custom instance role. The result has no duplicates. */
export function withMandatoryInstanceScopes(scopes: readonly string[]): string[] {
	return [...new Set([...scopes, ...MANDATORY_INSTANCE_SCOPES])];
}

/** All scopes that a custom instance role can hold. */
export const GLOBAL_CUSTOM_ROLE_SCOPES: ReadonlySet<string> = new Set<string>([
	...Object.values(GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS).flatMap((options) =>
		Object.values<readonly string[]>(options).flat(),
	),
	...BASELINE_INSTANCE_SCOPES,
]);

export const CUSTOM_ROLE_SCOPE_WHITELIST = {
	project: PROJECT_CUSTOM_ROLE_SCOPES,
	global: GLOBAL_CUSTOM_ROLE_SCOPES,
};
