import type { AuthPrincipal, Scope } from './types';

/** The kind of actor behind a request. */
export type PrincipalType = 'human' | 'service';

/** Who acts. A user maps to a human principal (see `principalFromUser` in `@n8n/db`). */
export type Principal = AuthPrincipal & {
	id: string;
	type: PrincipalType;
	email?: string;
	firstName?: string;
	lastName?: string;
};

/** How the caller proved who it is. There is no value for an unauthenticated caller. */
export type AuthMethod = 'session' | 'apiKey' | 'oauth' | 'scopedToken';

/**
 * What a protected resource grants. It has the same structure as `OAuthResourceGrant` in
 * `n8n-workflow`, so each type can take the place of the other.
 */
export type ResourceGrant = {
	audiences: string[];
	executeAccessWorkflowId?: string;
};

/** The authenticated caller of an operation. It holds no credentials. */
export type SecurityContext = {
	readonly subject: Principal;
	readonly authMethod: AuthMethod;
	/** The scopes that the credential of the caller limits it to, when it limits them. */
	readonly tokenScopes?: readonly Scope[];
	readonly grant?: ResourceGrant;
};
