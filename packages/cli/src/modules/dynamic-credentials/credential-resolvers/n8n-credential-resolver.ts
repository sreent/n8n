import {
	CredentialResolver,
	type CredentialResolverHandle,
	type CredentialResolverMetadata,
	type ICredentialResolver,
} from '@n8n/decorators';
import { Cipher } from 'n8n-core';
import type { ICredentialContext, ICredentialDataDecryptedObject } from 'n8n-workflow';

import { N8NIdentifier } from './identifiers/n8n-identifier';
import { decryptData, encryptData } from './resolver-data';
import { DynamicCredentialUserEntryStorage } from './storage/dynamic-credential-user-entry-storage';
import { SYSTEM_RESOLVER_TYPE } from '../constants';

/**
 * The system resolver: it stores the data of a private credential for each n8n user, and
 * resolves it for the user who runs the workflow.
 */
@CredentialResolver()
export class N8NCredentialResolver implements ICredentialResolver {
	metadata: CredentialResolverMetadata = {
		name: SYSTEM_RESOLVER_TYPE,
		displayName: 'n8n Resolver',
		description: 'Resolves private credentials for the n8n user who runs the workflow',
	};

	constructor(
		private readonly identifier: N8NIdentifier,
		private readonly storage: DynamicCredentialUserEntryStorage,
		private readonly cipher: Cipher,
	) {}

	async getSecret(
		credentialId: string,
		context: ICredentialContext,
		handle: CredentialResolverHandle,
		executionId?: string,
	) {
		const userId = await this.identifier.resolve(context, {}, executionId);
		const stored = await this.storage.getCredentialData(
			credentialId,
			userId,
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
		executionId?: string,
	) {
		const userId = await this.identifier.resolve(context, {}, executionId);
		await this.storage.setCredentialData(
			credentialId,
			userId,
			handle.resolverId,
			await encryptData(this.cipher, data),
			{},
		);
	}

	async deleteSecret(
		credentialId: string,
		context: ICredentialContext,
		handle: CredentialResolverHandle,
		executionId?: string,
	) {
		const userId = await this.identifier.resolve(context, {}, executionId);
		await this.storage.deleteCredentialData(credentialId, userId, handle.resolverId, {});
	}

	async deleteAllSecrets(handle: CredentialResolverHandle) {
		await this.storage.deleteAllCredentialData(handle);
	}

	async resolveOwningUserId(
		context: ICredentialContext,
		_handle: CredentialResolverHandle,
		executionId?: string,
	) {
		return await this.identifier.resolve(context, {}, executionId);
	}

	async validateIdentity(
		context: ICredentialContext,
		_handle: CredentialResolverHandle,
		executionId?: string,
	) {
		await this.identifier.resolve(context, {}, executionId);
	}

	/** The system resolver has no options. */
	async validateOptions() {}
}
