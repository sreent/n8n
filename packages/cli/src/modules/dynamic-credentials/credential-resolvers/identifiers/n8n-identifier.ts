import { Logger } from '@n8n/backend-common';
import { CredentialResolverError } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { TrustedSourceGate } from '@n8n/inbound-auth';
import {
	N8NOAuthMetadataSchema,
	type ICredentialContext,
	type IN8NOAuthMetadata,
} from 'n8n-workflow';
import { z } from 'zod/v4';

import { AuthService } from '@/auth/auth.service';
import type { IExecutingUserIdentifier } from '@n8n/backend-services';
import { OAuthTokenVerifierProxy } from '@n8n/backend-services/auth';

import type { IdentifierOptions, ITokenIdentifier } from './identifier-interface';
import { extractToken } from './oauth2-utils';

/**
 * The sources of the identities of n8n users. An n8n OAuth identity has the one schema of
 * `n8n-workflow`, which also reads the seals of older versions. That schema uses zod 4, so this
 * union does too.
 */
export const n8nIdentityMetadataSchema = z.union([
	z.object({ source: z.literal('manual-execution') }),
	z.object({ source: z.literal('chat-hub-injected') }),
	z.object({
		source: z.literal('cookie-source'),
		method: z.string(),
		endpoint: z.string(),
		browserId: z.string().optional(),
	}),
	N8NOAuthMetadataSchema,
]);

/** Whether an identity is the identity of an n8n user (a session or an n8n OAuth token). */
export function isN8nIdentity(context: ICredentialContext) {
	return n8nIdentityMetadataSchema.safeParse(context.metadata).success;
}

/**
 * Resolves the n8n user of an identity: the session cookie of a manual run, of a request (with
 * the browser id), or an access token of the n8n OAuth server. A sealed n8n OAuth identity names
 * its user, and is valid only in the executions that it was bound to.
 */
@Service()
export class N8NIdentifier implements ITokenIdentifier, IExecutingUserIdentifier {
	constructor(
		private readonly logger: Logger,
		private readonly authService: AuthService,
		private readonly tokenVerifier: OAuthTokenVerifierProxy,
	) {}

	async resolve(
		context: ICredentialContext,
		_identifierOptions: IdentifierOptions,
		executionId?: string,
	): Promise<string> {
		const result = n8nIdentityMetadataSchema.safeParse(context.metadata);
		if (!result.success) {
			throw new CredentialResolverError(`Invalid context metadata: ${result.error.message}`);
		}
		const metadata = result.data;
		const token = extractToken(context.identity);
		switch (metadata.source) {
			case 'manual-execution':
			case 'chat-hub-injected':
				return (await this.authService.authenticateUserByCookie(token)).id;
			case 'cookie-source':
				return (
					await this.authService.authenticateUserBasedOnToken(
						token,
						metadata.method,
						metadata.endpoint,
						metadata.browserId,
					)
				).id;
			case 'n8n-oauth':
				return await this.resolveOAuthUser(token, metadata, executionId);
		}
	}

	/** The user of an identity for the attribution of a run, or undefined. Never throws. */
	async identify(context: ICredentialContext): Promise<string | undefined> {
		const result = n8nIdentityMetadataSchema.safeParse(context.metadata);
		if (!result.success) return undefined;
		const metadata = result.data;
		try {
			if (metadata.source === 'n8n-oauth') {
				if (metadata.subject) return metadata.subject;
				const { user } = await this.tokenVerifier.verifyOAuthAccessToken(
					extractToken(context.identity),
					metadata.resource,
				);
				return user?.id;
			}
			return await this.resolve(context, {});
		} catch (error) {
			this.logger.warn('Could not identify the executing user for redaction attribution', {
				error,
			});
			return undefined;
		}
	}

	private async resolveOAuthUser(
		token: string,
		metadata: IN8NOAuthMetadata,
		executionId: string | undefined,
	) {
		const invalidToken = () =>
			new CredentialResolverError(`Invalid OAuth token for resource ${metadata.resource}`);
		if (metadata.subject) {
			// A sealed identity: the trigger verified the token once. It is valid only in the
			// executions that the context was bound to.
			if (!executionId || !metadata.executionPath?.includes(executionId)) {
				throw new CredentialResolverError('Sealed identity is not valid for this execution');
			}
			// The seal re-takes the decision that admitted the caller: the user, the binding of
			// the trusted source and the grant. A legacy seal without a grant has nothing to re-take.
			if (metadata.grant) {
				const allowed = await this.authorizeSeal({
					userId: metadata.subject,
					grant: metadata.grant,
					...(metadata.binding ? { binding: metadata.binding } : {}),
				});
				if (!allowed) throw invalidToken();
			}
			return metadata.subject;
		}
		const { user } = await this.tokenVerifier.verifyOAuthAccessToken(token, metadata.resource);
		if (!user) throw invalidToken();
		return user.id;
	}

	/** The module `inbound-auth-core` binds the gate. Without it, nothing can re-check a seal. */
	private async authorizeSeal(input: Parameters<TrustedSourceGate['authorizeSealed']>[0]) {
		if (!Container.has(TrustedSourceGate)) return false;
		return await Container.get(TrustedSourceGate).authorizeSealed(input);
	}
}
