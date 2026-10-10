// Fork module (not in upstream n8n): the OIDC sign-in of the instance, in place of the enterprise
// `oidc.service.ee.ts`. The class keeps its name and the methods that ordinary code calls
// (`init`, `loadConfig` and `updateConfig`), so that the callers change only their import.
// packages/cli/src/modules/sso-oidc/FORK.md describes it.
import { OidcConfigDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { UrlService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import { Time } from '@n8n/constants';
import {
	AuthIdentity,
	AuthIdentityRepository,
	isValidEmail,
	SettingsRepository,
	UserRepository,
	type User,
} from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { BadRequestError, ForbiddenError, UserError } from '@n8n/errors';
import { Cipher, InstanceSettings } from 'n8n-core';
import { randomUUID } from 'node:crypto';
import * as client from 'openid-client';

import { ProvisioningService } from '@/modules/provisioning/provisioning.service';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import {
	assertAuthenticationMethodCanBeEnabled,
	getCurrentAuthenticationMethod,
	isOidcCurrentAuthenticationMethod,
	setCurrentAuthenticationMethod,
} from '@/sso/sso-helpers';

import { OIDC_CLIENT_SECRET_REDACTED_VALUE, OIDC_PREFERENCES_DB_KEY } from './constants';

/** The OIDC config with the discovery endpoint as a URL. */
export type OidcRuntimeConfig = Omit<OidcConfigDto, 'discoveryEndpoint'> & {
	discoveryEndpoint: URL;
};

/** The config without a stored row, or with a stored row that is not valid. */
const DEFAULT_OIDC_CONFIG: OidcConfigDto = {
	clientId: '',
	clientSecret: '',
	discoveryEndpoint: 'http://n8n.io/not-set',
	loginEnabled: false,
	prompt: 'select_account',
	authenticationContextClassReference: [],
	additionalScopes: '',
	rpInitiatedLogoutEnabled: false,
};

/** How long a discovery result, also a failed one, serves logins, callbacks and logouts. */
const PROVIDER_METADATA_LIFETIME = 1 * Time.hours.toMilliseconds;

/** The password of a user that the OIDC sign-in creates. It is not a hash, so no password matches. */
const OIDC_USER_PASSWORD = 'no password set';

/** The value of `email_verified` that the provider sends: a boolean or a string. */
const isEmailVerified = (value: unknown) => value === true || value === 'true';
const isEmailUnverified = (value: unknown) => value === false || value === 'false';

export interface OidcAuthorizationRequest {
	url: URL;
	state: string;
	nonce: string;
}

@Service()
export class OidcService {
	/** The config that the login, the callback and the logout use, with the client secret decrypted. */
	private oidcConfig: OidcRuntimeConfig = this.withUrl(DEFAULT_OIDC_CONFIG);

	private cachedConfiguration:
		| { configuration: Promise<client.Configuration>; validUntil: number }
		| undefined;

	private readonly customFetch: client.CustomFetch;

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly settingsRepository: SettingsRepository,
		private readonly userRepository: UserRepository,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly cipher: Cipher,
		private readonly urlService: UrlService,
		private readonly instanceSettings: InstanceSettings,
		private readonly publisher: Publisher,
		private readonly provisioningService: ProvisioningService,
		outboundHttp: OutboundHttp,
	) {
		// The provider is admin-configured and may be internal. The connection does not use the
		// proxy of the environment. The cast only bridges the type of a binary body: `openid-client`
		// types it as `Uint8Array<ArrayBufferLike>`, which the fetch types do not accept.
		this.customFetch = outboundHttp
			.transport({ proxy: false, useDefaultSsrfPolicy: 'unsafe' })
			.asCustomFetch() as client.CustomFetch;
	}

	/** Load the stored config, and apply its login state to the sign-in method. */
	async init() {
		this.oidcConfig = await this.loadConfig(true);
		await this.setLoginEnabled(this.oidcConfig.loginEnabled);
	}

	/**
	 * The stored config. Without a stored row, or with a row that is not valid, the default config.
	 * The client secret stays encrypted unless `decryptSecret` is true. A secret that does not
	 * decrypt is an empty string.
	 */
	async loadConfig(decryptSecret = false): Promise<OidcRuntimeConfig> {
		const row = await this.settingsRepository.findByKey(OIDC_PREFERENCES_DB_KEY);
		const stored = row ? this.parseStoredConfig(row.value) : undefined;
		if (!stored) return this.withUrl(DEFAULT_OIDC_CONFIG);
		if (decryptSecret) stored.clientSecret = await this.decryptSecret(stored.clientSecret);
		return this.withUrl(stored);
	}

	/** The stored config for the API, with the client secret redacted. */
	async getRedactedConfig() {
		const config = await this.loadConfig();
		return {
			...config,
			discoveryEndpoint: config.discoveryEndpoint.toString(),
			clientSecret: config.clientSecret ? OIDC_CLIENT_SECRET_REDACTED_VALUE : config.clientSecret,
		};
	}

	/**
	 * Store a new config after a discovery with it succeeds. The redacted secret keeps the secret of
	 * the current config.
	 */
	async updateConfig(newConfig: OidcConfigDto): Promise<void> {
		const discoveryEndpoint = new URL(newConfig.discoveryEndpoint);
		const clientSecret =
			newConfig.clientSecret === OIDC_CLIENT_SECRET_REDACTED_VALUE
				? this.oidcConfig.clientSecret
				: newConfig.clientSecret;
		if (newConfig.loginEnabled) assertAuthenticationMethodCanBeEnabled('oidc');

		try {
			await this.discover(discoveryEndpoint, newConfig.clientId, clientSecret);
		} catch (error) {
			this.logger.warn('OIDC discovery failed', { error });
			throw new UserError('Failed to discover OIDC metadata, based on the provided configuration');
		}

		await this.settingsRepository.upsertByKey(
			OIDC_PREFERENCES_DB_KEY,
			JSON.stringify({ ...newConfig, clientSecret: await this.cipher.encryptV2(clientSecret) }),
			true,
			{},
		);
		this.oidcConfig = { ...newConfig, clientSecret, discoveryEndpoint };
		this.cachedConfiguration = undefined;
		await this.setLoginEnabled(newConfig.loginEnabled);

		if (this.instanceSettings.isMultiMain) {
			void this.publisher.publishCommand({ command: 'reload-oidc-config' });
		}
	}

	/** Another main instance changed the config. */
	@OnPubSubEvent('reload-oidc-config', { instanceType: 'main' })
	async reloadConfig() {
		this.oidcConfig = await this.loadConfig(true);
		this.cachedConfiguration = undefined;
	}

	/** True when the config enables the login, and OIDC is the sign-in method. */
	isLoginEnabled() {
		return this.oidcConfig.loginEnabled && isOidcCurrentAuthenticationMethod();
	}

	getCallbackUrl() {
		return `${this.urlService.getInstanceBaseUrl()}/${this.globalConfig.endpoints.rest}/sso/oidc/callback`;
	}

	/** The authorization request of a login. */
	async generateLoginUrl(): Promise<OidcAuthorizationRequest> {
		if (!this.isLoginEnabled()) throw new ForbiddenError('OIDC login is not enabled');
		return await this.buildAuthorizationRequest(await this.getConfiguration(), this.oidcConfig);
	}

	/** The authorization request of a connection test, with the stored config and a new discovery. */
	async generateTestLoginUrl(): Promise<OidcAuthorizationRequest> {
		const config = await this.loadConfig(true);
		const configuration = await this.discover(
			config.discoveryEndpoint,
			config.clientId,
			config.clientSecret,
		);
		return await this.buildAuthorizationRequest(configuration, config);
	}

	/**
	 * The user of a callback: the user of the OIDC identity, else the user with the email of the
	 * provider, else a new user. A user that the email finds gets the identity.
	 */
	async loginUser(
		callbackUrl: URL,
		expectedState: string,
		expectedNonce: string,
	): Promise<{ user: User; idToken: string | undefined }> {
		if (!this.isLoginEnabled()) throw new ForbiddenError('OIDC login is not enabled');

		const configuration = await this.getConfiguration();
		const { tokens, claims, userInfo } = await this.exchangeCode(
			configuration,
			callbackUrl,
			expectedState,
			expectedNonce,
		);

		if (!userInfo.email) throw new BadRequestError('An email is required');
		if (!isValidEmail(userInfo.email)) throw new BadRequestError('The email is not valid');

		// The roles come before the user, so that a refused sign-in changes nothing. The rules read
		// copies, so that they cannot change the values of the sign-in.
		const roles = await this.provisioningService.resolveSsoRoles({
			provider: 'oidc',
			claims,
			context: {
				$claims: structuredClone({ ...claims, ...userInfo }),
				$oidc: { idToken: structuredClone(claims), userInfo: structuredClone(userInfo) },
				$provider: 'oidc',
			},
		});
		const user = await this.findOrCreateUser(userInfo.email.toLowerCase(), claims.sub, userInfo);
		await this.provisioningService.applySsoRoles(user, roles);
		return { user, idToken: tokens.id_token };
	}

	/** The user of the OIDC identity, else the user with the email, else a new member. */
	private async findOrCreateUser(
		email: string,
		subject: string,
		userInfo: client.UserInfoResponse,
	) {
		const identity = await this.authIdentityRepository.findOne({
			where: { providerId: subject, providerType: 'oidc' },
			relations: ['user', 'user.role'],
		});
		if (identity) return identity.user;

		const existingUser = await this.userRepository.findOne({
			where: { email },
			relations: ['authIdentities', 'role'],
		});
		if (existingUser) {
			const emailVerified: unknown = userInfo.email_verified;
			const rejected = this.oidcConfig.emailVerifiedRequired
				? !isEmailVerified(emailVerified)
				: isEmailUnverified(emailVerified);
			if (rejected) {
				throw new ForbiddenError('The email of the OIDC provider is not verified');
			}
			await this.authIdentityRepository.save(AuthIdentity.create(existingUser, subject, 'oidc'));
			return existingUser;
		}

		const { user } = await this.userRepository.createUserWithProject({
			email,
			firstName: userInfo.given_name,
			lastName: userInfo.family_name,
			role: { slug: 'global:member' },
			password: OIDC_USER_PASSWORD,
		});
		await this.authIdentityRepository.save(AuthIdentity.create(user, subject, 'oidc'));
		return user;
	}

	/** The claims and the userinfo of a connection test, with the stored config and a new discovery. */
	async runConnectionTest(callbackUrl: URL, expectedState: string, expectedNonce: string) {
		const config = await this.loadConfig(true);
		const configuration = await this.discover(
			config.discoveryEndpoint,
			config.clientId,
			config.clientSecret,
		);
		const { claims, userInfo } = await this.exchangeCode(
			configuration,
			callbackUrl,
			expectedState,
			expectedNonce,
		);
		return { claims, userInfo };
	}

	/**
	 * The end session URL of the provider (RP-initiated logout), or null. It is null when the logout
	 * or the login is off, without an id token, or when a step fails.
	 */
	async getLogoutRedirectUrl(encryptedIdToken: unknown): Promise<string | null> {
		if (!this.oidcConfig.rpInitiatedLogoutEnabled || !this.isLoginEnabled()) return null;
		if (typeof encryptedIdToken !== 'string' || encryptedIdToken === '') return null;
		try {
			const idToken = await this.cipher.decryptV2(encryptedIdToken);
			if (!idToken) return null;
			const configuration = await this.getConfiguration();
			if (!configuration.serverMetadata().end_session_endpoint) return null;
			return client
				.buildEndSessionUrl(configuration, {
					id_token_hint: idToken,
					post_logout_redirect_uri: `${this.urlService.getInstanceBaseUrl()}/signin`,
				})
				.toString();
		} catch (error) {
			this.logger.warn('Cannot build the OIDC end session URL', { error });
			return null;
		}
	}

	/** Enable or disable the login. A disabled login makes email the sign-in method again. */
	private async setLoginEnabled(enabled: boolean) {
		const currentMethod = getCurrentAuthenticationMethod();
		if (enabled) assertAuthenticationMethodCanBeEnabled('oidc');
		const targetMethod = !enabled && currentMethod === 'oidc' ? 'email' : currentMethod;
		this.globalConfig.sso.oidc.loginEnabled = enabled;
		await setCurrentAuthenticationMethod(enabled ? 'oidc' : targetMethod);
	}

	/** The provider metadata of the current config, from the cache or a new discovery. */
	private async getConfiguration(): Promise<client.Configuration> {
		const now = Date.now();
		if (this.cachedConfiguration === undefined || now >= this.cachedConfiguration.validUntil) {
			const { discoveryEndpoint, clientId, clientSecret } = this.oidcConfig;
			this.cachedConfiguration = {
				configuration: this.discover(discoveryEndpoint, clientId, clientSecret),
				validUntil: now + PROVIDER_METADATA_LIFETIME,
			};
		}
		return await this.cachedConfiguration.configuration;
	}

	private async discover(discoveryEndpoint: URL, clientId: string, clientSecret: string) {
		return await client.discovery(discoveryEndpoint, clientId, clientSecret, undefined, {
			[client.customFetch]: this.customFetch,
		});
	}

	private async buildAuthorizationRequest(
		configuration: client.Configuration,
		config: OidcRuntimeConfig,
	): Promise<OidcAuthorizationRequest> {
		const state = `n8n_state:${randomUUID()}`;
		const nonce = `n8n_nonce:${randomUUID()}`;
		const scopes = ['openid email profile'];
		// The direct-claim provisioning asks for the scope of its claims, also when its name is empty.
		const provisioning = await this.provisioningService.getConfig();
		if (provisioning.scopesProvisionInstanceRole || provisioning.scopesProvisionProjectRoles) {
			scopes.push(provisioning.scopesName);
		}
		const additionalScopes = config.additionalScopes.trim();
		if (additionalScopes) scopes.push(additionalScopes);
		const url = client.buildAuthorizationUrl(configuration, {
			redirect_uri: this.getCallbackUrl(),
			response_type: 'code',
			scope: scopes.join(' '),
			prompt: config.prompt,
			state,
			nonce,
			...(config.authenticationContextClassReference.length > 0
				? { acr_values: config.authenticationContextClassReference.join(' ') }
				: {}),
		});
		return { url, state, nonce };
	}

	/** The token and userinfo requests of a callback. */
	private async exchangeCode(
		configuration: client.Configuration,
		callbackUrl: URL,
		expectedState: string,
		expectedNonce: string,
	) {
		let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
		try {
			tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
				expectedState,
				expectedNonce,
			});
		} catch (error) {
			this.logger.debug('The OIDC token request failed', { error });
			throw new BadRequestError('Invalid authorization code');
		}
		const claims = tokens.claims();
		if (!claims) throw new BadRequestError('Invalid authorization code');

		let userInfo: client.UserInfoResponse;
		try {
			userInfo = await client.fetchUserInfo(configuration, tokens.access_token, claims.sub);
		} catch (error) {
			this.logger.debug('The OIDC userinfo request failed', { error });
			throw new BadRequestError('Invalid token');
		}
		return { tokens, claims, userInfo };
	}

	private parseStoredConfig(value: string): OidcConfigDto | undefined {
		try {
			const result = OidcConfigDto.safeParse(JSON.parse(value));
			return result.success ? result.data : undefined;
		} catch {
			return undefined;
		}
	}

	private async decryptSecret(secret: string) {
		try {
			return await this.cipher.decryptV2(secret);
		} catch {
			return '';
		}
	}

	private withUrl(config: OidcConfigDto): OidcRuntimeConfig {
		return { ...config, discoveryEndpoint: new URL(config.discoveryEndpoint) };
	}
}
