import type { AuthPrincipal } from './types';

/**
 * The kind of actor behind a request. The `kind` of a `User` row has the same values
 * (see `UserKind` in `@n8n/db`).
 */
export type PrincipalType = 'person' | 'service';

/** Who acts. A user maps to a principal (see `principalFromUser` in `@n8n/db`). */
export type Principal = AuthPrincipal & {
	id: string;
	type: PrincipalType;
	email?: string;
	firstName?: string;
	lastName?: string;
};

/** How the caller proved who it is. There is no value for an unauthenticated caller. */
export type AuthMethod = 'session' | 'api-key' | 'scoped-jwt' | 'oauth-access-token';

/**
 * What a protected resource grants. It has the same structure as `OAuthResourceGrant` in
 * `n8n-workflow`, so each type can take the place of the other.
 */
export type ResourceGrant = {
	audiences: string[];
	executeAccessWorkflowId?: string;
};

/** The protected resource that a request calls. */
export type ProtectedResourceRef = {
	url: string;
	/** The token audiences that the resource accepts. */
	acceptedAudiences: string[];
};

/** The claim of a trusted source that names the caller. */
export type SubjectClaim = {
	sourceId: string;
	issuer: string;
	subject: string;
};

/** How the caller signed in at the trusted source, when the token tells it. */
export type AuthAssurance = {
	acr?: string;
	amr?: string[];
	authTime?: Date;
};

/** The authenticated caller of an operation. It holds no credentials. */
export type SecurityContext = {
	readonly subject: Principal;
	/** The principal that acts for the subject, when it is not the subject. */
	readonly actor?: Principal;
	readonly authMethod: AuthMethod;
	/** The claim that identified the caller, when a trusted source issued the token. */
	readonly subjectClaim?: SubjectClaim;
	/** The OAuth client of the caller, when the token names one. */
	readonly clientId?: string;
	/** The scopes that the credential of the caller limits it to, when it limits them. */
	readonly tokenScopes?: string[];
	readonly resource?: ProtectedResourceRef;
	readonly grant?: ResourceGrant;
	readonly assurance?: AuthAssurance;
};
