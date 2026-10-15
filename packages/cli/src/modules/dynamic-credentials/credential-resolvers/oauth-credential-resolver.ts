import {
	CredentialResolver,
	CredentialResolverError,
	CredentialResolverValidationError,
	type CredentialResolverConfiguration,
	type CredentialResolverHandle,
	type CredentialResolverMetadata,
	type ICredentialResolver,
} from '@n8n/decorators';
import { Cipher } from 'n8n-core';
import type { ICredentialContext, ICredentialDataDecryptedObject } from 'n8n-workflow';

import type { ITokenIdentifier } from './identifiers/identifier-interface';
import { OAuth2IntrospectionIdentifier } from './identifiers/oauth2-introspection-identifier';
import { OAuth2MetadataHttpClient } from './identifiers/oauth2-metadata-http-client';
import { OAuth2UserInfoIdentifier } from './identifiers/oauth2-userinfo-identifier';
import { oauthResolverOptionsSchema } from './oauth-options';
import { decryptData, encryptData } from './resolver-data';
import { DynamicCredentialEntryStorage } from './storage/dynamic-credential-entry-storage';

/**
 * Resolves private credentials for the subjects of an OAuth2 or OpenID Connect identity
 * provider. A request carries the access token of the user. The resolver validates it at the
 * introspection endpoint or the userinfo endpoint of the provider.
 */
@CredentialResolver()
export class OAuthCredentialResolver implements ICredentialResolver {
	metadata: CredentialResolverMetadata = {
		name: 'credential-resolver.oauth2-1.0',
		displayName: 'OAuth2 Resolver',
		description: 'OAuth2 based credential resolver',
		options: [
			{
				displayName: 'Metadata URL',
				name: 'metadataUri',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://auth.example.com/.well-known/openid-configuration',
				description: 'OAuth2 server metadata endpoint URL',
			},
			{
				displayName: 'Validation Method',
				name: 'validation',
				type: 'options',
				options: [
					{
						name: 'OAuth2 Token Introspection',
						value: 'oauth2-introspection',
						description: 'Validate token via OAuth2 Token Introspection Endpoint',
					},
					{
						name: 'OAuth2 UserInfo Endpoint',
						value: 'oauth2-userinfo',
						description: 'Validate token via OAuth2 UserInfo Endpoint',
					},
				],
				default: 'oauth2-introspection',
				description: 'Validation method to use for token validation',
			},
			{
				displayName: 'Client ID',
				name: 'clientId',
				type: 'string',
				default: '',
				description: 'OAuth2 client ID for introspection',
				displayOptions: {
					hide: { validation: ['oauth2-userinfo'] },
					show: { validation: ['oauth2-introspection'] },
				},
			},
			{
				displayName: 'Client Secret',
				name: 'clientSecret',
				type: 'string',
				default: '',
				typeOptions: { password: true },
				description: 'OAuth2 client secret for introspection',
				displayOptions: {
					hide: { validation: ['oauth2-userinfo'] },
					show: { validation: ['oauth2-introspection'] },
				},
			},
			{
				displayName: 'Expected Audience',
				name: 'expectedAudience',
				type: 'string',
				default: '',
				placeholder: 'https://api.example.com',
				description:
					'Value the access token must carry in its aud claim, identifying this n8n instance as the intended recipient. Leave empty to skip the check. This is not the Client ID: configure your provider to issue an audience for n8n if it does not already.',
			},
			{
				displayName: 'Subject Claim',
				name: 'subjectClaim',
				type: 'string',
				default: 'sub',
				description: 'Token claim to use as subject identifier',
			},
		],
	};

	constructor(
		private readonly introspection: OAuth2IntrospectionIdentifier,
		private readonly userInfo: OAuth2UserInfoIdentifier,
		private readonly http: OAuth2MetadataHttpClient,
		private readonly storage: DynamicCredentialEntryStorage,
		private readonly cipher: Cipher,
	) {}

	private identifierFor(configuration: CredentialResolverConfiguration): ITokenIdentifier {
		return configuration.validation === 'oauth2-userinfo' ? this.userInfo : this.introspection;
	}

	private async subjectOf(context: ICredentialContext, handle: CredentialResolverHandle) {
		return await this.identifierFor(handle.configuration).resolve(context, handle.configuration);
	}

	async getSecret(
		credentialId: string,
		context: ICredentialContext,
		handle: CredentialResolverHandle,
	) {
		const subject = await this.subjectOf(context, handle);
		const stored = await this.storage.getCredentialData(
			credentialId,
			subject,
			handle.resolverId,
			{},
		);
		return await decryptData(this.cipher, stored);
	}

	async setSecret(
		credentialId: string,
		context: ICredentialContext,
		data: ICredentialDataDecryptedObject,
		handle: CredentialResolverHandle,
	) {
		const subject = await this.subjectOf(context, handle);
		await this.storage.setCredentialData(
			credentialId,
			subject,
			handle.resolverId,
			await encryptData(this.cipher, data),
			{},
		);
	}

	async deleteSecret(
		credentialId: string,
		context: ICredentialContext,
		handle: CredentialResolverHandle,
	) {
		const subject = await this.subjectOf(context, handle);
		await this.storage.deleteCredentialData(credentialId, subject, handle.resolverId, {});
	}

	async deleteAllSecrets(handle: CredentialResolverHandle) {
		await this.storage.deleteAllCredentialData(handle);
	}

	async validateIdentity(context: ICredentialContext, handle: CredentialResolverHandle) {
		await this.subjectOf(context, handle);
	}

	/** Checks the options, then reads the metadata document and checks its endpoint. */
	async validateOptions(options: CredentialResolverConfiguration) {
		const result = oauthResolverOptionsSchema.safeParse(options);
		if (!result.success) {
			throw new CredentialResolverValidationError(
				`Invalid options for OAuthCredentialResolver: ${result.error.message}`,
			);
		}
		const metadata = this.http.parseMetadata(
			await this.http.fetchMetadata(result.data.metadataUri),
		);
		const endpoint =
			result.data.validation === 'oauth2-introspection'
				? metadata.introspection_endpoint
				: metadata.userinfo_endpoint;
		if (!endpoint) throw new CredentialResolverError('Invalid OAuth2 metadata format');
	}
}
