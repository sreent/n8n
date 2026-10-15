import type { Logger } from '@n8n/backend-common';
import type { CustomFetch } from '@n8n/backend-network';
import { isRecord } from '@n8n/utils/is-record';
import { UnexpectedError } from 'n8n-workflow';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import type { BlobMetadata, PreWriteBlobMetadata } from '../types';
import { AccessTokenCache, reasonOf, type TokenSource } from './gcs-credentials';
import type { GcsStorageConfig } from './gcs-storage.config';

/** The answers that a new attempt can change: a timeout, a rate limit or a server error. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** The deletes that run at the same time. */
const DELETE_CONCURRENCY = 32;

/** A request that Google Cloud Storage answered with an error status. */
class GcsRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The error of an answer: its status and the message of the JSON error, else of the text. */
async function errorOf(response: Response) {
	const text = await response.text();
	let message = text.slice(0, 300);
	try {
		const body: unknown = JSON.parse(text);
		if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
			message = body.error.message;
		}
	} catch {}
	return new GcsRequestError(response.status, `${response.status} ${message}`.trim());
}

/** The chunks of a web stream, as a Node stream. An error of the download reaches the reader. */
function toNodeStream(body: ReadableStream<Uint8Array>) {
	async function* chunks() {
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				yield Buffer.from(value);
			}
		} finally {
			// A reader that stops early closes the download.
			await reader.cancel().catch(() => {});
		}
	}
	return Readable.from(chunks(), { objectMode: false });
}

/** A failed request, with the reason without the prefix of the message. */
class GcsStorageError extends UnexpectedError {
	constructor(
		readonly reason: string,
		cause: unknown,
	) {
		super(`Request to Google Cloud Storage failed: ${reason}`, { cause });
	}
}

/** A path segment of the JSON API. Google Cloud Storage asks to percent-encode `!'()*` too. */
const encodeSegment = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/** A reason without its last period, so that a sentence can follow it. */
const withoutPeriod = (reason: string) => reason.replace(/\.+$/, '');

/**
 * Fork code (not in upstream n8n): a client of the JSON API of Google Cloud Storage. It signs each
 * request with an access token of a service account. `ObjectStoreService` uses it when
 * `N8N_EXTERNAL_STORAGE_GCS_BUCKET_NAME` is set. See `../../FORK.md`.
 */
export class GcsStorageClient {
	private readonly tokens: AccessTokenCache;

	private readonly bucketPath: string;

	constructor(
		private readonly logger: Logger,
		private readonly config: GcsStorageConfig,
		private readonly fetch: CustomFetch,
		private readonly tokenSource: TokenSource,
		/** The wait before the second attempt. It doubles for each next attempt. */
		private readonly retryDelayMs = 250,
	) {
		this.tokens = new AccessTokenCache(tokenSource);
		this.bucketPath = `/storage/v1/b/${encodeSegment(config.bucketName)}`;
	}

	/**
	 * Logs the configuration, and checks the credentials and the bucket once. The check lists one
	 * object, so a role with access to the objects of the bucket is sufficient.
	 */
	async init() {
		const { bucketName, apiEndpoint } = this.config;
		this.logger.info(
			`Google Cloud Storage configured: endpoint=${apiEndpoint}, bucket=${bucketName}, credentials=${this.tokenSource.describe()}`,
		);
		try {
			await this.withinStartupTimeout(this.tokens.get());
		} catch (error) {
			const failure = this.tokenFailed(error);
			this.logger.error(failure.message);
			throw failure;
		}
		try {
			const response = await this.withinStartupTimeout(
				this.send('GET', `${this.bucketPath}/o`, { query: { maxResults: '1', fields: 'kind' } }),
			);
			if (!response.ok) throw await errorOf(response);
			await response.body?.cancel();
		} catch (error) {
			const reason = error instanceof GcsStorageError ? error.reason : reasonOf(error);
			const message = `Failed to connect to Google Cloud Storage at ${apiEndpoint} (bucket: ${bucketName}): ${withoutPeriod(reason)}. Check the name of the bucket, and that the service account has the role Storage Object User or Storage Object Admin on the bucket.`;
			this.logger.error(message);
			throw new UnexpectedError(message, { cause: error });
		}
	}

