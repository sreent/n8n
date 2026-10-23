import { createHash } from 'node:crypto';

import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { isRecord } from '@n8n/utils/is-record';
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from 'jose';
import type { ICredentialContext } from 'n8n-workflow';

import {
	IdentifierValidationError,
	type IdentifierOptions,
	type ITokenIdentifier,
} from './identifier-interface';
import { OAuth2MetadataCache, OAuth2MetadataHttpClient } from './oauth2-metadata-http-client';
import {
	cacheExpiry,
	checkAudience,
	claimValue,
	extractToken,
	NO_EXPECTED_AUDIENCE_WARNING,
	type OAuth2Metadata,
} from './oauth2-utils';
import { oauthUserInfoOptionsSchema } from '../oauth-options';

const RESULT_CACHE_MS = 5 * 60 * 1000;
const KEY_SET_CACHE_MS = 60 * 60 * 1000;
/** After a key set was read again for an unknown key, it is not read again for this time. */
const KEY_SET_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

type KeySet = { keys: JSONWebKeySet; fetchedAt: number; refreshedForUnknownKeyAt?: number };

const isJwt = (token: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

const isKeySet = (value: unknown): value is JSONWebKeySet =>
	isRecord(value) && Array.isArray(value.keys);

/**
 * Validates an access token at the userinfo endpoint of the identity provider, and gives the
 * subject claim. With an expected audience, the token must be a JWT: the identifier verifies
 * its signature with the key set of the provider, its issuer and its audience first, and takes
 * the subject from the token when the token has the claim.
 */
@Service()
export class OAuth2UserInfoIdentifier implements ITokenIdentifier {
	private readonly metadata: OAuth2MetadataCache;

	private readonly results = new Map<string, { subject: string; expiresAt: number }>();

	private readonly keySets = new Map<string, KeySet>();

	constructor(
		private readonly logger: Logger,
		private readonly http: OAuth2MetadataHttpClient,
	) {
		this.metadata = new OAuth2MetadataCache(http);
	}

	async resolve(context: ICredentialContext, identifierOptions: IdentifierOptions) {
		const options = oauthUserInfoOptionsSchema.parse(identifierOptions);
		const token = extractToken(context.identity);
		const subjectClaim = options.subjectClaim || 'sub';
		const cacheKey = createHash('sha256')
			.update(
				JSON.stringify([options.metadataUri, options.expectedAudience ?? '', subjectClaim, token]),
			)
			.digest('hex');
		const cached = this.results.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.subject;

		let claims: Record<string, unknown> = {};
		if (options.expectedAudience) {
			if (!isJwt(token)) {
				throw new IdentifierValidationError(
					'Access token is not a JWT, so its audience cannot be verified. Use the token introspection validation method with this provider.',
				);
			}
			const metadata = await this.metadata.get(options.metadataUri);
			claims = await this.verify(token, metadata);
			checkAudience(claims.aud, options.expectedAudience);
			const subject = claimValue(claims, subjectClaim);
			if (subject !== undefined) {
				this.logger.debug('Resolved subject from access token');
				this.results.set(cacheKey, { subject, expiresAt: cacheExpiry(claims, RESULT_CACHE_MS) });
				return subject;
			}
		} else {
			this.logger.warn(NO_EXPECTED_AUDIENCE_WARNING);
		}

		const metadata = await this.metadata.get(options.metadataUri);
		if (!metadata.userinfo_endpoint) {
			throw new IdentifierValidationError('Invalid OAuth2 metadata format');
		}
		let answer: Awaited<ReturnType<OAuth2MetadataHttpClient['get']>>;
		try {
			answer = await this.http.get(metadata.userinfo_endpoint, {
				Authorization: `Bearer ${token}`,
			});
		} catch (error) {
			this.logger.error('UserInfo failed', { error });
			throw new IdentifierValidationError('UserInfo query failed', { cause: error });
		}
		if (answer.status < 200 || answer.status >= 300 || !isRecord(answer.body)) {
			this.logger.error('UserInfo failed', { status: answer.status });
			throw new IdentifierValidationError('UserInfo query failed');
		}
		const subject = claimValue(answer.body, subjectClaim);
		if (subject === undefined) {
			const message = `UserInfo response missing subject claim (${subjectClaim})`;
			this.logger.error(message);
			throw new IdentifierValidationError(message);
		}
		this.results.set(cacheKey, { subject, expiresAt: cacheExpiry(claims, RESULT_CACHE_MS) });
		this.logger.debug('UserInfo successfully');
		return subject;
	}

	/** The claims of a JWT whose signature and issuer are valid. */
	private async verify(token: string, metadata: OAuth2Metadata) {
		try {
			if (!metadata.jwks_uri) throw new Error('The provider metadata has no jwks_uri');
			const jwksUri = metadata.jwks_uri;
			const verifyWith = async (keySet: KeySet) =>
				await jwtVerify(token, createLocalJWKSet(keySet.keys), {
					...(metadata.issuer ? { issuer: metadata.issuer } : {}),
				});
			const keySet = await this.keySet(jwksUri);
			try {
				return (await verifyWith(keySet)).payload;
			} catch (error) {
				// A provider that rotates its keys signs with a key that the cached set does not have.
				const now = Date.now();
				const mayRefresh =
					keySet.refreshedForUnknownKeyAt === undefined ||
					now - keySet.refreshedForUnknownKeyAt > KEY_SET_REFRESH_COOLDOWN_MS;
				if (!(error instanceof joseErrors.JWKSNoMatchingKey) || !mayRefresh) throw error;
				const refreshed = await this.fetchKeySet(jwksUri);
				refreshed.refreshedForUnknownKeyAt = now;
				return (await verifyWith(refreshed)).payload;
			}
		} catch (error) {
			this.logger.error('Access token verification failed', { error });
			throw new IdentifierValidationError('Access token verification failed', { cause: error });
		}
	}

	private async keySet(jwksUri: string) {
		const cached = this.keySets.get(jwksUri);
		if (cached && Date.now() - cached.fetchedAt < KEY_SET_CACHE_MS) return cached;
		return await this.fetchKeySet(jwksUri, cached?.refreshedForUnknownKeyAt);
	}

	private async fetchKeySet(jwksUri: string, refreshedForUnknownKeyAt?: number) {
		const answer = await this.http.get(jwksUri, {});
		if (answer.status < 200 || answer.status >= 300 || !isKeySet(answer.body)) {
			throw new Error(`The key set of the provider is not available (status ${answer.status})`);
		}
		const keySet: KeySet = { keys: answer.body, fetchedAt: Date.now(), refreshedForUnknownKeyAt };
		this.keySets.set(jwksUri, keySet);
		return keySet;
	}
}
