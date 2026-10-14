import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type { FailureRule, RecordedRequest } from './recording';
import { describeBody, normalizeHeaders, readBody, sortedQuery } from './recording';

/**
 * Fork test helper (not in upstream n8n): an in-memory Azure Blob server for the golden tests of
 * the Azure Blob storage. It answers the Blob REST calls of the storage on the path-style URLs of
 * the Azurite emulator (`/<account>/<container>/<blob>`), and records each request.
 */

type StoredBlob = {
	body: Buffer;
	contentType?: string;
	contentDisposition?: string;
	contentEncoding?: string;
	cacheControl?: string;
	metadata: Record<string, string>;
};

export const AZURITE_ACCOUNT = 'devstoreaccount1';

/** The public development key of the Azurite emulator. */
export const AZURITE_KEY =
	'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

const LAST_MODIFIED = 'Wed, 14 Oct 2026 10:00:00 GMT';

const etagOf = (body: Buffer) =>
	`"0x${createHash('md5').update(body).digest('hex').slice(0, 15).toUpperCase()}"`;

const xmlEscape = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class FakeAzureServer {
	readonly requests: RecordedRequest[] = [];

	readonly failures: FailureRule[] = [];

	readonly containers = new Set<string>();

	private readonly blobs = new Map<string, StoredBlob>();

	private readonly staged = new Map<string, Map<string, Buffer>>();

	private readonly sockets = new Set<Socket>();

	private requestCount = 0;

	private readonly server = http.createServer((req, res) => {
		void this.handle(req, res);
	});

	port = 0;

	constructor() {
		this.server.on('connection', (socket) => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
	}

	get blobEndpoint() {
		return `http://127.0.0.1:${this.port}/${AZURITE_ACCOUNT}`;
	}

	get connectionString() {
		return `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT};AccountKey=${AZURITE_KEY};BlobEndpoint=${this.blobEndpoint};`;
	}

	async start() {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		this.port = (this.server.address() as AddressInfo).port;
	}

	async stop() {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	reset() {
		this.requests.length = 0;
		this.failures.length = 0;
		this.blobs.clear();
		this.staged.clear();
	}

	putBlob(
		container: string,
		name: string,
		body: Buffer,
		options: { contentType?: string; metadata?: Record<string, string> } = {},
	) {
		this.blobs.set(`${container}/${name}`, {
			body,
			contentType: options.contentType,
			metadata: options.metadata ?? {},
		});
	}

	getBlob(container: string, name: string) {
		return this.blobs.get(`${container}/${name}`);
	}

	blobNames() {
		return [...this.blobs.keys()].sort();
	}

	/** Takes the recorded requests and empties the list. */
	take() {
		this.maxInFlight = 0;
		return this.requests.splice(0, this.requests.length);
	}

	/** The most requests that the server handled at the same time since the last take. */
	maxInFlight = 0;

	private inFlight = 0;

	/** Delays each answer, so that requests sent at the same time overlap. */
	answerDelayMs = 0;

	private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		let counted = true;
		const uncount = () => {
			if (!counted) return;
			counted = false;
			this.inFlight -= 1;
		};
		res.on('close', uncount);
		const raw = await readBody(req);
		if (this.answerDelayMs) await new Promise((resolve) => setTimeout(resolve, this.answerDelayMs));
		const url = new URL(req.url ?? '/', 'http://fake');
		const hostHeader = req.headers.host ?? '';

		this.requests.push({
			method: req.method ?? '',
			host: hostHeader.replace(String(this.port), 'PORT'),
			path: url.pathname,
			query: sortedQuery(url.searchParams),
			headers: normalizeHeaders(req.headers),
			body: describeBody(raw, req.headers['content-type']),
		});

		const failure = this.failures.find(
			(rule) =>
				rule.times > 0 &&
				(!rule.method || rule.method === req.method) &&
				rule.match.test(url.pathname),
		);
		if (failure) {
			failure.times -= 1;
			// A request that gets no answer does not overlap the requests of later steps.
			if (failure.hang) {
				uncount();
				return;
			}
			if (failure.delayMs) await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
			if (failure.truncate) {
				const segments = url.pathname.split('/').slice(2).map(decodeURIComponent);
				const blob = this.blobs.get(segments.join('/'));
				const body = blob?.body ?? Buffer.from('truncated body');
				res.writeHead(200, {
					...this.baseHeaders(req),
					'Content-Length': String(body.length + 100),
					'Content-Type': blob?.contentType ?? 'application/octet-stream',
					'x-ms-blob-type': 'BlockBlob',
					ETag: etagOf(body),
					'Last-Modified': LAST_MODIFIED,
				});
				res.write(body);
				setTimeout(() => res.socket?.destroy(), 20);
				return;
			}
			if (failure.status) {
				this.sendError(req, res, failure.status, failure.code ?? 'InternalError');
				return;
			}
		}

		try {
			this.route(req, url, raw, res);
		} catch (error) {
			this.sendError(req, res, 500, 'InternalError', String(error));
		}
	}

	private baseHeaders(req: http.IncomingMessage): Record<string, string> {
		this.requestCount += 1;
		return {
			'x-ms-request-id': `fake-request-${this.requestCount}`,
			'x-ms-version': String(req.headers['x-ms-version'] ?? '2025-01-05'),
			Date: LAST_MODIFIED,
		};
	}

	private route(req: http.IncomingMessage, url: URL, body: Buffer, res: http.ServerResponse) {
		const method = req.method ?? '';
		const query = url.searchParams;
		const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
		// The first segment is the account on the Azurite URLs.
		const [account, container = '', ...rest] = segments;
		const name = rest.join('/');

		if (account !== AZURITE_ACCOUNT) {
			this.sendError(req, res, 400, 'InvalidUri');
			return;
		}

		if (query.get('comp') === 'batch') {
			this.sendError(req, res, 501, 'NotImplemented');
			return;
		}

		if (query.get('restype') === 'container' && name === '') {
			if (method === 'PUT') {
				if (this.containers.has(container)) {
					this.sendError(req, res, 409, 'ContainerAlreadyExists');
					return;
				}
				this.containers.add(container);
				res.writeHead(201, {
					...this.baseHeaders(req),
					ETag: '"0x1"',
					'Last-Modified': LAST_MODIFIED,
				});
				res.end();
				return;
			}
			if (!this.containers.has(container)) {
				this.sendError(req, res, 404, 'ContainerNotFound');
				return;
			}
			if (method === 'GET' && query.get('comp') === 'list') {
				this.listBlobs(req, container, query, res);
				return;
			}
			if (method === 'GET' || method === 'HEAD') {
				res.writeHead(200, {
					...this.baseHeaders(req),
					ETag: '"0x1"',
					'Last-Modified': LAST_MODIFIED,
					'x-ms-lease-status': 'unlocked',
					'x-ms-lease-state': 'available',
					'x-ms-has-immutability-policy': 'false',
					'x-ms-has-legal-hold': 'false',
				});
				res.end();
				return;
			}
			if (method === 'DELETE') {
				this.containers.delete(container);
				res.writeHead(202, this.baseHeaders(req));
				res.end();
				return;
			}
			this.sendError(req, res, 501, 'NotImplemented');
			return;
		}

		if (!this.containers.has(container)) {
			this.sendError(req, res, 404, 'ContainerNotFound');
			return;
		}

		const blobId = `${container}/${name}`;

		if (method === 'PUT' && query.get('comp') === 'block') {
			const blockId = query.get('blockid') ?? '';
			const blocks = this.staged.get(blobId) ?? new Map<string, Buffer>();
			blocks.set(blockId, body);
			this.staged.set(blobId, blocks);
			res.writeHead(201, { ...this.baseHeaders(req), 'x-ms-request-server-encrypted': 'true' });
			res.end();
			return;
		}

		if (method === 'PUT' && query.get('comp') === 'blocklist') {
			const ids = [
				...body.toString('utf-8').matchAll(/<(?:Latest|Uncommitted|Committed)>([^<]*)<\//g),
			].map((match) => match[1]);
			const blocks = this.staged.get(blobId) ?? new Map<string, Buffer>();
			const data = Buffer.concat(ids.map((id) => blocks.get(id) ?? Buffer.alloc(0)));
			this.staged.delete(blobId);
			this.storeFromHeaders(blobId, data, req.headers, 'x-ms-blob-');
			res.writeHead(201, {
				...this.baseHeaders(req),
				ETag: etagOf(data),
				'Last-Modified': LAST_MODIFIED,
				'x-ms-request-server-encrypted': 'true',
			});
			res.end();
			return;
		}

		if (method === 'PUT' && req.headers['x-ms-copy-source']) {
			const source = new URL(String(req.headers['x-ms-copy-source']));
			const sourceSegments = source.pathname.split('/').slice(1).map(decodeURIComponent);
			const sourceId = sourceSegments.slice(1).join('/');
			const sourceBlob = this.blobs.get(sourceId);
			if (!sourceBlob) {
				this.sendError(req, res, 404, 'CannotVerifyCopySource');
				return;
			}
			const metadata = this.metadataFrom(req.headers);
			this.blobs.set(blobId, {
				...sourceBlob,
				body: Buffer.from(sourceBlob.body),
				metadata: Object.keys(metadata).length > 0 ? metadata : { ...sourceBlob.metadata },
			});
			res.writeHead(202, {
				...this.baseHeaders(req),
				ETag: etagOf(sourceBlob.body),
				'Last-Modified': LAST_MODIFIED,
				'x-ms-copy-id': 'fake-copy-id',
				'x-ms-copy-status': 'success',
			});
			res.end();
			return;
		}

		if (method === 'PUT') {
			this.storeFromHeaders(blobId, body, req.headers, 'x-ms-blob-');
			res.writeHead(201, {
				...this.baseHeaders(req),
				ETag: etagOf(body),
				'Last-Modified': LAST_MODIFIED,
				'Content-MD5': createHash('md5').update(body).digest('base64'),
				'x-ms-request-server-encrypted': 'true',
			});
			res.end();
			return;
		}

		if (method === 'GET' || method === 'HEAD') {
			const blob = this.blobs.get(blobId);
			if (!blob) {
				this.sendError(req, res, 404, 'BlobNotFound');
				return;
			}
			const headers: Record<string, string> = {
				...this.baseHeaders(req),
				'Last-Modified': LAST_MODIFIED,
				'x-ms-creation-time': LAST_MODIFIED,
				ETag: etagOf(blob.body),
				'Accept-Ranges': 'bytes',
				'Content-Type': blob.contentType ?? 'application/octet-stream',
				'x-ms-blob-type': 'BlockBlob',
				'x-ms-lease-status': 'unlocked',
				'x-ms-lease-state': 'available',
				'x-ms-server-encrypted': 'true',
			};
			if (blob.contentDisposition) headers['Content-Disposition'] = blob.contentDisposition;
			if (blob.contentEncoding) headers['Content-Encoding'] = blob.contentEncoding;
			if (blob.cacheControl) headers['Cache-Control'] = blob.cacheControl;
			for (const [key, value] of Object.entries(blob.metadata)) headers[`x-ms-meta-${key}`] = value;
			let status = 200;
			let payload = blob.body;
			const range = String(req.headers['x-ms-range'] ?? req.headers.range ?? '');
			const match = /^bytes=(\d+)-(\d*)$/.exec(range);
			if (match) {
				const start = Number(match[1]);
				const end =
					match[2] === '' ? blob.body.length - 1 : Math.min(Number(match[2]), blob.body.length - 1);
				payload = blob.body.subarray(start, end + 1);
				headers['Content-Range'] = `bytes ${start}-${end}/${blob.body.length}`;
				status = 206;
			}
			headers['Content-Length'] = String(payload.length);
			res.writeHead(status, headers);
			res.end(method === 'HEAD' ? undefined : payload);
			return;
		}

		if (method === 'DELETE') {
			if (!this.blobs.has(blobId)) {
				this.sendError(req, res, 404, 'BlobNotFound');
				return;
			}
			this.blobs.delete(blobId);
			res.writeHead(202, { ...this.baseHeaders(req), 'x-ms-delete-type-permanent': 'true' });
			res.end();
			return;
		}

		this.sendError(req, res, 501, 'NotImplemented');
	}

	private metadataFrom(headers: http.IncomingHttpHeaders) {
		const metadata: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			if (value === undefined || !name.startsWith('x-ms-meta-')) continue;
			metadata[name.slice('x-ms-meta-'.length)] = Array.isArray(value) ? value.join(',') : value;
		}
		return metadata;
	}

	private storeFromHeaders(
		blobId: string,
		body: Buffer,
		headers: http.IncomingHttpHeaders,
		prefix: string,
	) {
		const text = (name: string) => {
			const value = headers[name];
			return typeof value === 'string' ? value : undefined;
		};
		this.blobs.set(blobId, {
			body,
			contentType: text(`${prefix}content-type`),
			contentDisposition: text(`${prefix}content-disposition`),
			contentEncoding: text(`${prefix}content-encoding`),
			cacheControl: text(`${prefix}cache-control`),
			metadata: this.metadataFrom(headers),
		});
	}

	private listBlobs(
		req: http.IncomingMessage,
		container: string,
		query: URLSearchParams,
		res: http.ServerResponse,
	) {
		const prefix = query.get('prefix') ?? '';
		const maxResults = Number(query.get('maxresults') ?? '5000');
		const marker = query.get('marker') ?? '';
		const names = [...this.blobs.keys()]
			.filter((id) => id.startsWith(`${container}/`))
			.map((id) => id.slice(container.length + 1))
			.filter((name) => name.startsWith(prefix) && name > marker)
			.sort();
		const page = names.slice(0, maxResults);
		const next = names.length > page.length ? page[page.length - 1] : '';
		const items = page
			.map((name) => {
				const blob = this.blobs.get(`${container}/${name}`);
				return `<Blob><Name>${xmlEscape(name)}</Name><Properties><Last-Modified>${LAST_MODIFIED}</Last-Modified><Etag>${etagOf(blob?.body ?? Buffer.alloc(0))}</Etag><Content-Length>${blob?.body.length ?? 0}</Content-Length><Content-Type>${xmlEscape(blob?.contentType ?? 'application/octet-stream')}</Content-Type><BlobType>BlockBlob</BlobType></Properties></Blob>`;
			})
			.join('');
		const xml = `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="${this.blobEndpoint}/" ContainerName="${xmlEscape(container)}"><Prefix>${xmlEscape(prefix)}</Prefix><MaxResults>${maxResults}</MaxResults><Blobs>${items}</Blobs><NextMarker>${xmlEscape(next)}</NextMarker></EnumerationResults>`;
		const payload = Buffer.from(xml);
		res.writeHead(200, {
			...this.baseHeaders(req),
			'Content-Type': 'application/xml',
			'Content-Length': String(payload.length),
		});
		res.end(payload);
	}

	private sendError(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		status: number,
		code: string,
		message = `Fake Azure error ${code}`,
	) {
		const headers = { ...this.baseHeaders(req), 'x-ms-error-code': code };
		if (req.method === 'HEAD') {
			res.writeHead(status, headers);
			res.end();
			return;
		}
		const payload = Buffer.from(
			`<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`,
		);
		res.writeHead(status, {
			...headers,
			'Content-Type': 'application/xml',
			'Content-Length': String(payload.length),
		});
		res.end(payload);
	}
}