	/** Uploads `buffer` in one request, with the MIME type and the file name as object metadata. */
	async put(key: string, buffer: Buffer, metadata: PreWriteBlobMetadata = {}) {
		const contentType = metadata.mimeType || 'application/octet-stream';
		const resource: Record<string, unknown> = {
			name: key,
			contentType,
			// Google Cloud Storage rejects the upload when the content does not match this hash.
			md5Hash: createHash('md5').update(buffer).digest('base64'),
		};
		if (metadata.fileName) resource.metadata = { filename: encodeURIComponent(metadata.fileName) };
		const boundary = randomUUID();
		// The JSON part sets the content type of the object. A line break must not end the header.
		const head = Buffer.from(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(resource)}\r\n--${boundary}\r\nContent-Type: ${contentType.replace(/[\r\n]/g, '')}\r\n\r\n`,
		);
		const tail = Buffer.from(`\r\n--${boundary}--`);
		// One copy of the content: the multipart body of the upload.
		const body = new Uint8Array(head.length + buffer.length + tail.length);
		body.set(head, 0);
		body.set(buffer, head.length);
		body.set(tail, head.length + buffer.length);
		this.logger.debug('Uploading an object to Google Cloud Storage', { key });
		const response = await this.expect(
			await this.send('POST', `/upload${this.bucketPath}/o`, {
				// The name of the object is in the JSON part only.
				query: { uploadType: 'multipart' },
				headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
				body,
			}),
		);
		await response.body?.cancel();
	}

	/** The content of an object. A missing object is an error (see `isMissingObject`). */
	async getBuffer(key: string): Promise<Buffer> {
		this.logger.debug('Downloading an object from Google Cloud Storage', { key });
		const response = await this.expect(
			await this.send('GET', this.objectPath(key), { query: { alt: 'media' } }),
		);
		return Buffer.from(await response.arrayBuffer());
	}

	/** The content of an object as a stream. A missing object is an error. */
	async getStream(key: string): Promise<Readable> {
		this.logger.debug('Streaming an object from Google Cloud Storage', { key });
		const response = await this.expect(
			await this.send('GET', this.objectPath(key), { query: { alt: 'media' } }),
		);
		if (!response.body) return Readable.from([], { objectMode: false });
		return toNodeStream(response.body);
	}

	/** The size, the MIME type and the file name of an object, or `null` when it is missing. */
	async getMetadata(key: string): Promise<BlobMetadata | null> {
		this.logger.debug('Reading the metadata of an object in Google Cloud Storage', { key });
		const response = await this.send('GET', this.objectPath(key), {
			query: { fields: 'size,contentType,metadata' },
		});
		if (response.status === 404) {
			await response.body?.cancel();
			return null;
		}
		await this.expect(response);
		const object: unknown = await response.json();
		if (!isRecord(object)) throw this.failed(new UnexpectedError('the answer is not an object'));
		const metadata: BlobMetadata = { fileSize: Number(object.size ?? 0) };
		if (typeof object.contentType === 'string') metadata.mimeType = object.contentType;
		const fileName = isRecord(object.metadata) ? object.metadata.filename : undefined;
		if (typeof fileName === 'string' && fileName) metadata.fileName = decodeURIComponent(fileName);
		return metadata;
	}

	/** Deletes an object. A missing object is no error. */
	async deleteOne(key: string) {
		this.logger.debug('Deleting an object from Google Cloud Storage', { key });
		await this.remove(key);
	}

	/** Deletes the objects, 32 at the same time. A missing object is no error. */
	async deleteMany(keys: string[]) {
		this.logger.debug('Deleting objects from Google Cloud Storage', { objectCount: keys.length });
		for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
			const batch = keys.slice(start, start + DELETE_CONCURRENCY);
			await Promise.all(batch.map(async (key) => await this.remove(key)));
		}
	}

	/** Whether a failed request of this client was for a missing object. */
	isMissingObject(error: unknown) {
		return (
			error instanceof UnexpectedError &&
			error.cause instanceof GcsRequestError &&
			error.cause.status === 404
		);
	}

	private async remove(key: string) {
		const response = await this.send('DELETE', this.objectPath(key));
		if (response.status !== 404) await this.expect(response);
		await response.body?.cancel();
	}

	private objectPath(key: string) {
		return `${this.bucketPath}/o/${encodeSegment(key)}`;
	}

	/** The answer when its status is a success, else the error of the request. */
	private async expect(response: Response) {
		if (response.ok) return response;
		throw this.failed(await errorOf(response));
	}

	private failed(error: unknown) {
		return new GcsStorageError(reasonOf(error), error);
	}

	private tokenFailed(error: unknown) {
		return new UnexpectedError(
			`Failed to get an access token for Google Cloud Storage from ${this.tokenSource.describe()}: ${reasonOf(error)}`,
			{ cause: error },
		);
	}

	/** Fails when `work` takes longer than `N8N_EXTERNAL_STORAGE_GCS_STARTUP_TIMEOUT_MS`. */
	private async withinStartupTimeout<T>(work: Promise<T>): Promise<T> {
		const { startupTimeoutMs } = this.config;
		if (startupTimeoutMs <= 0) return await work;
		const timeout = sleep(startupTimeoutMs, undefined, { ref: false }).then(() => {
			throw new UnexpectedError(`no answer within ${startupTimeoutMs} ms`);
		});
		return await Promise.race([work, timeout]);
	}

	private async pause(attempt: number) {
		await sleep(this.retryDelayMs * 2 ** (attempt - 1));
	}

	/**
	 * Sends a request with an access token. A network error, a failed token request or a temporary
	 * error status gets new attempts, up to `N8N_EXTERNAL_STORAGE_GCS_MAX_ATTEMPTS`, with a wait
	 * that doubles.
	 */
	private async send(
		method: string,
		path: string,
		options: {
			query?: Record<string, string>;
			headers?: Record<string, string>;
			body?: Uint8Array<ArrayBuffer>;
		} = {},
	): Promise<Response> {
		const url = new URL(`${this.config.apiEndpoint.replace(/\/+$/, '')}${path}`);
		for (const [name, value] of Object.entries(options.query ?? {})) {
			url.searchParams.set(name, value);
		}
		const attempts = Math.max(1, this.config.maxAttempts);
		for (let attempt = 1; ; attempt++) {
			const isLast = attempt >= attempts;
			let token: string;
			try {
				token = await this.tokens.get();
			} catch (error) {
				if (isLast) throw this.tokenFailed(error);
				await this.pause(attempt);
				continue;
			}
			let response: Response;
			try {
				response = await this.fetch(url, {
					method,
					headers: { ...options.headers, Authorization: `Bearer ${token}` },
					body: options.body,
				});
			} catch (error) {
				if (isLast) throw this.failed(error);
				await this.pause(attempt);
				continue;
			}
			if (!RETRYABLE_STATUSES.has(response.status) || isLast) return response;
			await response.body?.cancel();
			await this.pause(attempt);
		}
	}
}
