import { UrlService, EventService } from '@n8n/backend-services';
import type { AuthenticatedRequest } from '@n8n/db';
import { CredentialsRepository, isAuthenticatedRequest } from '@n8n/db';
import { Delete, Get, Options, Param, Post, RestController } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { NotFoundError } from '@n8n/errors';
import type { Request, Response } from 'express';

import { AuthService } from '@/auth/auth.service';

import { SYSTEM_RESOLVER_ID } from './constants';
import { DynamicCredentialUserEntryRepository } from './database/repositories/dynamic-credential-user-entry.repository';
import { DynamicCredentialsConfig } from './dynamic-credentials.config';
import { AuthorizeIntentService } from './services/authorize-intent.service';
import { DynamicCredentialCorsService } from './services/dynamic-credential-cors.service';
import { DynamicCredentialWebService } from './services/dynamic-credential-web.service';
import { getDynamicCredentialMiddlewares } from './utils';

const AUTHORIZE_METHODS = 'POST, OPTIONS';
const REVOKE_METHODS = 'DELETE, OPTIONS';

const config = () => Container.get(DynamicCredentialsConfig);

const userOf = (req: Request) => (isAuthenticatedRequest(req) ? req.user : undefined);

/**
 * Fork code (not in upstream n8n): the connection of an identity to a private credential. An
 * external application starts the OAuth flow of its user (`authorize`) and removes the
 * connection (`revoke`). A user opens an authorization link of the credential check, and removes
 * their own connection. See `README.md` in this folder.
 */
@RestController('/credentials')
export class DynamicCredentialsController {
	constructor(
		private readonly web: DynamicCredentialWebService,
		private readonly cors: DynamicCredentialCorsService,
		private readonly intents: AuthorizeIntentService,
		private readonly authService: AuthService,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly userEntryRepository: DynamicCredentialUserEntryRepository,
		private readonly eventService: EventService,
		private readonly urlService: UrlService,
	) {}

	@Options('/:id/revoke', { skipAuth: true })
	revokePreflight(req: Request, res: Response) {
		this.cors.preflight(req, res, REVOKE_METHODS);
	}

	@Delete('/:id/revoke', {
		allowUnauthenticated: true,
		middlewares: getDynamicCredentialMiddlewares(REVOKE_METHODS),
		ipRateLimit: { limit: config().rateLimitPerMinute, windowMs: 60_000 },
	})
	async revokeCredential(req: Request, res: Response, @Param('id') credentialId: string) {
		const { found, credential } = await this.web.target(credentialId, req.query.resolverId);
		const identity = this.web.identityOf(req, req.query.authSource, userOf(req));
		this.web.checkIdentity(found, credential, identity);
		await found.resolver.deleteSecret?.(credential.id, identity.context, found.handle);
		res.status(204).send();
	}

	@Options('/:id/authorize', { skipAuth: true })
	authorizePreflight(req: Request, res: Response) {
		this.cors.preflight(req, res, AUTHORIZE_METHODS);
	}

	/** Starts the OAuth flow of the identity of the request. Gives the URL of the provider. */
	@Post('/:id/authorize', {
		allowUnauthenticated: true,
		middlewares: getDynamicCredentialMiddlewares(AUTHORIZE_METHODS),
		ipRateLimit: { limit: config().rateLimitAuthorizePerMinute, windowMs: 60_000 },
	})
	async authorizeCredential(req: Request, res: Response, @Param('id') credentialId: string) {
		const { found, credential } = await this.web.target(credentialId, req.query.resolverId);
		const identity = this.web.identityOf(req, req.query.authSource, userOf(req));
		this.web.checkIdentity(found, credential, identity);
		await found.resolver.validateIdentity?.(identity.context, found.handle);
		return await this.web.authorizationUrl(req, res, credential, found.entity.id, identity);
	}

	/** Opens an authorization link of the credential check: redirects to the provider. */
	@Get('/:id/authorize', {
		allowUnauthenticated: true,
		usesTemplates: true,
		ipRateLimit: { limit: config().rateLimitAuthorizePerMinute, windowMs: 60_000 },
	})
	async openAuthorizationLink(req: Request, res: Response, @Param('id') credentialId: string) {
		const renderError = (message: string) => {
			res.render('oauth-error-callback', { error: { message } });
		};
		const token = req.query.token;
		if (typeof token !== 'string' || token.length === 0) {
			return renderError('Missing authorization token.');
		}
		const intent = await this.intents.find(token);
		const credential = intent
			? await this.credentialsRepository.findOneBy({ id: credentialId })
			: null;
		if (!intent || intent.credentialId !== credentialId || !credential?.isResolvable) {
			return renderError(
				'This authorization link is invalid or has expired. Please request a new one.',
			);
		}

		if (intent.userId) {
			const user = userOf(req);
			if (!user) {
				this.eventService.emit('dynamic-credential-authorize-rejected', {
					reason: 'unauthenticated',
					credentialId,
				});
				const baseUrl = this.urlService.getInstanceBaseUrl();
				const redirect = encodeURIComponent(`${baseUrl}${req.originalUrl}`);
				return res.redirect(`${baseUrl}/signin?redirect=${redirect}`);
			}
			if (user.id !== intent.userId) {
				this.eventService.emit('dynamic-credential-authorize-rejected', {
					reason: 'user-mismatch',
					credentialId,
				});
				return renderError(
					'This authorization link was issued for a different account. Sign in as the intended user and open the link again.',
				);
			}
			const cookie = this.authService.getCookieToken(req) ?? '';
			const url = await this.web.authorizationUrl(req, res, credential, intent.resolverId, {
				authorizationHeader: `Bearer ${cookie}`,
				authMetadata: { source: 'manual-execution' },
				userId: user.id,
			});
			return res.redirect(url);
		}

		if (!intent.authorizationHeader) {
			return renderError(
				'This authorization link is invalid or has expired. Please request a new one.',
			);
		}
		const url = await this.web.authorizationUrl(req, res, credential, intent.resolverId, {
			authorizationHeader: intent.authorizationHeader,
			authMetadata: intent.authMetadata ?? {},
		});
		return res.redirect(url);
	}

	/** Removes the connection of the user to a private credential. */
	@Delete('/:credentialId/my-connection')
	async disconnectMyConnection(
		req: AuthenticatedRequest,
		res: Response,
		@Param('credentialId') credentialId: string,
	) {
		const credential = await this.credentialsRepository.findOneBy({ id: credentialId });
		const removed =
			credential?.isResolvable === true &&
			(await this.userEntryRepository.deleteData(credentialId, req.user.id, SYSTEM_RESOLVER_ID));
		if (!credential || !removed) throw new NotFoundError('No connection to disconnect');

		this.eventService.emit('credentials-user-disconnected', {
			user: req.user,
			credentialId,
			credentialType: credential.type,
		});
		res.status(204).send();
	}
}
