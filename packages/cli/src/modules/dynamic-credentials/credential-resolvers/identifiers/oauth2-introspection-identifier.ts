import { createHash } from 'node:crypto';

import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
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
	isRecord,
	NO_EXPECTED_AUDIENCE_WARNING,
} from './oauth2-utils';
import { oauthIntrospectionOptionsSchema } from '../oauth-options';

const RESULT_CACHE_MS = 5 * 60 * 1000;

/**
 * Validates an access token at the token introspection endpoint of the identity provider
 * (RFC 7662), and gives the subject claim of an active token.
 */
@Service()
export class OAuth2IntrospectionIdentifier implements ITokenIdentifier {
	private readonly metadata: OAuth2MetadataCache;

	private readonly results = new Map<string, { subject: string; expiresAt: number }>();

	constructor(
		private readonly logger: Logger,
		private readonly http: OAuth2MetadataHttpClient,
	) {
		this.metadata = new OAuth2MetadataCache(http);
	}

	async resolve(context: ICredentialContext, identifierOptions: IdentifierOptions) {
		const options = oauthIntrospectionOptionsSchema.parse(identifierOptions);
		const token = extractToken(context.identity);
		const cacheKey = createHash('sha256')
			.update(JSON.stringify([options.metadataUri, options.clientId, token]))
			.digest('hex');
		const cached = this.results.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.subject;

		const metadata = await this.metadata.get(options.metadataUri);
		if (!metadata.introspection_endpoint) {
			throw new IdentifierValidationError('Invalid OAuth2 metadata format');
		}
		// RFC 7662 recommends HTTP Basic authentication. A provider that only supports the
		// credentials in the request body says so in its metadata.
		const methods = metadata.introspection_endpoint_auth_methods_supported;
		const usesBody =
			methods !== undefined &&
			!methods.includes('client_secret_basic') &&
			methods.includes('client_secret_post');
		const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');

		let answer: Awaited<ReturnType<OAuth2MetadataHttpClient['postForm']>>;
		try {
			answer = await this.http.postForm(
				metadata.introspection_endpoint,
				usesBody
					? { token, client_id: options.clientId, client_secret: options.clientSecret }
					: { token },
				usesBody ? {} : { Authorization: `Basic ${basic}` },
			);
		} catch (error) {
			this.logger.error('Token introspection failed', { error });
			throw new IdentifierValidationError('Token introspection failed', { cause: error });
		}
		if (answer.status < 200 || answer.status >= 300) {
			this.logger.error('Token introspection failed', { status: answer.status });
			throw new IdentifierValidationError('Token introspection failed');
		}
		const claims = answer.body;
		if (!isRecord(claims)) {
			this.logger.error('Invalid token introspection response format');
			throw new IdentifierValidationError('Invalid token introspection response format');
		}
		if (claims.active !== true) {
			this.logger.error('Token is not active according to introspection response');
			throw new IdentifierValidationError('Token is not active');
		}

		if (options.expectedAudience) {
			checkAudience(claims.aud, options.expectedAudience);
		} else {
			this.logger.warn(NO_EXPECTED_AUDIENCE_WARNING);
		}

		const subjectClaim = options.subjectClaim || 'sub';
		const subject = claimValue(claims, subjectClaim);
		if (subject === undefined) {
			const message = `Token introspection response missing subject claim (${subjectClaim})`;
			this.logger.error(message);
			throw new IdentifierValidationError(message);
		}

		this.results.set(cacheKey, { subject, expiresAt: cacheExpiry(claims, RESULT_CACHE_MS) });
		this.logger.debug('Token introspected successfully');
		return subject;
	}
}
