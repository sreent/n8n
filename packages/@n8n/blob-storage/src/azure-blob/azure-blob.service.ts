import { DefaultAzureCredential } from '@azure/identity';
import type { ContainerClient } from '@azure/storage-blob';
import { BlobServiceClient, RestError, StorageSharedKeyCredential } from '@azure/storage-blob';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { UnexpectedError, UserError } from 'n8n-workflow';
import { Readable } from 'node:stream';

import type { BlobMetadata, PreWriteBlobMetadata } from '../types';
import { AzureBlobConfig } from './azure-blob.config';

/**
 * Fork code (not in upstream n8n): the Azure Blob client of the external storage, in place of the
 * enterprise `azure-blob.service.ee.ts`. It keeps binary data and execution data in a blob
 * container. `AzureByteStore` gives its operations to ordinary code. See `../../FORK.md`.
 */
@Service()
export class AzureBlobService {
	private client: ContainerClient | undefined;

	private isReady = false;

	constructor(
		private readonly logger: Logger,
		private readonly config: AzureBlobConfig,
	) {}

	/** Connects to the container once. */
	async init() {
		if (this.isReady) return;
		const { containerName } = this.config;
		if (!containerName) {
			throw new UserError(
				'Azure Blob container name not configured. Please set `N8N_EXTERNAL_STORAGE_AZURE_CONTAINER_NAME`.',
			);
		}
		this.client = this.createServiceClient().getContainerClient(containerName);
		await this.checkConnection(this.client);
		this.isReady = true;
	}

	/** Uploads `buffer`, with the MIME type as the content type and the file name as metadata. */
	async put(key: string, buffer: Buffer, metadata: PreWriteBlobMetadata = {}) {
		try {
			await this.container.getBlockBlobClient(key).upload(buffer, buffer.length, {
				blobHTTPHeaders: { blobContentType: metadata.mimeType ?? 'application/octet-stream' },
				metadata: metadata.fileName
					? { filename: encodeURIComponent(metadata.fileName) }
					: undefined,
			});
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** The content of a blob. A missing blob is an error. */
	async getBuffer(key: string): Promise<Buffer> {
		try {
			return await this.container.getBlobClient(key).downloadToBuffer();
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** The content of a blob as a stream. A missing blob is an error. */
	async getStream(key: string): Promise<Readable> {
		try {
			const body = (await this.container.getBlobClient(key).download()).readableStreamBody;
			if (!(body instanceof Readable)) {
				throw new UnexpectedError('Azure Blob storage returned no stream');
			}
			return body;
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** The size, the MIME type and the file name of a blob. A missing blob is an error. */
	async getMetadata(key: string): Promise<BlobMetadata> {
		try {
			const properties = await this.container.getBlobClient(key).getProperties();
			const metadata: BlobMetadata = { fileSize: properties.contentLength ?? 0 };
			if (properties.contentType) metadata.mimeType = properties.contentType;
			const fileName = properties.metadata?.filename;
			if (fileName) metadata.fileName = decodeURIComponent(fileName);
			return metadata;
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/** Deletes the blobs at the same time. A missing blob is no error. */
	async deleteMany(keys: string[]) {
		await Promise.all(keys.map(async (key) => await this.deleteOne(key)));
	}

	async deleteOne(key: string) {
		try {
			await this.container.getBlobClient(key).deleteIfExists();
		} catch (error) {
			throw this.requestFailed(error);
		}
	}

	/**
	 * Whether a failed request of this service was for a missing blob. A HEAD request has no body,
	 * so the code of the error comes from the `x-ms-error-code` header.
	 */
	isMissingBlob(error: unknown) {
		if (!(error instanceof UnexpectedError) || !(error.cause instanceof RestError)) return false;
		const cause = error.cause;
		if (cause.statusCode !== 404) return false;
		const details = cause.details;
		const headerCode =
			details && typeof details === 'object' && 'errorCode' in details
				? details.errorCode
				: undefined;
		return cause.code === 'BlobNotFound' || headerCode === 'BlobNotFound';
	}

	private get container() {
		if (!this.client) throw new UnexpectedError('Azure Blob storage is not initialized');
		return this.client;
	}

	/** A connection string comes first, then automatic credentials, then the account key. */
	private createServiceClient() {
		const { connectionString, accountName, accountKey, endpoint, authAutoDetect } = this.config;
		if (connectionString) return BlobServiceClient.fromConnectionString(connectionString);
		const url = endpoint || `https://${accountName}.blob.core.windows.net`;
		if (authAutoDetect) return new BlobServiceClient(url, new DefaultAzureCredential());
		return new BlobServiceClient(url, new StorageSharedKeyCredential(accountName, accountKey));
	}

	private async checkConnection(client: ContainerClient) {
		this.logger.debug('Checking connection to Azure Blob container', {
			container: client.containerName,
		});
		try {
			await client.listBlobsFlat().byPage({ maxPageSize: 1 }).next();
		} catch (error) {
			if (error instanceof RestError && error.statusCode === 404) {
				throw new UserError(
					`Azure Blob container "${client.containerName}" does not exist or is not accessible.`,
				);
			}
			throw this.requestFailed(error);
		}
	}

	private requestFailed(error: unknown) {
		return new UnexpectedError(
			`Request to Azure Blob storage failed: ${ensureError(error).message}`,
			{ cause: error },
		);
	}
}
