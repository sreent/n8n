// Fork test helper (not in upstream n8n): a fake OAuth2 and OpenID Connect provider for the
// golden tests of dynamic credentials. It serves the metadata document, token introspection,
// the userinfo endpoint and a key set on a local port, answers from fixed tables, and records
// each request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeAnswer = { status: number; body?: unknown; headers?: Record<string, string> };

export type RecordedRequest = {
	method: string;
	path: string;
	query?: Record<string, string>;
	headers: Record<string, string>;
	body?: unknown;
};

/** The request headers that the record keeps. */
const RECORDED_HEADERS = ['authorization', 'content-type', 'accept'];

export class FakeIdentityProvider {
	private server: Server | undefined;

	baseUrl = '';

	requests: RecordedRequest[] = [];

	/** The metadata document, or an answer that replaces it. */
	metadata: Record<string, unknown> | FakeAnswer = {};

	/** The answers of the introspection endpoint by token. Unknown tokens are inactive. */
	introspection = new Map<string, FakeAnswer>();

	/** The answers of the userinfo endpoint by token. Unknown tokens get 401. */
	userinfo = new Map<string, FakeAnswer>();

	/** The answer of the key set endpoint. */
	jwks: FakeAnswer = { status: 200, body: { keys: [] } };

	/** The answers of other paths, for example the token endpoint. */
	routes = new Map<string, FakeAnswer>();

	async start() {
		this.server = createServer((request, response) => {
			void this.handle(request, response);
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		const { port } = this.server.address() as AddressInfo;
		this.baseUrl = `http://127.0.0.1:${port}`;
		this.reset();
	}

	async stop() {
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	/** The default answers: a full metadata document and no known tokens. */
	reset() {
		this.requests = [];
		this.metadata = this.defaultMetadata();
		this.introspection.clear();
		this.userinfo.clear();
		this.jwks = { status: 200, body: { keys: [] } };
		this.routes.clear();
	}

	defaultMetadata(): Record<string, unknown> {
		return {
			issuer: this.baseUrl,
			authorization_endpoint: `${this.baseUrl}/authorize`,
			token_endpoint: `${this.baseUrl}/token`,
			introspection_endpoint: `${this.baseUrl}/introspect`,
			userinfo_endpoint: `${this.baseUrl}/userinfo`,
			jwks_uri: `${this.baseUrl}/jwks`,
		};
	}

	/** The URLs of the provider as placeholders, for the record. */
	label(text: string) {
		return this.baseUrl ? text.replaceAll(this.baseUrl, '<idp>') : text;
	}

	/** The recorded requests since the last call. */
	take() {
		const taken = this.requests;
		this.requests = [];
		return taken;
	}

	private async handle(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? '/', this.baseUrl);
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString('utf8');
		const contentType = String(request.headers['content-type'] ?? '');
		let body: unknown = raw.length ? raw : undefined;
		if (raw.length && contentType.includes('application/x-www-form-urlencoded')) {
			body = Object.fromEntries(new URLSearchParams(raw));
		} else if (raw.length && contentType.includes('application/json')) {
			try {
				body = JSON.parse(raw) as unknown;
			} catch {
				body = raw;
			}
		}
		const headers = Object.fromEntries(
			RECORDED_HEADERS.filter((name) => request.headers[name] !== undefined).map((name) => [
				name,
				String(request.headers[name]),
			]),
		);
		const query = Object.fromEntries(url.searchParams);
		this.requests.push({
			method: request.method ?? 'GET',
			path: url.pathname,
			...(Object.keys(query).length ? { query } : {}),
			headers,
			...(body !== undefined ? { body } : {}),
		});

		const answer = this.answer(request.method ?? 'GET', url.pathname, request, body);
		response.writeHead(answer.status, {
			'content-type': 'application/json',
			...(answer.headers ?? {}),
		});
		response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
	}

	private answer(
		method: string,
		path: string,
		request: IncomingMessage,
		body: unknown,
	): FakeAnswer {
		const route = this.routes.get(`${method} ${path}`);
		if (route) return route;
		if (
			path.endsWith('/.well-known/openid-configuration') ||
			path.endsWith('/.well-known/oauth-authorization-server')
		) {
			const metadata = this.metadata;
			if (typeof metadata.status === 'number') return metadata as FakeAnswer;
			return { status: 200, body: metadata };
		}
		if (path === '/introspect') {
			const token =
				body && typeof body === 'object' && 'token' in body
					? String((body as { token: unknown }).token)
					: '';
			return this.introspection.get(token) ?? { status: 200, body: { active: false } };
		}
		if (path === '/userinfo') {
			const header = String(request.headers.authorization ?? '');
			const token = header.replace(/^Bearer\s+/i, '');
			return this.userinfo.get(token) ?? { status: 401, body: { error: 'invalid_token' } };
		}
		if (path === '/jwks') return this.jwks;
		return { status: 404, body: { error: 'not_found' } };
	}
}
