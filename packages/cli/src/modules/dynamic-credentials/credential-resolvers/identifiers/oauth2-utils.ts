import { z } from 'zod';

import { IdentifierValidationError } from './identifier-interface';

/** The fields of an OAuth2 or OpenID Connect metadata document that the resolver uses. */
export const oauth2MetadataSchema = z
	.object({
		issuer: z.string().optional(),
		introspection_endpoint: z.string().optional(),
		introspection_endpoint_auth_methods_supported: z.array(z.string()).optional(),
		userinfo_endpoint: z.string().optional(),
		jwks_uri: z.string().optional(),
	})
	.passthrough();

export type OAuth2Metadata = z.infer<typeof oauth2MetadataSchema>;

export const NO_EXPECTED_AUDIENCE_WARNING =
	'OAuth2 resolver has no expected audience configured, so access tokens are not bound to this instance. Set an expected audience on the resolver.';

/** The token of an identity. The OAuth callback stores the identity as an `Authorization` value. */
export function extractToken(identity: string) {
	return identity.replace(/^bearer\s+/i, '');
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/** Throws unless the `aud` value of a token names the expected audience. */
export function checkAudience(audience: unknown, expectedAudience: string) {
	const audiences = Array.isArray(audience) ? audience : [audience];
	const declared = audiences.filter(
		(entry): entry is string => typeof entry === 'string' && entry.length > 0,
	);
	if (declared.length === 0) {
		throw new IdentifierValidationError(
			'Token declares no audience, so it cannot be confirmed as issued for this instance',
		);
	}
	if (!declared.includes(expectedAudience)) {
		throw new IdentifierValidationError('Token was not issued for the expected audience');
	}
}

/** The value of a claim as a subject, or undefined. */
export function claimValue(claims: Record<string, unknown>, claim: string) {
	const value = claims[claim];
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'number') return String(value);
	return undefined;
}

/** The time until which a result for a token can stay in the cache. */
export function cacheExpiry(claims: Record<string, unknown>, maxAgeMs: number) {
	const limit = Date.now() + maxAgeMs;
	return typeof claims.exp === 'number' ? Math.min(claims.exp * 1000, limit) : limit;
}
