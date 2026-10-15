import type { CredentialResolverHandle } from '@n8n/decorators';

/** Options of a storage call. No storage uses them yet. */
export type StorageOptions = Record<string, unknown>;

/**
 * A store of the data of private credentials, keyed by the credential, a subject (an external
 * subject or an n8n user) and the resolver. The data is a string that the caller encrypted.
 */
export interface ICredentialEntriesStorage {
	getCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		storageOptions: StorageOptions,
	): Promise<string | null>;

	setCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		data: string,
		storageOptions: StorageOptions,
	): Promise<void>;

	deleteCredentialData(
		credentialId: string,
		subjectId: string,
		resolverId: string,
		storageOptions: StorageOptions,
	): Promise<void>;

	/** Deletes the data of all subjects of the resolver of the handle. */
	deleteAllCredentialData(handle: CredentialResolverHandle): Promise<void>;
}
