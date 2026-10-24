// Fork module (not in upstream n8n): the SAML endpoints, in place of the enterprise
// `saml.controller.ee.ts`. packages/cli/src/modules/sso-saml/FORK.md describes them.
import { SamlAcsDto, SamlPreferences, SamlToggleDto } from '@n8n/api-types';
import { EventService, UrlService } from '@n8n/backend-services';
import { InstanceSettingsLoaderConfig } from '@n8n/config';
import { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Post, Query, RestController } from '@n8n/decorators';
import { AuthError, ForbiddenError } from '@n8n/errors';
import { Response } from 'express';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { SsoAccessDeniedError } from '@/modules/provisioning/errors/sso-access-denied.error';
import { AuthlessRequest } from '@/requests';
import { isSamlLicensedAndEnabled } from '@/sso/sso-helpers';
import { validateRedirectUrl } from '@/utils/validate-redirect-url';

import { SamlEmailNotVerifiedError } from './errors/saml-email-not-verified.error';
import {
	samlLicensedAndEnabledMiddleware,
	samlLicensedMiddleware,
} from './middleware/saml-enabled-middleware';
import { extractTestIdFromRelayState, isConnectionTestRequest } from './saml-helpers';
import { SamlService, type SamlLoginRequest } from './saml.service';
import { getServiceProviderEntityId, getServiceProviderReturnUrl } from './service-provider';
import type { SamlLoginBinding } from './types';
import { getInitSSOFormView } from './views/init-sso-post';

/** The reason of a sign-in that the role provisioning refuses, as the audit events name it. */
const ACCESS_DENIED_REASON = 'Access denied by SSO role mapping configuration';

/** The query of the login: an unknown value. */
type InitSsoRequest = AuthlessRequest<{}, {}, {}, { redirect?: unknown }>;

/** The preferences for the API: the signing key is redacted. */
function redact(preferences: SamlPreferences): SamlPreferences {
	return {
		...preferences,
		signingPrivateKey: preferences.signingPrivateKey ? CREDENTIAL_BLANKING_VALUE : undefined,
	};
}

@RestController('/sso/saml')
export class SamlController {
	constructor(
		private readonly samlService: SamlService,
		private readonly authService: AuthService,
		private readonly eventService: EventService,
		private readonly urlService: UrlService,
		private readonly instanceSettingsLoaderConfig: InstanceSettingsLoaderConfig,
	) {}

	/** The metadata of n8n as a service provider. An error keeps the XML content type. */
	@Get('/metadata', { skipAuth: true })
	getServiceProviderMetadata(_req: AuthlessRequest, res: Response) {
		res.header('Content-Type', 'text/xml');
		res.send(this.samlService.getServiceProviderMetadata());
	}

