// Fork module (not in upstream n8n): the SAML sign-in of the instance, in place of the enterprise
// `saml.service.ee.ts`. The class keeps its name, the methods that ordinary code calls (`init`,
// `reset`, `samlPreferences`, `setSamlPreferences`, `loadFromDbAndApplySamlPreferences`,
// `fetchMetadataFromUrl`, `consumePendingTestConfig`, `handleSamlLogin` and
// `getAttributesFromLoginResponse`), and the members that ordinary tests use
// (`_samlPreferences` and `getDecryptedSigningPrivateKey`).
// packages/cli/src/modules/sso-saml/FORK.md describes it.
import type { SamlPreferences } from '@n8n/api-types';
import { isEnvFeatureEnabled, Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { UrlService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import { Time } from '@n8n/constants';
import { isValidEmail, SettingsRepository, UserRepository, type User } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { AuthError, BadRequestError, UnexpectedError } from '@n8n/errors';
import type express from 'express';
import { Cipher, InstanceSettings } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE, type IDataObject } from 'n8n-workflow';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import type { IdentityProviderInstance, ServiceProviderInstance } from 'samlify';
import type { BindingContext, PostBindingContext } from 'samlify/types/src/entity';
import type { FlowResult } from 'samlify/types/src/flow';

import { ProvisioningService } from '@/modules/provisioning/provisioning.service';
import { Publisher } from '@/scaling/pubsub/publisher.service';

import { SAML_PREFERENCES_DB_KEY } from './constants';
import { InvalidSamlMetadataUrlError } from './errors/invalid-saml-metadata-url.error';
import { InvalidSamlMetadataError } from './errors/invalid-saml-metadata.error';
import { SamlEmailNotVerifiedError } from './errors/saml-email-not-verified.error';
import {
	createUserFromSamlAttributes,
	getMappedSamlAttributesFromFlowResult,
	setSamlLoginEnabled,
	setSamlLoginLabel,
	updateUserFromSamlAttributes,
} from './saml-helpers';
import { SamlValidator } from './saml-validator';
import {
	getServiceProviderConfigTestReturnUrl,
	getServiceProviderInstance,
} from './service-provider';
import type { SamlLoginBinding, SamlUserAttributes } from './types';

/** The attribute names of the public n8n documentation. A config without a mapping uses them. */
const DEFAULT_MAPPING = {
	email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
	firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/firstname',
	lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/lastname',
	userPrincipalName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
};

const SIGNED_REQUESTS_FLAG = 'N8N_ENV_FEAT_SIGNED_SAML_REQUESTS';

/** How long the ACS accepts the callback of a connection test with metadata from its request. */
const PENDING_TEST_LIFETIME = 15 * Time.minutes.toMilliseconds;

/** A signing value of a request that replaces the stored one: not empty and not redacted. */
const isNewSigningValue = (value: string | undefined): value is string =>
	value !== undefined && value !== '' && value !== CREDENTIAL_BLANKING_VALUE;

const isDataObject = (value: unknown): value is IDataObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The parameters with a string value: samlify reads the SAML message and the relay state there. */
function stringParameters(parameters: unknown): Record<string, string> {
	if (!isDataObject(parameters)) return {};
	return Object.fromEntries(
		Object.entries(parameters).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		),
	);
}

const isPostBindingContext = (
	context: BindingContext | PostBindingContext,
): context is PostBindingContext => 'entityEndpoint' in context;

function isPrivateKey(pem: string) {
	try {
		createPrivateKey(pem);
		return true;
	} catch {
		return false;
	}
}

function isCertificate(pem: string) {
	try {
		new X509Certificate(pem);
		return true;
	} catch {
		return false;
	}
}

export type SamlLoginRequest =
	| { binding: 'redirect'; context: BindingContext }
	| { binding: 'post'; context: PostBindingContext };

export interface SamlLoginResult {
	authenticatedUser: User;
	attributes: SamlUserAttributes;
	rawAttributes: Record<string, unknown>;
}

@Service()
export class SamlService {
	/**
	 * The preferences of the instance. The login state and the label in the instance config win:
	 * the getter `samlPreferences` gives them.
	 */
	private _samlPreferences: SamlPreferences;

	/** Loaded when the service takes preferences for the first time. */
	private samlify: typeof import('samlify') | undefined;

