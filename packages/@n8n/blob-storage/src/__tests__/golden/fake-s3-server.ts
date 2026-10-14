import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FailureRule, RecordedRequest } from './recording';
import { describeBody, normalizeHeaders, readBody, sortedQuery } from './recording';

/**
 * Fork test helper (not in upstream n8n): an in-memory S3 server for the golden tests of the S3
 * storage. It answers the S3 REST calls of the storage on path-style and virtual-hosted URLs, and
 * records each request.
 */

type StoredObject = {
	body: Buffer;
	contentType?: string;
	metadata: Record<string, string>;
	extraHeaders: Record<string, string>;
};

const LAST_MODIFIED = 'Wed, 14 Oct 2026 10:00:00 GMT';
const LAST_MODIFIED_ISO = '2026-10-14T10:00:00.000Z';

const etagOf = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`;

const xmlEscape = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const xmlUnescape = (value: string) =>
	value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');

/** Decodes an `aws-chunked` body: `<hex size>[;ext]\r\n<data>\r\n` ... `0[;ext]\r\n<trailers>\r\n`. */
export function decodeAwsChunked(raw: Buffer): { data: Buffer; trailers: string[] } {
	const parts: Buffer[] = [];
	let offset = 0;
	while (offset < raw.length) {
		const lineEnd = raw.indexOf('\r\n', offset);
		if (lineEnd === -1) break;
		const sizeLine = raw.subarray(offset, lineEnd).toString('latin1');
		const size = Number.parseInt(sizeLine.split(';')[0], 16);
		offset = lineEnd + 2;
		if (size === 0) {
			const trailers = raw
				.subarray(offset)
				.toString('latin1')
				.split('\r\n')
				.filter((line) => line.length > 0);
			return { data: Buffer.concat(parts), trailers };
		}
		parts.push(raw.subarray(offset, offset + size));
		offset += size + 2;
	}
	return { data: Buffer.concat(parts), trailers: [] };
}

export class FakeS3Server {
	readonly requests: RecordedRequest[] = [];

	readonly failures: FailureRule[] = [];

	readonly buckets = new Set<string>();

	private readonly objects = new Map<string, StoredObject>();

	private readonly uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();

	private readonly server = http.createServer((req, res) => {
		void this.handle(req, res);
	});

	private readonly sockets = new Set<import('node:net').Socket>();

	port = 0;

	constructor() {
		this.server.on('connection', (socket) => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
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
		this.deleteErrorKeys.clear();
		this.objects.clear();
		this.uploads.clear();
	}

	/** Stores an object directly, without a request. */
	putObject(
		bucket: string,
		key: string,
		body: Buffer,
		options: { contentType?: string; metadata?: Record<string, string> } = {},
	) {
		this.objects.set(`${bucket}/${key}`, {
			body,
			contentType: options.contentType,
			metadata: options.metadata ?? {},
			extraHeaders: {},
		});
	}

	getObject(bucket: string, key: string) {
		return this.objects.get(`${bucket}/${key}`);
	}

	objectKeys() {
		return [...this.objects.keys()].sort();
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
		const hostName = hostHeader.split(':')[0];

		// Virtual-hosted style: `<bucket>.localhost`. Path style: `/<bucket>/<key>`.
		let bucket: string;
		let key: string;
		const pathSegments = url.pathname.split('/').slice(1);
		if (hostName.endsWith('.localhost')) {
			bucket = hostName.slice(0, -'.localhost'.length);
			key = decodeURIComponent(url.pathname.slice(1));
		} else {
			bucket = decodeURIComponent(pathSegments[0] ?? '');
			key = decodeURIComponent(pathSegments.slice(1).join('/'));
		}

		const isChunked =
			(req.headers['content-encoding'] ?? '').includes('aws-chunked') ||
			String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-');
		const decoded = isChunked ? decodeAwsChunked(raw) : { data: raw, trailers: [] };

		const recorded: RecordedRequest = {
			method: req.method ?? '',
			host: hostHeader.replace(String(this.port), 'PORT'),
			path: url.pathname,
			query: sortedQuery(url.searchParams),
			headers: normalizeHeaders(req.headers),
			body: describeBody(raw, req.headers['content-type']),
			...(isChunked
				? { decodedBody: describeBody(decoded.data, undefined), trailers: decoded.trailers }
				: {}),
		};
		this.requests.push(recorded);

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
			if (failure.truncate) {
				const object = this.objects.get(`${bucket}/${key}`);
				const body = object?.body ?? Buffer.from('truncated body');
				res.writeHead(200, {
					'Content-Length': String(body.length + 100),
					'Content-Type': object?.contentType ?? 'application/octet-stream',
				});
				res.write(body);
				setTimeout(() => res.socket?.destroy(), 20);
				return;
			}
			if (failure.delayMs) await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
			if (failure.status) {
				this.sendError(res, failure.status, failure.code ?? 'InternalError', req.method === 'HEAD');
				return;
			}
		}

		try {
			this.route(req.method ?? '', bucket, key, url.searchParams, req.headers, decoded.data, res);
		} catch (error) {
			this.sendError(res, 500, 'InternalError', req.method === 'HEAD', String(error));
		}
	}

	private route(
		method: string,
		bucket: string,
		key: string,
		query: URLSearchParams,
		headers: http.IncomingHttpHeaders,
		body: Buffer,
		res: http.ServerResponse,
	) {
		const isHead = method === 'HEAD';

		if (!this.buckets.has(bucket)) {
			this.sendError(res, 404, 'NoSuchBucket', isHead);
			return;
		}

		if (key === '') {
			if (method === 'HEAD') {
				res.writeHead(200, { 'x-amz-bucket-region': 'us-east-1' });
				res.end();
				return;
			}
			if (method === 'GET' && query.get('list-type') === '2') {
				this.listObjects(bucket, query, res);
				return;
			}
			if (method === 'POST' && query.has('delete')) {
				this.deleteObjects(bucket, body, res);
				return;
			}
			this.sendError(res, 501, 'NotImplemented', isHead);
			return;
		}

		const objectId = `${bucket}/${key}`;

		if (method === 'POST' && query.has('uploads')) {
			const uploadId = `upload-${this.uploads.size + 1}`;
			this.uploads.set(uploadId, { key, parts: new Map() });
			this.pendingUploadHeaders.set(uploadId, headers);
			this.sendXml(
				res,
				200,
				`<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
			);
			return;
		}

		if (method === 'PUT' && query.has('partNumber') && query.has('uploadId')) {
			const upload = this.uploads.get(query.get('uploadId') ?? '');
			if (!upload) {
				this.sendError(res, 404, 'NoSuchUpload', false);
				return;
			}
			upload.parts.set(Number(query.get('partNumber')), body);
			res.writeHead(200, { ETag: etagOf(body) });
			res.end();
			return;
		}

		if (method === 'POST' && query.has('uploadId')) {
			const uploadId = query.get('uploadId') ?? '';
			const upload = this.uploads.get(uploadId);
			if (!upload) {
				this.sendError(res, 404, 'NoSuchUpload', false);
				return;
			}
			const ordered = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
			const data = Buffer.concat(ordered);
			this.storeFromHeaders(objectId, data, this.pendingUploadHeaders.get(uploadId) ?? {});
			this.uploads.delete(uploadId);
			this.sendXml(
				res,
				200,
				`<CompleteMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etagOf(data))}</ETag></CompleteMultipartUploadResult>`,
			);
			return;
		}

		if (method === 'DELETE' && query.has('uploadId')) {
			this.uploads.delete(query.get('uploadId') ?? '');
			res.writeHead(204);
			res.end();
			return;
		}

		if (method === 'PUT' && headers['x-amz-copy-source']) {
			const source = decodeURIComponent(String(headers['x-amz-copy-source']).replace(/^\//, ''));
			const sourceObject = this.objects.get(source);
			if (!sourceObject) {
				this.sendError(res, 404, 'NoSuchKey', false);
				return;
			}
			const replace = String(headers['x-amz-metadata-directive'] ?? '').toUpperCase() === 'REPLACE';
			if (replace) {
				this.storeFromHeaders(objectId, sourceObject.body, headers);
			} else {
				this.objects.set(objectId, { ...sourceObject, body: Buffer.from(sourceObject.body) });
			}
			this.sendXml(
				res,
				200,
				`<CopyObjectResult><LastModified>${LAST_MODIFIED_ISO}</LastModified><ETag>${xmlEscape(etagOf(sourceObject.body))}</ETag></CopyObjectResult>`,
			);
			return;
		}

		if (method === 'PUT') {
			this.storeFromHeaders(objectId, body, headers);
			res.writeHead(200, { ETag: etagOf(body) });
			res.end();
			return;
		}

		if (method === 'GET' || method === 'HEAD') {
			const object = this.objects.get(objectId);
			if (!object) {
				this.sendError(res, 404, 'NoSuchKey', isHead);
				return;
			}
			const objectHeaders: Record<string, string> = {
				'Last-Modified': LAST_MODIFIED,
				ETag: etagOf(object.body),
				'Accept-Ranges': 'bytes',
				'Content-Type': object.contentType ?? 'application/octet-stream',
				...object.extraHeaders,
			};
			for (const [name, value] of Object.entries(object.metadata)) {
				objectHeaders[`x-amz-meta-${name}`] = value;
			}
			let status = 200;
			let payload = object.body;
			const range = headers.range;
			if (range) {
				const match = /^bytes=(\d*)-(\d*)$/.exec(range);
				if (match) {
					const start = match[1] === '' ? object.body.length - Number(match[2]) : Number(match[1]);
					const end =
						match[2] === '' || match[1] === ''
							? object.body.length - 1
							: Math.min(Number(match[2]), object.body.length - 1);
					payload = object.body.subarray(start, end + 1);
					objectHeaders['Content-Range'] = `bytes ${start}-${end}/${object.body.length}`;
					status = 206;
				}
			}
			objectHeaders['Content-Length'] = String(payload.length);
			res.writeHead(status, objectHeaders);
			res.end(isHead ? undefined : payload);
			return;
		}

		if (method === 'DELETE') {
			this.objects.delete(objectId);
			res.writeHead(204);
			res.end();
			return;
		}

		this.sendError(res, 501, 'NotImplemented', isHead);
	}

	private readonly pendingUploadHeaders = new Map<string, http.IncomingHttpHeaders>();

	private storeFromHeaders(objectId: string, body: Buffer, headers: http.IncomingHttpHeaders) {
		const metadata: Record<string, string> = {};
		const extraHeaders: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			if (value === undefined) continue;
			const text = Array.isArray(value) ? value.join(',') : value;
			if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = text;
			if (
				['content-disposition', 'content-encoding', 'cache-control', 'content-language'].includes(
					name,
				)
			) {
				if (name === 'content-encoding' && text.includes('aws-chunked')) continue;
				extraHeaders[name] = text;
			}
		}
		this.objects.set(objectId, {
			body,
			contentType:
				typeof headers['content-type'] === 'string' ? headers['content-type'] : undefined,
			metadata,
			extraHeaders,
		});
	}

	private listObjects(bucket: string, query: URLSearchParams, res: http.ServerResponse) {
		const prefix = query.get('prefix') ?? '';
		const maxKeys = Number(query.get('max-keys') ?? '1000');
		const startAfter = query.get('continuation-token') ?? query.get('start-after') ?? '';
		const keys = [...this.objects.keys()]
			.filter((id) => id.startsWith(`${bucket}/`))
			.map((id) => id.slice(bucket.length + 1))
			.filter((key) => key.startsWith(prefix) && key > startAfter)
			.sort();
		const page = keys.slice(0, maxKeys);
		const truncated = keys.length > page.length;
		const contents = page
			.map((key) => {
				const object = this.objects.get(`${bucket}/${key}`);
				return `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${LAST_MODIFIED_ISO}</LastModified><ETag>${xmlEscape(etagOf(object?.body ?? Buffer.alloc(0)))}</ETag><Size>${object?.body.length ?? 0}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
			})
			.join('');
		this.sendXml(
			res,
			200,
			`<ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>` : ''}</ListBucketResult>`,
		);
	}

	/** Keys that a multi-object delete reports as not deleted. */
	readonly deleteErrorKeys = new Set<string>();

	private deleteObjects(bucket: string, body: Buffer, res: http.ServerResponse) {
		const xml = body.toString('utf-8');
		const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => xmlUnescape(match[1]));
		const quiet = /<Quiet>true<\/Quiet>/.test(xml);
		const failed = keys.filter((key) => this.deleteErrorKeys.has(key));
		const deleted = keys.filter((key) => !this.deleteErrorKeys.has(key));
		for (const key of deleted) this.objects.delete(`${bucket}/${key}`);
		const deletedXml = quiet
			? ''
			: deleted.map((key) => `<Deleted><Key>${xmlEscape(key)}</Key></Deleted>`).join('');
		const errorXml = failed
			.map(
				(key) =>
					`<Error><Key>${xmlEscape(key)}</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`,
			)
			.join('');
		this.sendXml(res, 200, `<DeleteResult>${deletedXml}${errorXml}</DeleteResult>`);
	}

	private sendXml(res: http.ServerResponse, status: number, xml: string) {
		const payload = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
		res.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': payload.length });
		res.end(payload);
	}

	private sendError(
		res: http.ServerResponse,
		status: number,
		code: string,
		isHead: boolean,
		message = `Fake S3 error ${code}`,
	) {
		if (isHead) {
			res.writeHead(status);
			res.end();
			return;
		}
		this.sendXml(
			res,
			status,
			`<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><RequestId>fake-request</RequestId></Error>`,
		);
	}
}
