// Fork module (not in upstream n8n): the OIDC endpoints, in place of the enterprise
// `oidc.controller.ee.ts`. packages/cli/src/modules/sso-oidc/FORK.md describes them.
import { OidcConfigDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { EventService, UrlService } from '@n8n/backend-services';
import { GlobalConfig, InstanceSettingsLoaderConfig } from '@n8n/config';
import { Time } from '@n8n/constants';
import { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Licensed, Post, RestController } from '@n8n/decorators';
import { ForbiddenError } from '@n8n/errors';
import { Response } from 'express';
import { Cipher } from 'n8n-core';

import { AuthService } from '@/auth/auth.service';
import { SsoAccessDeniedError } from '@/modules/provisioning/errors/sso-access-denied.error';
import { AuthlessRequest } from '@/requests';
import { JwtService } from '@/services/jwt.service';
import { validateRedirectUrl } from '@/utils/validate-redirect-url';

import { OIDC_ID_TOKEN_COOKIE_MAX_BYTES, OIDC_ID_TOKEN_COOKIE_NAME } from './constants';
import { OidcService } from './oidc.service';
import { renderOidcTestFailure, renderOidcTestSuccess } from './views/oidc-test-result';

const STATE_COOKIE_NAME = 'n8n-oidc-state';
const NONCE_COOKIE_NAME = 'n8n-oidc-nonce';
/** The time from a login to its callback. */
const FLOW_COOKIE_LIFETIME = 15 * Time.minutes.toMilliseconds;

interface StateClaims {
	state: string;
	testMode?: boolean;
	redirectUrl?: string;
}

interface NonceClaims {
	nonce: string;
}

/** The query that the editor or the provider adds: an unknown value of each parameter. */
type OidcRequest = AuthlessRequest<{}, {}, {}, { redirect?: unknown; error?: unknown }>;

@RestController('/sso/oidc')
export class OidcController {
	constructor(
		private readonly oidcService: OidcService,
		private readonly authService: AuthService,
		private readonly jwtService: JwtService,
		private readonly eventService: EventService,
		private readonly urlService: UrlService,
		private readonly cipher: Cipher,
		private readonly globalConfig: GlobalConfig,
		private readonly instanceSettingsLoaderConfig: InstanceSettingsLoaderConfig,
		private readonly logger: Logger,
	) {}

	@Get('/config')
	@Licensed('feat:oidc')
	@GlobalScope('oidc:manage')
	async retrieveConfiguration(_req: AuthenticatedRequest) {
		return await this.oidcService.getRedactedConfig();
	}

	@Post('/config')
	@Licensed('feat:oidc')
	@GlobalScope('oidc:manage')
	async saveConfiguration(
		_req: AuthenticatedRequest,
		_res: Response,
		@Body payload: OidcConfigDto,
	) {
		if (this.instanceSettingsLoaderConfig.ssoManagedByEnv) {
			throw new ForbiddenError(
				'OIDC configuration is managed via environment variables and cannot be modified through the API',
			);
		}
		await this.oidcService.updateConfig(payload);
		return await this.oidcService.getRedactedConfig();
	}

	@Post('/config/test')
	@Licensed('feat:oidc')
	@GlobalScope('oidc:manage')
	async testConfiguration(_req: AuthenticatedRequest, res: Response) {
		const { url, state, nonce } = await this.oidcService.generateTestLoginUrl();
		this.setFlowCookies(res, { state, testMode: true }, nonce);
		return { url: url.toString() };
	}

	@Get('/login', { skipAuth: true })
	@Licensed('feat:oidc')
	async redirectToAuthProvider(req: OidcRequest, res: Response) {
		const { url, state, nonce } = await this.oidcService.generateLoginUrl();
		// Only a path on this instance. The helper gives `/` for anything else.
		const { redirect } = req.query;
		const redirectUrl = typeof redirect === 'string' ? validateRedirectUrl(redirect) : '/';
		this.setFlowCookies(res, { state, ...(redirectUrl !== '/' ? { redirectUrl } : {}) }, nonce);
		res.redirect(url.toString());
	}

	@Get('/callback', { skipAuth: true })
	@Licensed('feat:oidc')
	async callbackHandler(req: OidcRequest, res: Response) {
		try {
			const stateToken: unknown = req.cookies?.[STATE_COOKIE_NAME];
			const nonceToken: unknown = req.cookies?.[NONCE_COOKIE_NAME];
			if (typeof stateToken !== 'string' || typeof nonceToken !== 'string') {
				throw new ForbiddenError('The state or the nonce cookie is missing');
			}
			const stateClaims = this.jwtService.verify<StateClaims>('oidcState', stateToken);
			// The cookies serve one callback, also when it fails from here on.
			res.clearCookie(STATE_COOKIE_NAME);
			res.clearCookie(NONCE_COOKIE_NAME);
			const nonceClaims = this.jwtService.verify<NonceClaims>('oidcNonce', nonceToken);
			const callbackUrl = this.callbackUrlOf(req.originalUrl);

			if (stateClaims.testMode) {
				await this.sendConnectionTestResult(res, callbackUrl, stateClaims, nonceClaims);
				return;
			}

			const { user, idToken } = await this.oidcService.loginUser(
				callbackUrl,
				stateClaims.state,
				nonceClaims.nonce,
			);
			this.authService.issueCookie(res, user, true, req.browserId);
			await this.setIdTokenCookie(res, idToken);
			this.eventService.emit('user-logged-in', { user, authenticationMethod: 'oidc' });
			res.redirect(stateClaims.redirectUrl ?? '/');
		} catch (error) {
			if (error instanceof SsoAccessDeniedError) {
				// The role mapping refuses the account. The sign-in page explains it.
				this.eventService.emit('user-login-failed', {
					authenticationMethod: 'oidc',
					userEmail: 'unknown',
				});
				res.redirect(`${this.urlService.getInstanceBaseUrl()}/signin?ssoError=access-denied`);
				return;
			}
			this.logger.warn('The OIDC sign-in failed', { error });
			const providerError = req.query.error;
			this.eventService.emit('user-login-failed', {
				authenticationMethod: 'oidc',
				userEmail: 'unknown',
				reason: typeof providerError === 'string' ? providerError : 'oidc_callback_failed',
			});
			res.redirect(`${this.urlService.getInstanceBaseUrl()}/signin?ssoError=login-failed`);
		}
	}

	@Post('/logout')
	@Licensed('feat:oidc')
	async logout(req: AuthenticatedRequest, res: Response) {
		const redirectUrl = await this.oidcService.getLogoutRedirectUrl(
			req.cookies?.[OIDC_ID_TOKEN_COOKIE_NAME],
		);
		await this.authService.invalidateToken(req);
		this.authService.clearCookie(res);
		res.clearCookie(OIDC_ID_TOKEN_COOKIE_NAME);
		return { redirectUrl };
	}

	private async sendConnectionTestResult(
		res: Response,
		callbackUrl: URL,
		stateClaims: StateClaims,
		nonceClaims: NonceClaims,
	) {
		try {
			const result = await this.oidcService.runConnectionTest(
				callbackUrl,
				stateClaims.state,
				nonceClaims.nonce,
			);
			res.send(renderOidcTestSuccess(result, res.locals.cspNonce));
		} catch (error) {
			res.send(renderOidcTestFailure(error, res.locals.cspNonce));
		}
	}

	/** The state and nonce cookies of a login or a connection test. */
	private setFlowCookies(res: Response, stateClaims: StateClaims, nonce: string) {
		const options = this.cookieOptions(FLOW_COOKIE_LIFETIME);
		res.cookie(
			STATE_COOKIE_NAME,
			this.jwtService.sign('oidcState', stateClaims, { expiresIn: '15m' }),
			options,
		);
		res.cookie(
			NONCE_COOKIE_NAME,
			this.jwtService.sign('oidcNonce', { nonce }, { expiresIn: '15m' }),
			options,
		);
	}

	/**
	 * The id token of the session, encrypted, for the RP-initiated logout. A browser drops a cookie
	 * that is too large, so a large id token gets no cookie.
	 */
	private async setIdTokenCookie(res: Response, idToken: string | undefined) {
		if (!idToken) return;
		const encrypted = await this.cipher.encryptV2(idToken);
		if (encrypted.length > OIDC_ID_TOKEN_COOKIE_MAX_BYTES) return;
		res.cookie(
			OIDC_ID_TOKEN_COOKIE_NAME,
			encrypted,
			this.cookieOptions(this.authService.jwtExpiration * Time.seconds.toMilliseconds),
		);
	}

	private cookieOptions(maxAge: number) {
		const { samesite, secure } = this.globalConfig.auth.cookie;
		return { maxAge, httpOnly: true, sameSite: samesite, secure };
	}

	/** The callback URL of the instance, with the query of the request. */
	private callbackUrlOf(originalUrl: string) {
		const url = new URL(this.oidcService.getCallbackUrl());
		const queryStart = originalUrl.indexOf('?');
		if (queryStart !== -1) url.search = originalUrl.slice(queryStart);
		return url;
	}
}
