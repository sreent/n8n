import { OutboundHttp, type HttpRequestClient } from '@n8n/backend-network';
import { CredentialResolverError } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { isRecord } from '@n8n/utils/is-record';
import type { IHttpRequestOptions } from 'n8n-workflow';

import { oauth2MetadataSchema, type OAuth2Metadata } from './oauth2-utils';

export type HttpAnswer = { status: number; body: unknown };

const METADATA_CACHE_MS = 60 * 60 * 1000;

/** The time limit of a request to the identity provider. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** The message of a failed request: the cause of a network error, else the error. */
function failureMessage(error: unknown) {
	const failure = ensureError(error);
	return failure.cause instanceof Error ? failure.cause.message : failure.message;
}

/** A JSON body as a value, an empty body as `undefined`, other text as text. */
function parseBody(body: unknown): unknown {
	if (typeof body !== 'string') return body;
	if (body.length === 0) return undefined;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		return body;
	}
}

const isSuccess = (status: number) => status >= 200 && status < 300;

/** The HTTP calls of the OAuth2 resolver to the identity provider. */
@Service()
export class OAuth2MetadataHttpClient {
	private readonly http: HttpRequestClient;

	constructor(outboundHttp: OutboundHttp) {
		// An admin configures the identity provider. It can be on an internal network.
		this.http = outboundHttp.requests({ useDefaultSsrfPolicy: 'unsafe' });
	}

	/** Reads the metadata document. Throws with the reason when it is not available. */
	async fetchMetadata(metadataUri: string): Promise<unknown> {
		let answer: HttpAnswer;
		try {
			answer = await this.send({
				url: metadataUri,
				method: 'GET',
				headers: { Accept: 'application/json' },
			});
		} catch (error) {
			throw new CredentialResolverError(`Could not reach metadata URL: ${failureMessage(error)}`);
		}
		if (!isSuccess(answer.status)) {
			throw new CredentialResolverError(
				`Failed to fetch OAuth2 metadata, status code: ${answer.status}`,
			);
		}
		return answer.body;
	}

	/** The metadata document as an object, or a format error. */
	parseMetadata(document: unknown): OAuth2Metadata {
		const result = oauth2MetadataSchema.safeParse(document);
		if (!isRecord(document) || !result.success) {
			throw new CredentialResolverError('Invalid OAuth2 metadata format');
		}
		return result.data;
	}

	async get(url: string, headers: Record<string, string>): Promise<HttpAnswer> {
		return await this.send({
			url,
			method: 'GET',
			headers: { ...headers, Accept: 'application/json' },
		});
	}

	async postForm(
		url: string,
		form: Record<string, string>,
		headers: Record<string, string>,
	): Promise<HttpAnswer> {
		return await this.send({
			url,
			method: 'POST',
			headers: {
				...headers,
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
			body: new URLSearchParams(form).toString(),
		});
	}

	/** Sends a request and gives each answer, also an answer with an error status. */
	private async send(options: IHttpRequestOptions): Promise<HttpAnswer> {
		const response = await this.http.request<unknown>({
			...options,
			timeout: REQUEST_TIMEOUT_MS,
			encoding: 'text',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
		return { status: response.statusCode, body: parseBody(response.body) };
	}
}

/** The metadata documents of identity providers, by URL, for an hour. */
export class OAuth2MetadataCache {
	private readonly entries = new Map<string, { metadata: OAuth2Metadata; expiresAt: number }>();

	constructor(private readonly client: OAuth2MetadataHttpClient) {}

	async get(metadataUri: string): Promise<OAuth2Metadata> {
		const cached = this.entries.get(metadataUri);
		if (cached && cached.expiresAt > Date.now()) return cached.metadata;
		const metadata = this.client.parseMetadata(await this.client.fetchMetadata(metadataUri));
		this.entries.set(metadataUri, { metadata, expiresAt: Date.now() + METADATA_CACHE_MS });
		return metadata;
	}
}
