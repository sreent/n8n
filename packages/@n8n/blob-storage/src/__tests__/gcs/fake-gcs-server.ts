import { createHash } from 'node:crypto';
import http from 'node:http';
import net, { type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Fork test helper (not in upstream n8n): an in-memory server with the parts of Google Cloud that
 * the native storage uses: the JSON API of Cloud Storage, the token endpoint of OAuth 2.0 and the
 * token route of the metadata server. It records each request.
 */

export type GcsRequest = {
	method: string;
	path: string;
	query: Record<string, string>;
	authorization?: string;
	contentType?: string;
	metadataFlavor?: string;
	/** The form of a token request, or the JSON metadata of an upload. */
	body?: unknown;
	/** The content of an upload. */
	content?: string;
};

type StoredObject = { body: Buffer; contentType?: string; metadata?: Record<string, string> };

/**
 * Answers the next `count` requests that `match` finds after `delayMs`: with `status` when set, by
 * closing the connection when `reset` is set, else as usual.
 */
export type GcsFailure = {
	match: (request: GcsRequest) => boolean;
	count: number;
	status?: number;
	delayMs?: number;
	reset?: boolean;
};

const md5 = (body: Buffer) => createHash('md5').update(body).digest('base64');

/** The parts of a `multipart/related` body. */
function parseMultipart(body: Buffer, contentType: string) {
	const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
	if (!boundary) return [];
	const delimiter = Buffer.from(`--${boundary}`);
	const parts: Array<{ headers: string; content: Buffer }> = [];
	let start = body.indexOf(delimiter);
	while (start !== -1) {
		const next = body.indexOf(delimiter, start + delimiter.length);
		if (next === -1) break;
		const part = body.subarray(start + delimiter.length + 2, next - 2);
		const headerEnd = part.indexOf('\r\n\r\n');
		parts.push({
			headers: part.subarray(0, headerEnd).toString(),
			content: part.subarray(headerEnd + 4),
		});
		start = next;
	}
	return parts;
}

export class FakeGcsServer {
	readonly requests: GcsRequest[] = [];

	readonly failures: GcsFailure[] = [];

	readonly buckets = new Set<string>();

	readonly objects = new Map<string, StoredObject>();

	/** The answer of the token endpoint, or `null` for an error. */
	tokenAnswer: { access_token: string; expires_in: number } | null = {
		access_token: 'token-1',
		expires_in: 3600,
	};

	port = 0;

	private readonly sockets = new Set<Socket>();

	private readonly server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => this.handle(req, Buffer.concat(chunks), res));
	});

	constructor() {
		this.server.on('connection', (socket) => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
	}

	get endpoint() {
		return `http://127.0.0.1:${this.port}`;
	}

	async start() {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const address = this.server.address();
		if (address && typeof address === 'object') this.port = address.port;
	}

	async stop() {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** The requests since the last call. */
	take() {
		return this.requests.splice(0);
	}

	private resource(bucket: string, name: string, object: StoredObject) {
		return {
			kind: 'storage#object',
			bucket,
			name,
			size: String(object.body.length),
			md5Hash: md5(object.body),
			contentType: object.contentType,
			...(object.metadata ? { metadata: object.metadata } : {}),
		};
	}

	private handle(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) {
		const url = new URL(req.url ?? '/', 'http://fake');
		const request: GcsRequest = {
			method: req.method ?? 'GET',
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
		};
		if (req.headers.authorization) request.authorization = req.headers.authorization;
		if (req.headers['content-type']) request.contentType = req.headers['content-type'];
		const flavor = req.headers['metadata-flavor'];
		if (typeof flavor === 'string') request.metadataFlavor = flavor;
		this.requests.push(request);
		const json = (status: number, value: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(value));
		};
		const error = (status: number, message: string) =>
			json(status, { error: { code: status, message } });

		const failure = this.failures.find((rule) => rule.count > 0 && rule.match(request));
		if (failure) {
			failure.count -= 1;
			const { status, delayMs = 0, reset } = failure;
			setTimeout(() => {
				if (reset) res.socket?.destroy();
				else if (status) error(status, 'Injected failure.');
				else this.answer(request, url, body, res, json, error);
			}, delayMs);
			return;
		}
		this.answer(request, url, body, res, json, error);
	}

	private answer(
		request: GcsRequest,
		url: URL,
		body: Buffer,
		res: http.ServerResponse,
		json: (status: number, value: unknown) => void,
		error: (status: number, message: string) => void,
	) {
		if (url.pathname === '/token' && request.method === 'POST') {
			request.body = Object.fromEntries(new URLSearchParams(body.toString()));
			if (!this.tokenAnswer) return json(400, { error: 'invalid_grant' });
			return json(200, { ...this.tokenAnswer, token_type: 'Bearer' });
		}

		if (url.pathname === '/computeMetadata/v1/instance/service-accounts/default/token') {
			if (request.metadataFlavor !== 'Google') return error(403, 'Missing header');
			return json(200, { access_token: 'metadata-token', expires_in: 3600, token_type: 'Bearer' });
		}

		const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
		if (upload && request.method === 'POST') {
			const [metadataPart, dataPart] = parseMultipart(body, request.contentType ?? '');
			if (!metadataPart || !dataPart) return error(400, 'Not a multipart upload');
			const metadata = JSON.parse(metadataPart.content.toString()) as {
				name?: string;
				contentType?: string;
				metadata?: Record<string, string>;
				md5Hash?: string;
			};
			request.body = metadata;
			request.content = dataPart.content.toString();
			const bucket = decodeURIComponent(upload[1]);
			if (!this.buckets.has(bucket)) return error(404, 'The specified bucket does not exist.');
			if (metadata.md5Hash && metadata.md5Hash !== md5(dataPart.content)) {
				return error(400, 'Provided MD5 hash does not match the content.');
			}
			const name = url.searchParams.get('name') ?? metadata.name ?? '';
			const object = {
				body: Buffer.from(dataPart.content),
				contentType: metadata.contentType,
				metadata: metadata.metadata,
			};
			this.objects.set(`${bucket}/${name}`, object);
			return json(200, this.resource(bucket, name, object));
		}

		const objectRoute = /^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);
		if (objectRoute) {
			const bucket = decodeURIComponent(objectRoute[1]);
			const name = decodeURIComponent(objectRoute[2]);
			const key = `${bucket}/${name}`;
			const stored = this.objects.get(key);
			if (!stored) return error(404, 'No such object.');
			if (request.method === 'DELETE') {
				this.objects.delete(key);
				res.writeHead(204);
				return res.end();
			}
			if (url.searchParams.get('alt') === 'media') {
				res.writeHead(200, { 'content-type': stored.contentType ?? 'application/octet-stream' });
				return res.end(stored.body);
			}
			return json(200, this.resource(bucket, name, stored));
		}

		const listRoute = /^\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
		if (listRoute && request.method === 'GET') {
			const bucket = decodeURIComponent(listRoute[1]);
			if (!this.buckets.has(bucket)) return error(404, 'The specified bucket does not exist.');
			return json(200, { kind: 'storage#objects' });
		}

		return error(400, `Unknown request ${request.method} ${url.pathname}`);
	}
}

/** A forward proxy that opens a tunnel for each CONNECT request, and records the target. */
export class FakeTunnelProxy {
	readonly targets: string[] = [];

	port = 0;

	private readonly sockets = new Set<Duplex>();

	private readonly server = http.createServer((_req, res) => {
		res.writeHead(405);
		res.end();
	});

	constructor() {
		this.server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
			const target = req.url ?? '';
			this.targets.push(target);
			const [host, port] = target.split(':');
			const upstream = net.connect(Number(port), host, () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				if (head.length > 0) upstream.write(head);
				upstream.pipe(client);
				client.pipe(upstream);
			});
			for (const socket of [client, upstream]) {
				this.sockets.add(socket);
				socket.on('close', () => this.sockets.delete(socket));
			}
			upstream.on('error', () => client.destroy());
			client.on('error', () => upstream.destroy());
		});
	}

	async start() {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const address = this.server.address();
		if (address && typeof address === 'object') this.port = address.port;
	}

	async stop() {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}
