// Fork test (not in upstream n8n): the data of the golden tests of the editor of Git connections
// (promotions). See `../../FORK.md`.
import { GLOBAL_SCOPE_MAP, PROJECT_SCOPE_MAP } from '@n8n/permissions';
// #region Fixtures

export const SETTINGS = {
	activeModules: ['promotions'],
	envFeatureFlags: { N8N_ENV_FEAT_PROMOTIONS: 'true' },
	enterprise: { variables: true, projects: { team: { limit: -1 } } },
};

export const DATE = '2026-01-02T03:04:05.000Z';
export const SHA_PROMOTE = 'a'.repeat(40);
export const SHA_APPLY = 'b'.repeat(40);

export const GIT_SCOPES = GLOBAL_SCOPE_MAP['global:owner'].filter((scope) =>
	scope.startsWith('gitConnection'),
);

/** Scopes in a stable order: the permission data of upstream n8n and of the fork order them differently. */
export const sorted = <T extends string>(scopes: readonly T[]): T[] => [...new Set(scopes)].sort();

export const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
	id,
	name,
	type: 'team',
	icon: null,
	description: null,
	relations: [
		{
			id: 'u-1',
			email: 'user@example.com',
			firstName: 'Test',
			lastName: 'User',
			role: 'project:admin',
		},
	],
	scopes: sorted([...PROJECT_SCOPE_MAP['project:admin'], ...GIT_SCOPES]),
	createdAt: DATE,
	updatedAt: DATE,
	...extra,
});

export const TEAM = project('p1', 'Team');

export const PROVIDER_SUMMARY = {
	id: 'prov1',
	name: 'GitHub bot',
	type: 'git',
	authType: 'token',
	createdAt: DATE,
	updatedAt: DATE,
};

export const config = (
	direction: 'apply' | 'promote',
	checkout = { hasCheckout: true, matchesConfig: true },
) => ({
	id: direction === 'apply' ? 'cfgA' : 'cfgP',
	name: direction === 'apply' ? 'Apply' : 'Promote',
	createdAt: DATE,
	updatedAt: DATE,
	checkout,
	settings:
		direction === 'apply'
			? { schemaVersion: 1, branchName: 'main' }
			: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion: false },
});

export const connection = (configs: Record<string, unknown>) => ({
	id: 'conn1',
	name: 'Deployments',
	scope: 'instance',
	target: { schemaVersion: 1, remoteUrl: 'https://github.com/acme/flows.git' },
	provider: PROVIDER_SUMMARY,
	configs,
	createdAt: DATE,
	updatedAt: DATE,
});

export const CONNECTION = connection({ apply: config('apply'), promote: config('promote') });

export const change = (
	id: string,
	name: string,
	status: string,
	extra: Record<string, unknown> = {},
) => ({
	id,
	name,
	type: 'workflow',
	status,
	version: 3,
	updatedAt: DATE,
	updatedBy: null,
	dependencyCount: 0,
	...extra,
});

export const PROMOTE_CHANGES = [
	change('w1', 'Flow 1', 'new', { version: 1 }),
	change('w2', 'Flow 2', 'modified', { dependencyCount: 2 }),
	change('w3', 'Flow 3', 'renamed', { dependencyCount: 1 }),
	change('w4', 'Flow 4', 'renamed-and-modified', { updatedBy: { id: 'u2', name: 'Ada Lovelace' } }),
	change('w5', 'Flow 5', 'archived'),
	change('w6', 'Flow 6', 'deleted', { version: null, updatedAt: null }),
];

export const APPLY_CHANGES = [
	change('w7', 'Flow 7', 'new', { version: null, updatedAt: null, dependencyCount: 3 }),
	change('w8', 'Flow 8', 'modified'),
];

export const APPLY_SOURCE = { connectionId: 'conn1', configId: 'cfgA', branchName: 'main' };

export const applyBase = {
	connectionId: 'conn1',
	configId: 'cfgA',
	git: { commitSha: SHA_APPLY, branchName: 'main' },
};

export const applyCounts = (extra: Record<string, unknown> = {}) => ({
	projects: { created: 0, updated: 1, skipped: 0, deleted: 0 },
	folders: { created: 0, skipped: 0, removed: 0 },
	workflows: {
		created: 1,
		updated: 2,
		skipped: 0,
		archived: 1,
		deleted: 1,
		publishing: { published: 0, unpublished: 0, unchanged: 4, blocked: 0, failed: 0 },
	},
	credentials: { matched: 1, stubbed: 0 },
	dataTables: { matched: 0, created: 0 },
	variables: { matched: 1, created: 0, updated: 0, stubbed: 0, missing: 0 },
	tags: { matched: 0, created: 0, renamed: 0, reconciled: 0, skipped: 0 },
	...extra,
});

export const APPLIED = { ...applyBase, status: 'applied', counts: applyCounts(), warnings: [] };

export const APPLIED_NOT_PUBLISHED = {
	...APPLIED,
	counts: applyCounts({
		workflows: {
			created: 0,
			updated: 3,
			skipped: 0,
			archived: 0,
			deleted: 0,
			publishing: { published: 1, unpublished: 0, unchanged: 0, blocked: 1, failed: 1 },
		},
	}),
};

export const APPLIED_PROJECT_REMOVED = {
	...APPLIED,
	counts: applyCounts({ projects: { created: 0, updated: 1, skipped: 0, deleted: 1 } }),
};

export const SOURCE_CHANGED = { ...applyBase, status: 'source-changed' };

export const consumers = [
	{ project: { id: 'p1', name: 'Team' }, workflows: [{ id: 'w7', name: 'Flow 7' }] },
];

export const PREFLIGHT = {
	missingProjects: [],
	missingBindings: [
		{
			kind: 'credential',
			sourceId: 'cred1',
			name: 'Slack account',
			credentialType: 'slackApi',
			consumers,
			ownerProject: { id: 'p1', name: 'Team' },
		},
		{
			kind: 'variable',
			name: 'API_URL',
			variableType: 'string',
			scope: { kind: 'global' },
			sourceValue: 'https://api.example.com',
			consumers,
		},
		{
			kind: 'variable',
			name: 'TEAM_KEY',
			variableType: 'string',
			scope: { kind: 'project', project: { id: 'p1', name: 'Team' } },
			consumers,
		},
	],
	accessRequirements: [],
	conflicts: [],
	warnings: [],
};

export const PREFLIGHT_HARD = {
	missingProjects: [],
	missingBindings: [],
	accessRequirements: [
		{
			kind: 'credential',
			sourceId: 'cred2',
			name: 'Shared account',
			credentialType: 'httpHeaderAuth',
			consumers,
			code: 'access-required',
		},
	],
	conflicts: [
		{
			kind: 'credential',
			sourceId: null,
			name: 'No id',
			expectedTypes: ['httpBasicAuth'],
			referenceFiles: ['projects/team-p1/workflows/flow-7-w7/workflow.json'],
			consumers,
			code: 'missing-id',
		},
		{
			kind: 'variable',
			code: 'missing-definition',
			name: 'UNKNOWN',
			referenceFiles: ['projects/team-p1/workflows/flow-7-w7/workflow.json'],
			consumers,
		},
	],
	warnings: [
		{
			kind: 'variable',
			code: 'variable-shadowed',
			name: 'API_URL',
			scope: { kind: 'global' },
			consumers,
		},
	],
};

export const BLOCKED = { ...applyBase, status: 'blocked', preflight: PREFLIGHT };
export const BLOCKED_HARD = { ...applyBase, status: 'blocked', preflight: PREFLIGHT_HARD };

// #endregion
