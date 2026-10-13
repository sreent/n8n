// Fork code (not in upstream n8n): the scopes that fork features add next to the generated data of
// `permission-data.generated.ts`. See "Fork scopes" in ../FORK.md.

/**
 * The API key scopes that fork features add, as resources and their operations. A user can give
 * an API key such a scope only when the role of the user holds the scope too.
 *
 * - `auditLogs:manage`: the audit log of the public API (`/api/v1/audit-log`). The owner and the
 *   admins hold this scope, and a custom instance role can hold it.
 * - `apiKey:manage`: the list of all API keys of the public API (`/api/v1/api-keys`), for reviews.
 *   The owner and the admins hold this scope, and a custom instance role can hold it.
 */
export const FORK_API_KEY_RESOURCES = {
	auditLogs: ['manage'],
	apiKey: ['manage'],
} as const;

export type ForkApiKeyResource = keyof typeof FORK_API_KEY_RESOURCES;

export type ForkApiKeyScope = {
	[R in ForkApiKeyResource]: `${R}:${(typeof FORK_API_KEY_RESOURCES)[R][number]}`;
}[ForkApiKeyResource];

export const FORK_API_KEY_SCOPES: ReadonlySet<string> = new Set(
	Object.entries(FORK_API_KEY_RESOURCES).flatMap(([resource, operations]) =>
		operations.map((operation) => `${resource}:${operation}`),
	),
);
