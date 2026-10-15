import type { CredentialResolverHandle } from '@n8n/decorators';
import { Service } from '@n8n/di';

import type { ICredentialEntriesStorage, StorageOptions } from './storage-interface';
import { DynamicCredentialUserEntryRepository } from '../../database/repositories/dynamic-credential-user-entry.repository';

/** Stores the data of private credentials for n8n users. The subject is the id of the user. */
@Service()
export class DynamicCredentialUserEntryStorage implements ICredentialEntriesStorage {
	constructor(private readonly repository: DynamicCredentialUserEntryRepository) {}

	async getCredentialData(
		credentialId: string,
		userId: string,
		resolverId: string,
		_storageOptions: StorageOptions,
	) {
		return await this.repository.findData(credentialId, userId, resolverId);
	}

	async setCredentialData(
		credentialId: string,
		userId: string,
		resolverId: string,
		data: string,
		_storageOptions: StorageOptions,
	) {
		await this.repository.saveData(credentialId, userId, resolverId, data);
	}

	async deleteCredentialData(
		credentialId: string,
		userId: string,
		resolverId: string,
		_storageOptions: StorageOptions,
	) {
		await this.repository.deleteData(credentialId, userId, resolverId);
	}

	async deleteAllCredentialData(handle: CredentialResolverHandle) {
		await this.repository.deleteAllOfResolver(handle.resolverId);
	}
}
