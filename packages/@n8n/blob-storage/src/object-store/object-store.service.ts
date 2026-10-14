import type { PutObjectCommandInput, S3ClientConfig } from '@aws-sdk/client-s3';
import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	NoSuchKey,
	NotFound,
	PutObjectCommand,
	S3Client,
	S3ServiceException,
} from '@aws-sdk/client-s3';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { UnexpectedError } from 'n8n-workflow';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { BlobMetadata, PreWriteBlobMetadata } from '../types';
import { ObjectStoreConfig } from './object-store.config';

/** The most keys that one multi-object delete of S3 takes. */
const DELETE_BATCH_SIZE = 1000;

/** The most failed keys that the error of a multi-object delete names. */
const NAMED_DELETE_ERRORS = 5;

/** A HEAD request has no body, so S3 gives no error code: a 404 status means a missing object. */
const isNotFound = (error: unknown) =>
	error instanceof NotFound ||
	(error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404);

/**
 * Fork code (not in upstream n8n): the S3 client of the external storage, in place of the
 * enterprise `object-store.service.ee.ts`. It keeps binary data and execution data in an S3 bucket,
 * or in a bucket of a service with the S3 API. `S3ByteStore` gives its operations to ordinary code.
 * See `../../FORK.md`.
 */
@Service()
export class ObjectStoreService {
	private readonly s3Client: S3Client;

	private readonly bucket: string;

	/** `undefined` when no host is set: the client uses the endpoint of AWS for the region. */
	private readonly endpoint: string | undefined;

	private isReady = false;

	constructor(
		private readonly logger: Logger,
		private readonly config: ObjectStoreConfig,
	) {
		const { host, protocol, forcePathStyle, maxAttempts, bucket, credentials } = config;
		this.bucket = bucket.name;
		this.endpoint = host ? `${protocol}://${host}` : undefined;

		const clientConfig: S3ClientConfig = {
			// An empty region lets the SDK read AWS_REGION.
			region: bucket.region || undefined,
			maxAttempts,
			...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle } : {}),
		};
		// Auto-detection uses the default credential chain of the SDK.
		if (!credentials.authAutoDetect) {
			clientConfig.credentials = {
				accessKeyId: credentials.accessKey,
				secretAccessKey: credentials.accessSecret,
			};
		}
		this.s3Client = new S3Client(clientConfig);
	}

	/** Logs the configuration, and checks the bucket once. */
	async init() {
		const { bucket, forcePathStyle } = this.config;
		this.logger.info(
			`S3 binary storage configured: endpoint=${this.endpoint ?? 'default'}, bucket=${this.bucket}, region=${bucket.region || 'none'}, forcePathStyle=${forcePathStyle}`,
		);
		if (this.isReady) return;
		await this.checkConnection();
		this.isReady = true;
	}

	/** Uploads `buffer`, with the file name and the MIME type as object metadata. */
	async put(key: string, buffer: Buffer, metadata: PreWriteBlobMetadata = {}) {
		const params: PutObjectCommandInput = {
			Bucket: this.bucket,
			Key: key,
			ContentLength: buffer.length,
			ContentMD5: createHash('md5').update(buffer).digest('base64'),
		};
		if (metadata.fileName) params.Metadata = { filename: encodeURIComponent(metadata.fileName) };
		// An empty MIME type leaves the default of the SDK.
		const contentType = metadata.mimeType ?? 'application/octet-stream';
		if (contentType) params.ContentType = contentType;

		this.logger.debug('Sending PUT request to S3', { params });
		try {
			await this.s3Client.send(new PutObjectCommand({ ...params, Body: buffer }));
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** The content of an object. A missing object is an error. */
	async getBuffer(key: string): Promise<Buffer> {
		this.logger.debug('Sending GET request to S3', { bucket: this.bucket, key });
		try {
			const response = await this.s3Client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key }),
			);
			if (!response.Body) throw new UnexpectedError('S3 returned no body');
			return Buffer.from(await response.Body.transformToByteArray());
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** The content of an object as a stream. A missing object is an error. */
	async getStream(key: string): Promise<Readable> {
		this.logger.debug('Sending GET request to S3', { bucket: this.bucket, key });
		try {
			const response = await this.s3Client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key }),
			);
			if (!(response.Body instanceof Readable)) throw new UnexpectedError('S3 returned no stream');
			return response.Body;
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** The size, the MIME type and the file name of an object, or `null` when it is missing. */
	async getMetadata(key: string): Promise<BlobMetadata | null> {
		this.logger.debug('Sending HEAD request to S3', { bucket: this.bucket, key });
		try {
			const response = await this.s3Client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
			);
			const metadata: BlobMetadata = { fileSize: response.ContentLength ?? 0 };
			if (response.ContentType) metadata.mimeType = response.ContentType;
			const fileName = response.Metadata?.filename;
			if (fileName) metadata.fileName = decodeURIComponent(fileName);
			return metadata;
		} catch (error) {
			if (isNotFound(error)) return null;
			throw this.requestFailed(error);
		}
	}

	async deleteOne(key: string) {
		this.logger.debug('Sending DELETE request to S3', { bucket: this.bucket, key });
		try {
			await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** Deletes the keys in batches of 1000, one batch after the other. Stops at a failed batch. */
	async deleteMany(keys: string[]) {
		for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
			const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
			this.logger.debug('Sending DELETE MANY request to S3', {
				bucket: this.bucket,
				objectCount: batch.length,
			});
			try {
				const response = await this.s3Client.send(
					new DeleteObjectsCommand({
						Bucket: this.bucket,
						Delete: { Objects: batch.map((Key) => ({ Key })) },
					}),
				);
				const errors = response.Errors ?? [];
				if (errors.length > 0) {
					this.logger.error('Failed to delete objects from S3', {
						bucket: this.bucket,
						failures: errors.map((entry) => ({
							key: entry.Key,
							code: entry.Code,
							message: entry.Message,
						})),
					});
					const named = errors
						.slice(0, NAMED_DELETE_ERRORS)
						.map((entry) => `${entry.Key} (${entry.Code}: ${entry.Message})`)
						.join(', ');
					throw new UnexpectedError(
						`Failed to delete ${errors.length} of ${batch.length} objects: ${named}`,
					);
				}
			} catch (error) {
				throw this.requestFailed(error);
			}
		}
	}

	/** Whether a failed request of this service was for a missing object. */
	isMissingObject(error: unknown) {
		return error instanceof UnexpectedError && error.cause instanceof NoSuchKey;
	}

	private async checkConnection() {
		this.logger.debug('Checking connection to S3 bucket', {
			bucket: this.bucket,
			endpoint: this.endpoint,
		});
		const { startupTimeoutMs } = this.config;
		try {
			await this.s3Client.send(
				new HeadBucketCommand({ Bucket: this.bucket }),
				startupTimeoutMs > 0 ? { abortSignal: AbortSignal.timeout(startupTimeoutMs) } : {},
			);
		} catch (error) {
			const message = `Failed to connect to S3 at ${this.endpoint ?? 'the default S3 endpoint'} (bucket: ${this.bucket}): ${ensureError(error).message}. Check that N8N_EXTERNAL_STORAGE_S3_HOST includes the port, that N8N_EXTERNAL_STORAGE_S3_PROTOCOL matches the endpoint, and that the endpoint is reachable.`;
			this.logger.error(message);
			throw new UnexpectedError(message, { cause: error });
		}
	}

	private requestFailed(error: unknown) {
		return new UnexpectedError(`Request to S3 failed: ${ensureError(error).message}`, {
			cause: error,
		});
	}
}