	private identityProviderInstance: IdentityProviderInstance | undefined;

	/** The preferences of the connection tests with metadata from their request, by test id. */
	private readonly pendingTestConfigs = new Map<
		string,
		{ preferences: SamlPreferences; expiresAt: number }
	>();

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly settingsRepository: SettingsRepository,
		private readonly userRepository: UserRepository,
		private readonly validator: SamlValidator,
		private readonly cipher: Cipher,
		private readonly instanceSettings: InstanceSettings,
		private readonly publisher: Publisher,
		private readonly provisioningService: ProvisioningService,
		private readonly outboundHttp: OutboundHttp,
		urlService: UrlService,
	) {
		this._samlPreferences = {
			mapping: { ...DEFAULT_MAPPING },
			metadata: '',
			metadataUrl: '',
			ignoreSSL: false,
			loginBinding: 'redirect',
			acsBinding: 'post',
			authnRequestsSigned: false,
			loginEnabled: false,
			loginLabel: '',
			wantAssertionsSigned: true,
			wantMessageSigned: true,
			relayState: urlService.getInstanceBaseUrl(),
			signatureConfig: {
				prefix: 'ds',
				location: { reference: '/samlp:Response/saml:Issuer', action: 'after' },
			},
		};
	}

	/**
	 * Take the stored preferences. When the row is not JSON or its metadata is not valid, n8n deletes
	 * the row and turns the SAML login off, so that the instance starts.
	 */
	async init() {
		try {
			await this.loadFromDbAndApplySamlPreferences(true);
		} catch (error) {
			if (
				error instanceof SyntaxError ||
				error instanceof InvalidSamlMetadataError ||
				error instanceof InvalidSamlMetadataUrlError
			) {
				this.logger.warn('The stored SAML preferences are not valid. n8n deletes them.', {
					error,
				});
				await this.reset();
				return;
			}
			throw error;
		}
	}

	/** Turn the SAML login off, and delete the stored preferences. The preferences in memory stay. */
	async reset() {
		await setSamlLoginEnabled(false);
		await this.settingsRepository.delete({ key: SAML_PREFERENCES_DB_KEY });
	}

	get samlPreferences(): SamlPreferences {
		return {
			...this._samlPreferences,
			loginEnabled: this.globalConfig.sso.saml.loginEnabled,
			loginLabel: this.globalConfig.sso.saml.loginLabel,
		};
	}

	/**
	 * The stored preferences, or `undefined` without a row. With `apply`, the service takes them.
	 *
	 * @throws {SyntaxError} when the row is not JSON
	 */
	async loadFromDbAndApplySamlPreferences(
		apply = true,
	): Promise<Partial<SamlPreferences> | undefined> {
		const row = await this.settingsRepository.findByKey(SAML_PREFERENCES_DB_KEY);
		if (!row) return undefined;
		const stored: unknown = JSON.parse(row.value);
		if (!isDataObject(stored)) return undefined;
		const preferences: Partial<SamlPreferences> = stored;
		if (apply) await this.applyPreferences(preferences, 'store');
		return preferences;
	}

	/**
	 * Take new preferences, and store them. A field without a value keeps its value. The service
	 * takes the fields before it checks the metadata, so that a failed check leaves them in memory.
	 *
	 * @throws {BadRequestError} when the signing settings are not valid, when another sign-in method
	 * is active, or when the metadata URL fails
	 * @throws {InvalidSamlMetadataError} when the metadata is not valid
	 */
	async setSamlPreferences(preferences: Partial<SamlPreferences>): Promise<SamlPreferences> {
		await this.validateSigningSettings(preferences);
		await this.applyPreferences(preferences, 'request');
		await this.settingsRepository.upsertByKey(
			SAML_PREFERENCES_DB_KEY,
			JSON.stringify(this._samlPreferences),
			true,
			{},
		);
		if (this.instanceSettings.isMultiMain) {
			void this.publisher.publishCommand({ command: 'reload-saml-config' });
		}
		return this.samlPreferences;
	}

	/** Another main instance changed the preferences. */
	@OnPubSubEvent('reload-saml-config', { instanceType: 'main' })
	async reload() {
		try {
			await this.loadFromDbAndApplySamlPreferences(true);
		} catch (error) {
			this.logger.error('The SAML preferences changed, but n8n cannot take them', { error });
		}
	}

	/**
	 * The metadata of the URL.
	 *
	 * @throws {BadRequestError} when the request fails, or the answer is not valid metadata
	 */
	async fetchMetadataFromUrl(url: string): Promise<string> {
		await this.loadSamlify();
		let metadata: unknown;
		try {
			// The identity provider is admin-configured and may be internal.
			metadata = await this.outboundHttp.requests({ useDefaultSsrfPolicy: 'unsafe' }).request({
				url,
				method: 'GET',
				skipSslCertificateValidation: this._samlPreferences.ignoreSSL,
			});
		} catch (error) {
			throw new BadRequestError(`Error fetching SAML Metadata from ${url}: ${String(error)}`);
		}
		if (typeof metadata !== 'string' || !(await this.validator.validateMetadata(metadata))) {
			throw new BadRequestError(`Data received from ${url} is not valid SAML metadata.`);
		}
		return metadata;
	}

	/** The preferences of a connection test, once. Async, as callers await it. */
	async consumePendingTestConfig(testId: string): Promise<SamlPreferences | undefined> {
		const pending = this.pendingTestConfigs.get(testId);
		this.pendingTestConfigs.delete(testId);
		if (!pending || pending.expiresAt < Date.now()) return undefined;
		return pending.preferences;
	}

	/** The metadata of n8n as a service provider. */
	getServiceProviderMetadata() {
		return this.getServiceProviderInstance().getMetadata();
	}

	/** The login request of a sign-in. */
	getLoginRequest(relayState: string): SamlLoginRequest {
		const identityProvider = this.getIdentityProviderInstance();
		return this.createLoginRequest(
			identityProvider,
			this._samlPreferences.loginBinding,
			relayState,
		);
	}

	/**
	 * The login request of a connection test, with the login binding of the request. With metadata
	 * in the request, the test uses it without storing it: the relay state carries a test id, and
	 * the ACS gets the metadata back with the id. Without metadata, the test uses the stored
	 * metadata.
	 */
	async getTestLoginRequest(request: SamlPreferences): Promise<SamlLoginRequest> {
		const testReturnUrl = getServiceProviderConfigTestReturnUrl();
		if (!request.metadata && !request.metadataUrl) {
			const identityProvider = this.getIdentityProviderInstance();
			return this.createLoginRequest(identityProvider, request.loginBinding, testReturnUrl);
		}

		const samlify = await this.loadSamlify();
		const metadata = request.metadataUrl
			? await this.fetchMetadataFromUrl(request.metadataUrl)
			: (request.metadata ?? '');
		if (!(await this.validator.validateMetadata(metadata))) throw new InvalidSamlMetadataError();

		const now = Date.now();
		for (const [id, pending] of this.pendingTestConfigs) {
			if (pending.expiresAt < now) this.pendingTestConfigs.delete(id);
		}
		const testId = randomBytes(6).toString('hex');
		const preferences: SamlPreferences = {
			...this._samlPreferences,
			mapping: request.mapping ?? this._samlPreferences.mapping,
			loginBinding: request.loginBinding,
			metadata,
		};
		this.pendingTestConfigs.set(testId, { preferences, expiresAt: now + PENDING_TEST_LIFETIME });

		return this.createLoginRequest(
			samlify.IdentityProvider({ metadata }),
			request.loginBinding,
			`${testReturnUrl}?t=${testId}`,
		);
	}

	/**
	 * The user of a SAML response: the user of the SAML identity, else the user with the email (with
	 * the rules of email verification), else a new member. The roles of the role provisioning come
	 * before the user, so that a refused sign-in changes nothing.
	 *
	 * @throws {AuthError} when the response is not valid
	 * @throws {BadRequestError} when the email is not valid
	 * @throws {SamlEmailNotVerifiedError} when the email of an existing user is not verified
	 * @throws {SsoAccessDeniedError} when the role provisioning refuses the sign-in
	 */
	async handleSamlLogin(
		req: express.Request,
		binding: SamlLoginBinding,
		testPreferences?: SamlPreferences,
	): Promise<SamlLoginResult> {
		const { mapped: attributes, raw } = await this.getAttributesFromLoginResponse(
			req,
			binding,
			testPreferences,
		);
		const lowerCasedEmail = attributes.email.toLowerCase();
		if (!isValidEmail(lowerCasedEmail)) throw new BadRequestError('Invalid email format');

		const claims = isDataObject(raw) ? raw : {};
		const roles = await this.provisioningService.resolveSsoRoles({
			provider: 'saml',
			claims: await this.roleClaims(attributes),
			context: { $claims: claims, $saml: { attributes: claims }, $provider: 'saml' },
		});
		const user = await this.findOrCreateUser(
			attributes,
			lowerCasedEmail,
			testPreferences ?? this._samlPreferences,
		);
		await this.provisioningService.applySsoRoles(user, roles);
		return { authenticatedUser: user, attributes, rawAttributes: raw };
	}

	/**
	 * The attributes of the SAML response of a request: by the mapping, and raw.
	 *
	 * @throws {AuthError} when the response does not parse, or misses an attribute of the mapping
	 */
	async getAttributesFromLoginResponse(
		req: express.Request,
		binding: SamlLoginBinding,
		testPreferences?: SamlPreferences,
	): Promise<{ mapped: SamlUserAttributes; raw: Record<string, unknown> }> {
		const preferences = testPreferences ?? this._samlPreferences;
		let flowResult: FlowResult;
		try {
			const identityProvider = testPreferences
				? (await this.loadSamlify()).IdentityProvider({ metadata: testPreferences.metadata })
				: this.getIdentityProviderInstance();
			const serviceProvider = this.getServiceProviderInstance();
			flowResult = await serviceProvider.parseLoginResponse(identityProvider, binding, {
				query: stringParameters(req.query),
				body: stringParameters(req.body),
			});
		} catch (error) {
			throw new AuthError(
				`SAML Authentication failed. Could not parse SAML response. ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const { attributes, missingAttributes, rawAttributes } = getMappedSamlAttributesFromFlowResult(
			flowResult,
			preferences.mapping ?? DEFAULT_MAPPING,
			await this.roleClaimNames(),
		);
		if (!attributes || missingAttributes.length > 0) {
			// A response without attributes misses each attribute of the mapping.
			const { email, userPrincipalName, firstName, lastName } =
				preferences.mapping ?? DEFAULT_MAPPING;
			const missing = attributes
				? missingAttributes
				: [email, userPrincipalName, firstName, lastName];
			throw new AuthError(
				`SAML Authentication failed. Invalid SAML response (missing attributes: ${missing.join(', ')}).`,
			);
		}
		return { mapped: attributes, raw: rawAttributes };
	}

	private async findOrCreateUser(
		attributes: SamlUserAttributes,
		email: string,
		preferences: SamlPreferences,
	): Promise<User> {
		const identityUser = await this.userRepository.findOne({
			where: {
				authIdentities: { providerId: attributes.userPrincipalName, providerType: 'saml' },
			},
			relations: ['authIdentities', 'role'],
		});
		if (identityUser) return identityUser;

		const emailUser = await this.userRepository.findOne({
			where: { email },
			relations: ['authIdentities', 'role'],
		});
		if (!emailUser) return await createUserFromSamlAttributes(attributes);

		// The identity provider states the verification as `true` or `false`, in any case. Without
		// the requirement, only a `false` refuses the link.
		const verified =
			typeof attributes.emailVerified === 'string'
				? attributes.emailVerified.toLowerCase()
				: undefined;
		const refused = preferences.emailVerifiedRequired ? verified !== 'true' : verified === 'false';
		if (refused) throw new SamlEmailNotVerifiedError(email);
		return await updateUserFromSamlAttributes(emailUser, attributes);
	}

	/** The names of the role attributes that the role provisioning reads, by its config. */
	private async roleClaimNames() {
		const config = await this.provisioningService.getConfig();
		return {
			instanceRole: config.scopesProvisionInstanceRole ? config.scopesInstanceRoleClaimName : null,
			projectRoles: config.scopesProvisionProjectRoles ? config.scopesProjectsRolesClaimName : null,
		};
	}

	/** The role attributes of a sign-in, as the claims of the role provisioning. */
	private async roleClaims(attributes: SamlUserAttributes) {
		const names = await this.roleClaimNames();
		const claims: Record<string, unknown> = {};
		if (names.instanceRole) claims[names.instanceRole] = attributes.n8nInstanceRole;
		if (names.projectRoles) claims[names.projectRoles] = attributes.n8nProjectRoles;
		return claims;
	}

	/**
	 * Take preferences from a request or from the stored row. The fields come first, then the login
	 * state, then the check of the metadata. A stored signing key is encrypted already.
	 */
	private async applyPreferences(
		preferences: Partial<SamlPreferences>,
		source: 'request' | 'store',
	) {
		await this.loadSamlify();
		const current = this._samlPreferences;
		current.mapping = preferences.mapping ?? current.mapping;
		current.ignoreSSL = preferences.ignoreSSL ?? current.ignoreSSL;
		current.loginBinding = preferences.loginBinding ?? current.loginBinding;
		current.acsBinding = preferences.acsBinding ?? current.acsBinding;
		current.authnRequestsSigned = preferences.authnRequestsSigned ?? current.authnRequestsSigned;
		current.wantAssertionsSigned = preferences.wantAssertionsSigned ?? current.wantAssertionsSigned;
		current.wantMessageSigned = preferences.wantMessageSigned ?? current.wantMessageSigned;
		current.signatureConfig = preferences.signatureConfig ?? current.signatureConfig;
		current.emailVerifiedRequired =
			preferences.emailVerifiedRequired ?? current.emailVerifiedRequired;
		await this.applySigningSettings(preferences, source);
		if (preferences.loginLabel !== undefined) {
			current.loginLabel = preferences.loginLabel;
			setSamlLoginLabel(preferences.loginLabel);
		}
		if (preferences.metadataUrl) {
			current.metadataUrl = preferences.metadataUrl;
			current.metadata = await this.metadataOfUrl(preferences, source);
		} else if (preferences.metadata !== undefined) {
			current.metadataUrl = undefined;
			current.metadata = preferences.metadata;
		}
		if (preferences.loginEnabled !== undefined) {
			current.loginEnabled = preferences.loginEnabled;
			await setSamlLoginEnabled(preferences.loginEnabled);
		}

		// Metadata, or a login that is on, needs valid metadata.
		if (current.metadata || this.globalConfig.sso.saml.loginEnabled) {
			if (!(await this.validator.validateMetadata(current.metadata ?? ''))) {
				throw new InvalidSamlMetadataError();
			}
			this.getIdentityProviderInstance(true);
		}
	}

	/**
	 * The metadata of the URL of the preferences. When the URL fails for a stored row, the stored
	 * metadata serves.
	 *
	 * @throws {BadRequestError} when the URL fails for a request
	 * @throws {InvalidSamlMetadataUrlError} when the URL fails for a stored row without metadata
	 */
	private async metadataOfUrl(preferences: Partial<SamlPreferences>, source: 'request' | 'store') {
		const url = preferences.metadataUrl ?? '';
		try {
			return await this.fetchMetadataFromUrl(url);
		} catch (error) {
			if (source === 'request') throw error;
			if (!preferences.metadata) throw new InvalidSamlMetadataUrlError(url);
			this.logger.warn('The SAML metadata URL fails. n8n uses the stored metadata.', { error });
			return preferences.metadata;
		}
	}

	/** An empty value removes the stored value. A request encrypts a new private key. */
	private async applySigningSettings(
		preferences: Partial<SamlPreferences>,
		source: 'request' | 'store',
	) {
		const current = this._samlPreferences;
		const { signingPrivateKey, signingCertificate } = preferences;
		if (signingPrivateKey === '') current.signingPrivateKey = undefined;
		else if (source === 'store' && signingPrivateKey !== undefined) {
			current.signingPrivateKey = signingPrivateKey;
		} else if (isNewSigningValue(signingPrivateKey)) {
			current.signingPrivateKey = await this.cipher.encryptV2(signingPrivateKey);
		}
		if (signingCertificate === '') current.signingCertificate = undefined;
		else if (source === 'store' && signingCertificate !== undefined) {
			current.signingCertificate = signingCertificate;
		} else if (isNewSigningValue(signingCertificate)) {
			current.signingCertificate = signingCertificate;
		}
	}

	/**
	 * The signing settings of a request. A new key or certificate needs the environment flag. A
	 * request that signs needs a key and a certificate that match.
	 *
	 * @throws {BadRequestError}
	 */
	private async validateSigningSettings(preferences: Partial<SamlPreferences>) {
		const newKey = isNewSigningValue(preferences.signingPrivateKey)
			? preferences.signingPrivateKey
			: undefined;
		const newCertificate = isNewSigningValue(preferences.signingCertificate)
			? preferences.signingCertificate
			: undefined;

		if (!isEnvFeatureEnabled(SIGNED_REQUESTS_FLAG)) {
			if (newKey !== undefined || newCertificate !== undefined) {
				throw new BadRequestError(
					`SAML request signing is not enabled. Set ${SIGNED_REQUESTS_FLAG}=true to enable this feature.`,
				);
			}
			return;
		}

		if (newKey !== undefined && !isPrivateKey(newKey)) {
			throw new BadRequestError(
				'Invalid signing private key format. Must be a PEM-encoded private key.',
			);
		}
		if (newCertificate !== undefined && !isCertificate(newCertificate)) {
			throw new BadRequestError(
				'Invalid signing certificate format. Must be a PEM-encoded certificate.',
			);
		}
		if (!(preferences.authnRequestsSigned ?? this._samlPreferences.authnRequestsSigned)) return;

		const key =
			preferences.signingPrivateKey === ''
				? undefined
				: (newKey ?? (await this.getDecryptedSigningPrivateKey()));
		const certificate =
			preferences.signingCertificate === ''
				? undefined
				: (newCertificate ?? this._samlPreferences.signingCertificate);
		if (!key || !certificate) {
			throw new BadRequestError(
				'Both signingPrivateKey and signingCertificate are required when authnRequestsSigned is enabled.',
			);
		}
		if (!new X509Certificate(certificate).checkPrivateKey(createPrivateKey(key))) {
			throw new BadRequestError(
				'The signing private key and certificate do not match. Please provide a matching key/certificate pair.',
			);
		}
	}

	/** The signing key of the preferences in memory, decrypted. */
	private async getDecryptedSigningPrivateKey(): Promise<string | undefined> {
		const encrypted = this._samlPreferences.signingPrivateKey;
		if (!encrypted) return undefined;
		return await this.cipher.decryptV2(encrypted);
	}

	/**
	 * The identity provider of the stored metadata. `forceRecreate` makes it again from the
	 * metadata in memory.
	 *
	 * @throws {InvalidSamlMetadataError} without metadata
	 */
	private getIdentityProviderInstance(forceRecreate = false): IdentityProviderInstance {
		const { metadata } = this._samlPreferences;
		if (!metadata) {
			throw new InvalidSamlMetadataError(
				'No IdP metadata configured. Please provide valid identity provider metadata.',
			);
		}
		if (!this.samlify) throw new UnexpectedError('Samlify is not initialized');
		if (!this.identityProviderInstance || forceRecreate) {
			this.identityProviderInstance = this.samlify.IdentityProvider({ metadata });
		}
		return this.identityProviderInstance;
	}

	private getServiceProviderInstance(): ServiceProviderInstance {
		if (!this.samlify) throw new UnexpectedError('Samlify is not initialized');
		return getServiceProviderInstance(this._samlPreferences, this.samlify);
	}

	private createLoginRequest(
		identityProvider: IdentityProviderInstance,
		binding: SamlLoginBinding,
		relayState: string,
	): SamlLoginRequest {
		const serviceProvider = this.getServiceProviderInstance();
		const context = serviceProvider.createLoginRequest(identityProvider, binding, { relayState });
		if (binding === 'post' && isPostBindingContext(context)) return { binding: 'post', context };
		return { binding: 'redirect', context };
	}

	/**
	 * Load samlify and the validator. samlify checks each SAML response against the schema of the
	 * validator: a response that is not valid gives an `InvalidSamlMetadataError`.
	 */
	private async loadSamlify() {
		if (this.samlify) return this.samlify;
		const samlify = await import('samlify');
		await this.validator.init();
		samlify.setSchemaValidator({
			validate: async (response: string) => {
				if (await this.validator.validateResponse(response)) return 'SUCCESS_VALIDATE_XML';
				throw new InvalidSamlMetadataError();
			},
		});
		this.samlify = samlify;
		return samlify;
	}
}
