import type { CredentialResolverHandle } from '@n8n/decorators';
import { Service } from '@n8n/di';

import type { ICredentialEntriesStorage, StorageOptions } from './storage-interface';
import { DynamicCredentialEntryRepository } from '../../database/repositories/dynamic-credential-entry.repository';

/** Stores the data of private credentials for the subjects of external identity providers. */
@Service()
export class DynamicCredentialEntryStorage implements ICredentialEntriesStorage {
	constructor(private readonly repository: DynamicCredentialEntryRepository) {}

	async getCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		_storageOptions: StorageOptions,
	) {
		return await this.repository.findData(credentialId, subjectId, resolverId);
	}

	async setCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		data: string,
		_storageOptions: StorageOptions,
	) {
		await this.repository.saveData(credentialId, subjectId, resolverId, data);
	}

	async deleteCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		_storageOptions: StorageOptions,
	) {
		await this.repository.deleteData(credentialId, subjectId, resolverId);
	}

	async deleteAllCredentialData(handle: CredentialResolverHandle) {
		await this.repository.deleteAllOfResolver(handle.resolverId);
	}
}
