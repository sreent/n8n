import { PassThrough, pipeline } from 'node:stream';
import type { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';

import type { ObjectStoreService } from './object-store/object-store.service';
import { assertChunkSize, createFixedSizeChunker } from './stream-utils';
import type { ByteStore, ByteStoreKey, PreWriteBlobMetadata } from './types';

/**
 * Fork code (not in upstream n8n): the byte store of the S3 storage, in place of the enterprise
 * `s3-byte-store.ee.ts`. S3 keeps the file name and the MIME type as object metadata. It has no
 * `deletePrefix`: a lifecycle rule of the bucket deletes old data. See `../FORK.md`.
 */
export class S3ByteStore implements ByteStore {
	constructor(private readonly objectStoreService: ObjectStoreService) {}

	/** Reads a stream to its end before the upload, because S3 needs the size and the MD5 hash. */
	async write(key: ByteStoreKey, body: Buffer | Readable, metadata?: PreWriteBlobMetadata) {
		const buffer = Buffer.isBuffer(body) ? body : await readAll(body);
		await this.objectStoreService.put(key, buffer, metadata);
		return buffer.length;
	}

	async read(key: ByteStoreKey) {
		try {
			return await this.objectStoreService.getBuffer(key);
		} catch (error) {
			if (this.objectStoreService.isMissingObject(error)) return null;
			throw error;
		}
	}

	async readStream(key: ByteStoreKey, { chunkSize }: { chunkSize?: number } = {}) {
		if (chunkSize !== undefined) assertChunkSize(chunkSize);
		let source: Readable;
		try {
			source = await this.objectStoreService.getStream(key);
		} catch (error) {
			if (this.objectStoreService.isMissingObject(error)) return null;
			throw error;
		}
		const target = chunkSize === undefined ? new PassThrough() : createFixedSizeChunker(chunkSize);
		// `pipeline` passes an error of the download on to the reader of `target`.
		pipeline(source, target, () => {});
		return target;
	}

	/** Downloads the object and uploads it again with its file name and MIME type. */
	async copy(sourceKey: ByteStoreKey, targetKey: ByteStoreKey) {
		const buffer = await this.objectStoreService.getBuffer(sourceKey);
		const metadata = await this.objectStoreService.getMetadata(sourceKey);
		await this.objectStoreService.put(targetKey, buffer, {
			fileName: metadata?.fileName,
			mimeType: metadata?.mimeType,
		});
	}

	async rename(oldKey: ByteStoreKey, newKey: ByteStoreKey) {
		if (oldKey === newKey) return;
		await this.copy(oldKey, newKey);
		await this.objectStoreService.deleteOne(oldKey);
	}

	async delete(keys: ByteStoreKey[]) {
		if (keys.length === 0) return;
		await this.objectStoreService.deleteMany(keys);
	}

	async getMetadata(key: ByteStoreKey) {
		return await this.objectStoreService.getMetadata(key);
	}
}