	@Get('/config', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	async configGet() {
		return {
			...redact(this.samlService.samlPreferences),
			entityID: getServiceProviderEntityId(),
			returnUrl: getServiceProviderReturnUrl(),
		};
	}

	@Post('/config', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	async configPost(_req: AuthenticatedRequest, _res: Response, @Body payload: SamlPreferences) {
		this.assertNotManagedByEnv();
		return redact(await this.samlService.setSamlPreferences(payload));
	}

	@Post('/config/toggle', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	async toggleEnabledPost(
		_req: AuthenticatedRequest,
		res: Response,
		@Body { loginEnabled }: SamlToggleDto,
	) {
		this.assertNotManagedByEnv();
		await this.samlService.setSamlPreferences({ loginEnabled });
		res.sendStatus(200);
	}

	/** The response of the identity provider, in the query (redirect binding). */
	@Get('/acs', { skipAuth: true, usesTemplates: true, middlewares: [samlLicensedMiddleware] })
	async acsGet(req: AuthlessRequest, res: Response, @Query query: SamlAcsDto) {
		await this.acsHandler(req, res, 'redirect', query.RelayState);
	}

	/** The response of the identity provider, in a form (post binding). */
	@Post('/acs', { skipAuth: true, usesTemplates: true, middlewares: [samlLicensedMiddleware] })
	async acsPost(req: AuthlessRequest, res: Response, @Body payload: SamlAcsDto) {
		await this.acsHandler(req, res, 'post', payload.RelayState);
	}

	/** The login request of the identity provider. The relay state is the path after the sign-in. */
	@Get('/initsso', { skipAuth: true, middlewares: [samlLicensedAndEnabledMiddleware] })
	initSsoGet(req: InitSsoRequest, res: Response) {
		const { redirect } = req.query;
		const relayState = typeof redirect === 'string' ? validateRedirectUrl(redirect) : '/';
		return this.sendLoginRequest(res, this.samlService.getLoginRequest(relayState));
	}

	/** The login request of a connection test. */
	@Post('/config/test', { middlewares: [samlLicensedMiddleware] })
	@GlobalScope('saml:manage')
	async configTestPost(_req: AuthenticatedRequest, res: Response, @Body payload: SamlPreferences) {
		return this.sendLoginRequest(res, await this.samlService.getTestLoginRequest(payload));
	}

	private async acsHandler(
		req: AuthlessRequest,
		res: Response,
		binding: SamlLoginBinding,
		relayState: string | undefined,
	) {
		if (isConnectionTestRequest({ RelayState: relayState })) {
			await this.sendConnectionTestResult(req, res, binding, relayState);
			return;
		}

		try {
			const { authenticatedUser, attributes } = await this.samlService.handleSamlLogin(
				req,
				binding,
			);
			// Only the user of a SAML identity can have another email than the response.
			const assertedEmail = attributes.email.toLowerCase();
			if (authenticatedUser.email.toLowerCase() !== assertedEmail) {
				this.eventService.emit('user-login-email-conflict', {
					user: authenticatedUser,
					authenticationMethod: 'saml',
					assertedEmail,
				});
			}
			this.eventService.emit('user-logged-in', {
				user: authenticatedUser,
				authenticationMethod: 'saml',
			});
			if (!isSamlLicensedAndEnabled()) {
				// The SAML login is off: the response gives the attributes, and no session.
				res.status(202).send(attributes);
				return;
			}
			this.authService.issueCookie(res, authenticatedUser, true, req.browserId);
			res.redirect(
				`${this.urlService.getInstanceBaseUrl()}${validateRedirectUrl(relayState ?? '/')}`,
			);
		} catch (error) {
			if (error instanceof SsoAccessDeniedError) {
				// The role mapping refuses the account. The sign-in page explains it.
				this.eventService.emit('user-login-failed', {
					userEmail: 'unknown',
					authenticationMethod: 'saml',
					reason: ACCESS_DENIED_REASON,
				});
				res.redirect(`${this.urlService.getInstanceBaseUrl()}/signin?ssoError=access-denied`);
				return;
			}
			const reason = error instanceof Error ? error.message : String(error);
			this.eventService.emit('user-login-failed', {
				userEmail: error instanceof SamlEmailNotVerifiedError ? error.email : 'unknown',
				authenticationMethod: 'saml',
				reason,
			});
			throw new AuthError(`SAML Authentication failed: ${reason}`);
		}
	}

	/**
	 * The page of a connection test: the attributes of the response, or the error. A test with
	 * metadata from its request uses that metadata, once.
	 */
	private async sendConnectionTestResult(
		req: AuthlessRequest,
		res: Response,
		binding: SamlLoginBinding,
		relayState: string | undefined,
	) {
		const testId = extractTestIdFromRelayState(relayState);
		const testPreferences = testId
			? await this.samlService.consumePendingTestConfig(testId)
			: undefined;
		try {
			const { attributes, rawAttributes } = await this.samlService.handleSamlLogin(
				req,
				binding,
				testPreferences,
			);
			res.render('saml-connection-test-success', {
				...attributes,
				rawAttributesJson: JSON.stringify(rawAttributes, null, 2),
			});
		} catch (error) {
			const message =
				error instanceof SsoAccessDeniedError
					? ACCESS_DENIED_REASON
					: error instanceof Error
						? error.message
						: String(error);
			res.render('saml-connection-test-failed', { message });
		}
	}

	/** A redirect URL as the response data, or a page that posts the form. */
	private sendLoginRequest(res: Response, loginRequest: SamlLoginRequest) {
		if (loginRequest.binding === 'post') {
			res.send(getInitSSOFormView(loginRequest.context, res.locals.cspNonce));
			return;
		}
		return loginRequest.context.context;
	}

	private assertNotManagedByEnv() {
		if (this.instanceSettingsLoaderConfig.ssoManagedByEnv) {
			throw new ForbiddenError(
				'SSO configuration is managed via environment variables and cannot be modified through the API',
			);
		}
	}
}
