import {
	CredentialResolver,
	CredentialResolverValidationError,
	type CredentialResolverConfiguration,
	type CredentialResolverHandle,
	type CredentialResolverMetadata,
	type ICredentialResolver,
} from '@n8n/decorators';
import { Cipher } from 'n8n-core';
import type { ICredentialContext, ICredentialDataDecryptedObject } from 'n8n-workflow';

import { SlackSignatureIdentifier } from './identifiers/slack-signature-identifier';
import { slackResolverOptionsSchema } from './oauth-options';
import { decryptData, encryptData } from './resolver-data';
import { DynamicCredentialEntryStorage } from './storage/dynamic-credential-entry-storage';

/**
 * Resolves private credentials for the users of a Slack app. A request carries the Slack
 * signature, which the resolver verifies with the signing secret of the app.
 */
@CredentialResolver()
export class SlackCredentialResolver implements ICredentialResolver {
	metadata: CredentialResolverMetadata = {
		name: 'credential-resolver.slack-1.0',
		displayName: 'Slack Resolver',
		description: 'Slack-based credential resolver using request signatures',
		options: [
			{
				displayName: 'Slack Signing Secret',
				name: 'signingSecret',
				type: 'string',
				typeOptions: { password: true },
				required: true,
				default: '',
				description:
					'The signing secret from your Slack App (Basic Information → App Credentials → Signing Secret)',
			},
			{
				displayName: 'Subject Claim',
				name: 'subjectClaim',
				type: 'options',
				options: [
					{
						name: 'User ID',
						value: 'user_id',
						description: 'Use Slack user ID as the unique credential key',
					},
					{
						name: 'Team ID + User ID',
						value: 'team_user',
						description:
							'Use team_id:user_id as the key (recommended for Enterprise Grid / multi-workspace)',
					},
				],
				default: 'user_id',
				description: 'How to identify unique credential holders',
			},
		],
	};

	constructor(
		private readonly identifier: SlackSignatureIdentifier,
		private readonly storage: DynamicCredentialEntryStorage,
		private readonly cipher: Cipher,
	) {}

	private async subjectOf(context: ICredentialContext, handle: CredentialResolverHandle) {
		return await this.identifier.resolve(context, handle.configuration);
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
		// The store needs no new check of the signature, see `SlackSignatureIdentifier.resolveKey`.
		const subject = this.identifier.resolveKey(context, handle.configuration);
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

	async validateOptions(options: CredentialResolverConfiguration) {
		const result = slackResolverOptionsSchema.safeParse(options);
		if (!result.success) {
			throw new CredentialResolverValidationError(
				`Invalid options for SlackCredentialResolver: ${result.error.message}`,
			);
		}
	}
}
