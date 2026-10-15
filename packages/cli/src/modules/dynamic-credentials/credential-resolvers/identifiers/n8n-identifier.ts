import { Logger } from '@n8n/backend-common';
import { CredentialResolverError } from '@n8n/decorators';
import { Service } from '@n8n/di';
import type { ICredentialContext } from 'n8n-workflow';
import { z } from 'zod';

import { AuthService } from '@/auth/auth.service';
import type { IExecutingUserIdentifier } from '@/credentials/executing-user-identifier.interface';
import { OAuthTokenVerifierProxy } from '@/services/oauth-token-verifier-proxy.service';

import type { IdentifierOptions, ITokenIdentifier } from './identifier-interface';
import { extractToken } from './oauth2-utils';

/** The sources of the identities of n8n users. */
export const n8nIdentityMetadataSchema = z.discriminatedUnion('source', [
	z.object({ source: z.literal('manual-execution') }),
	z.object({ source: z.literal('chat-hub-injected') }),
	z.object({
		source: z.literal('cookie-source'),
		method: z.string(),
		endpoint: z.string(),
		browserId: z.string().optional(),
	}),
	z.object({
		source: z.literal('n8n-oauth'),
		subject: z.string().optional(),
		resource: z.string(),
		establishedAt: z.number().optional(),
		executionPath: z.array(z.string()).optional(),
		grant: z
			.object({
				audiences: z.array(z.string()).min(1),
				executeAccessWorkflowId: z.string().optional(),
			})
			.optional(),
	}),
]);

type N8nOAuthMetadata = Extract<z.infer<typeof n8nIdentityMetadataSchema>, { source: 'n8n-oauth' }>;

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
		metadata: N8nOAuthMetadata,
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
			if (metadata.grant) {
				const allowed = await this.tokenVerifier.authorizeSealedGrant(
					metadata.subject,
					metadata.grant,
				);
				if (!allowed) throw invalidToken();
			}
			return metadata.subject;
		}
		const { user } = await this.tokenVerifier.verifyOAuthAccessToken(token, metadata.resource);
		if (!user) throw invalidToken();
		return user.id;
	}
}
