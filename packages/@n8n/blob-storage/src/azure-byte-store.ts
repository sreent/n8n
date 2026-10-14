import { PassThrough, pipeline } from 'node:stream';
import type { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';

import type { AzureBlobService } from './azure-blob/azure-blob.service';
import { assertChunkSize, createFixedSizeChunker } from './stream-utils';
import type { ByteStore, ByteStoreKey, PreWriteBlobMetadata } from './types';

/**
 * Fork code (not in upstream n8n): the byte store of the Azure Blob storage, in place of the
 * enterprise `azure-byte-store.ee.ts`. Azure keeps the MIME type as the content type and the file
 * name as blob metadata. It has no `deletePrefix`: a lifecycle policy of the container deletes old
 * data. See `../FORK.md`.
 */
export class AzureByteStore implements ByteStore {
	constructor(private readonly azureBlobService: AzureBlobService) {}

	/** Reads a stream to its end before the upload, as the S3 store does. */
	async write(key: ByteStoreKey, body: Buffer | Readable, metadata?: PreWriteBlobMetadata) {
		const buffer = Buffer.isBuffer(body) ? body : await readAll(body);
		await this.azureBlobService.put(key, buffer, metadata);
		return buffer.length;
	}

	/** `null` for a missing blob. The enterprise store failed here: see `../FORK.md`. */
	async read(key: ByteStoreKey) {
		try {
			return await this.azureBlobService.getBuffer(key);
		} catch (error) {
			if (this.azureBlobService.isMissingBlob(error)) return null;
			throw error;
		}
	}

	async readStream(key: ByteStoreKey, { chunkSize }: { chunkSize?: number } = {}) {
		if (chunkSize !== undefined) assertChunkSize(chunkSize);
		let source: Readable;
		try {
			source = await this.azureBlobService.getStream(key);
		} catch (error) {
			if (this.azureBlobService.isMissingBlob(error)) return null;
			throw error;
		}
		const target = chunkSize === undefined ? new PassThrough() : createFixedSizeChunker(chunkSize);
		// `pipeline` passes an error of the download on to the reader of `target`.
		pipeline(source, target, () => {});
		return target;
	}

	/** Downloads the blob and uploads it again with its file name and MIME type. */
	async copy(sourceKey: ByteStoreKey, targetKey: ByteStoreKey) {
		const buffer = await this.azureBlobService.getBuffer(sourceKey);
		const metadata = await this.azureBlobService.getMetadata(sourceKey);
		await this.azureBlobService.put(targetKey, buffer, {
			fileName: metadata.fileName,
			mimeType: metadata.mimeType,
		});
	}

	async rename(oldKey: ByteStoreKey, newKey: ByteStoreKey) {
		if (oldKey === newKey) return;
		await this.copy(oldKey, newKey);
		await this.azureBlobService.deleteOne(oldKey);
	}

	async delete(keys: ByteStoreKey[]) {
		await this.azureBlobService.deleteMany(keys);
	}

	/** `null` for a missing blob. The enterprise store failed here: see `../FORK.md`. */
	async getMetadata(key: ByteStoreKey) {
		try {
			return await this.azureBlobService.getMetadata(key);
		} catch (error) {
			if (this.azureBlobService.isMissingBlob(error)) return null;
			throw error;
		}
	}
}
