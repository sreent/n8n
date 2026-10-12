import type { Readable } from 'node:stream';

import { UserError } from 'n8n-workflow';

import type { BlobMetadata, ByteStore } from './types';

/**
 * Fork code (not in upstream n8n). The fork removed the S3 and Azure Blob storage, because they
 * are enterprise code. Stand-ins with the names of the enterprise classes keep the ordinary code
 * that loads them. Each stand-in fails with {@link StorageUnavailableError}. See `../FORK.md`.
 */
export type UnavailableStorage = 'S3' | 'Azure Blob';

export class StorageUnavailableError extends UserError {
	constructor(storage: UnavailableStorage) {
		super(
			`${storage} storage is not in this build of n8n. Keep binary data and execution data in the database or on the filesystem.`,
		);
	}
}

/** A byte store that fails each operation with {@link StorageUnavailableError}. */
export abstract class UnavailableByteStore implements ByteStore {
	constructor(private readonly storage: UnavailableStorage) {}

	async write(): Promise<number> {
		throw new StorageUnavailableError(this.storage);
	}

	async read(): Promise<Buffer | null> {
		throw new StorageUnavailableError(this.storage);
	}

	async readStream(): Promise<Readable | null> {
		throw new StorageUnavailableError(this.storage);
	}

	async copy(): Promise<void> {
		throw new StorageUnavailableError(this.storage);
	}

	async rename(): Promise<void> {
		throw new StorageUnavailableError(this.storage);
	}

	async delete(): Promise<void> {
		throw new StorageUnavailableError(this.storage);
	}

	async getMetadata(): Promise<BlobMetadata | null> {
		throw new StorageUnavailableError(this.storage);
	}
}
