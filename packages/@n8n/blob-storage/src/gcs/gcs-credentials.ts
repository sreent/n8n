import type { CustomFetch } from '@n8n/backend-network';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { isRecord } from '@n8n/utils/is-record';
import { UnexpectedError } from 'n8n-workflow';
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** An access token of Google, with the time (in milliseconds) when it expires. */
type AccessToken = { token: string; expiresAt: number };

/** The fields of a service account key that the token request uses. */
type ServiceAccountKey = { clientEmail: string; privateKey: string; tokenUri: string };

/** Read and write access to the objects of the bucket. */
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const DEFAULT_METADATA_HOST = 'metadata.google.internal';

/** A new token comes five minutes before the old one expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The longest wait for the answer of a token request. */
const TOKEN_TIMEOUT_MS = 30_000;

/** Where the access tokens come from. */
export interface TokenSource {
	/** The source, for the log. It contains no secret. */
	describe(): string;
	fetchToken(): Promise<AccessToken>;
}

/** The fetch of the requests, and a fetch without a proxy. */
export type TokenFetches = { fetch: CustomFetch; directFetch: CustomFetch };

/** The reason of a failure. A network error of fetch has its reason in the cause. */
export function reasonOf(error: unknown) {
	const failure = ensureError(error);
	if (failure instanceof TypeError && failure.cause instanceof Error) {
		const { cause } = failure;
		if (cause.message) return cause.message;
		if ('code' in cause && typeof cause.code === 'string') return cause.code;
	}
	return failure.message;
}

async function readToken(response: Response): Promise<AccessToken> {
	const text = await response.text();
	if (!response.ok) throw new UnexpectedError(`status ${response.status}: ${text.slice(0, 300)}`);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new UnexpectedError('the answer is not JSON');
	}
	if (!isRecord(body) || typeof body.access_token !== 'string') {
		throw new UnexpectedError('the answer has no access token');
	}
	const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
	return { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
}

/**
 * The OAuth 2.0 flow of a service account: n8n signs a JWT with the private key of the service
 * account and exchanges it for an access token.
 */
export class ServiceAccountTokenSource implements TokenSource {
	constructor(
		private readonly key: ServiceAccountKey,
		private readonly fetch: CustomFetch,
	) {}

	describe() {
		return `the service account ${this.key.clientEmail}`;
	}

	async fetchToken() {
		const now = Math.floor(Date.now() / 1000);
		const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
			iss: this.key.clientEmail,
			scope: STORAGE_SCOPE,
			aud: this.key.tokenUri,
			iat: now,
			exp: now + 3600,
		})}`;
		const signature = createSign('RSA-SHA256')
			.update(unsigned)
			.sign(this.key.privateKey)
			.toString('base64url');
		const response = await this.fetch(this.key.tokenUri, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: `${unsigned}.${signature}`,
			}).toString(),
			signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
		});
		return await readToken(response);
	}
}

/**
 * The service account of the virtual machine, of the container or of the workload (workload
 * identity), from the metadata server of Google Cloud. `GCE_METADATA_HOST` changes its host.
 */
export class MetadataServerTokenSource implements TokenSource {
	/** Only the machine itself reaches its metadata server, so `directFetch` uses no proxy. */
	constructor(private readonly directFetch: CustomFetch) {}

	describe() {
		return 'the service account of the metadata server';
	}

	async fetchToken() {
		const host = process.env.GCE_METADATA_HOST || DEFAULT_METADATA_HOST;
		const response = await this.directFetch(
			`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
			{ headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) },
		);
		return await readToken(response);
	}
}

/** Gives a valid access token. One request gets a new token for all callers. */
export class AccessTokenCache {
	private current: AccessToken | undefined;

	private pending: Promise<AccessToken> | undefined;

	constructor(private readonly source: TokenSource) {}

	async get() {
		if (this.current && this.current.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
			return this.current.token;
		}
		this.pending ??= this.source.fetchToken().finally(() => {
			this.pending = undefined;
		});
		this.current = await this.pending;
		return this.current.token;
	}
}

function parseKey(text: string, origin: string): ServiceAccountKey {
	let key: unknown;
	try {
		key = JSON.parse(text);
	} catch {
		throw new UnexpectedError(`${origin} is not the JSON key of a service account`);
	}
	if (
		!isRecord(key) ||
		typeof key.client_email !== 'string' ||
		typeof key.private_key !== 'string'
	) {
		throw new UnexpectedError(
			`${origin} is not the JSON key of a service account: it needs client_email and private_key`,
		);
	}
	return {
		clientEmail: key.client_email,
		privateKey: key.private_key,
		tokenUri: typeof key.token_uri === 'string' ? key.token_uri : DEFAULT_TOKEN_URI,
	};
}

/**
 * The source of the tokens: the JSON key of the config, else the key file in
 * `GOOGLE_APPLICATION_CREDENTIALS`, else the metadata server.
 */
export async function tokenSourceFor(
	credentials: string,
	{ fetch, directFetch }: TokenFetches,
): Promise<TokenSource> {
	if (credentials) {
		return new ServiceAccountTokenSource(
			parseKey(credentials, 'N8N_EXTERNAL_STORAGE_GCS_CREDENTIALS'),
			fetch,
		);
	}
	const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
	if (keyFile) {
		return new ServiceAccountTokenSource(
			parseKey(await readFile(keyFile, 'utf8'), `The file ${keyFile}`),
			fetch,
		);
	}
	return new MetadataServerTokenSource(directFetch);
}
