import { createHash } from 'node:crypto';
import http from 'node:http';

/**
 * Fork test helper (not in upstream n8n): the shared parts of the fake S3 and Azure Blob servers
 * of the golden storage tests. It records each request in a form that does not change from run to
 * run: dates, signatures, request ids and ports are masked.
 */

export type RecordedBody = string | { length: number; sha256: string } | null;

export type RecordedRequest = {
	method: string;
	host: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string>;
	body: RecordedBody;
	decodedBody?: RecordedBody;
	trailers?: string[];
};

/** Makes the server fail the next `times` requests whose path matches. */
export type FailureRule = {
	match: RegExp;
	method?: string;
	times: number;
	status?: number;
	code?: string;
	delayMs?: number;
	/** Never answer. */
	hang?: boolean;
	/** Answer with a body that ends early: the server closes the connection. */
	truncate?: boolean;
};

export async function readBody(req: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}

export function sortedQuery(params: URLSearchParams): Record<string, string> {
	const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
	return Object.fromEntries(entries);
}

const MASKED = new Set([
	'x-amz-date',
	'x-ms-date',
	'date',
	'amz-sdk-invocation-id',
	'x-ms-client-request-id',
	'traceparent',
]);

const SKIPPED = new Set(['connection', 'host', 'keep-alive']);

/** Masks the parts of a user agent that depend on the machine. */
function normalizeUserAgent(value: string) {
	return value
		.replace(/os\/[^\s]+/g, 'os/<os>')
		.replace(/md\/nodejs#[^\s]+/g, 'md/nodejs#<node>')
		.replace(/Node\/[^\s)]+/g, 'Node/<node>')
		.replace(/OS\/[^)]+\)/g, 'OS/<os>)')
		.replace(/\(NODE-VERSION [^;]+;/g, '(NODE-VERSION <node>;')
		.replace(/\((Linux|Darwin|Windows_NT) [^)]*\)/g, '(<os>)');
}

/** Keeps the scheme, the access key, the scope and the signed headers of a signature. */
function normalizeAuthorization(value: string) {
	if (value.startsWith('AWS4-HMAC-SHA256')) {
		return value
			.replace(/Credential=([^/]*)\/\d{8}\//, 'Credential=$1/<date>/')
			.replace(/Signature=[0-9a-f]+/, 'Signature=<signature>');
	}
	if (value.startsWith('SharedKey ')) {
		return value.replace(/:([^:]+)$/, ':<signature>');
	}
	if (value.startsWith('Bearer ')) return 'Bearer <token>';
	return '<other>';
}

export function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of Object.keys(headers).sort()) {
		if (SKIPPED.has(name)) continue;
		const raw = headers[name];
		if (raw === undefined) continue;
		const value = Array.isArray(raw) ? raw.join(', ') : raw;
		if (MASKED.has(name)) result[name] = '<masked>';
		else if (name === 'authorization') result[name] = normalizeAuthorization(value);
		else if (name === 'user-agent' || name === 'x-amz-user-agent' || name === 'x-ms-useragent')
			result[name] = normalizeUserAgent(value);
		else if (name === 'x-ms-copy-source' || name === 'x-amz-copy-source')
			result[name] = value.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:PORT');
		else result[name] = value;
	}
	return result;
}

const isText = (contentType: string | undefined) =>
	contentType !== undefined && /xml|json|text|multipart/.test(contentType);

export function describeBody(body: Buffer, contentType: string | undefined): RecordedBody {
	if (body.length === 0) return null;
	if (isText(contentType) && body.length <= 4096) return body.toString('utf-8');
	return { length: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}

export type LogCall = { level: string; scopes: string[]; message: string; metadata: unknown };

/** Replaces the ports of the local test servers. */
export const maskPorts = (text: string) =>
	text
		.replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:PORT')
		// A TLS request to a plain HTTP server fails with an OpenSSL text that depends on timing.
		.replace(/EPROTO [0-9A-F]*:error:[^\n]*\n?/g, 'EPROTO <tls error>');

/** A logger for the container that records each call. */
export function createRecordingLogger(calls: LogCall[], scopes: string[] = []) {
	const record =
		(level: string) =>
		(message: string, metadata: unknown = {}) => {
			calls.push({ level, scopes, message: maskPorts(message), metadata: describeValue(metadata) });
		};
	const logger = {
		error: record('error'),
		warn: record('warn'),
		info: record('info'),
		debug: record('debug'),
		scoped: (next: string | string[]) =>
			createRecordingLogger(calls, [...scopes, ...(Array.isArray(next) ? next : [next])]),
	};
	return logger;
}

/** Describes a value for a snapshot: errors by class and message, buffers by size. */
export function describeValue(value: unknown, depth = 0): unknown {
	if (depth > 4) return '<deep>';
	if (value instanceof Error) return describeError(value, depth + 1);
	if (Buffer.isBuffer(value)) return { buffer: value.length };
	if (Array.isArray(value)) return value.map((item) => describeValue(item, depth + 1));
	if (value && typeof value === 'object') {
		const entries = Object.entries(value).map(([key, item]) => [
			key,
			describeValue(item, depth + 1),
		]);
		return Object.fromEntries(entries);
	}
	if (typeof value === 'string') return maskPorts(value);
	return value;
}

export function describeError(error: unknown, depth = 0): unknown {
	if (!(error instanceof Error)) return { thrown: describeValue(error, depth + 1) };
	const record: Record<string, unknown> = {
		class: error.constructor.name,
		name: error.name,
		message: maskPorts(error.message),
	};
	const extra = error as Error & {
		level?: unknown;
		extra?: unknown;
		cause?: unknown;
		code?: unknown;
		Code?: unknown;
		statusCode?: unknown;
		$metadata?: { httpStatusCode?: number; attempts?: number };
	};
	if (extra.level !== undefined) record.level = extra.level;
	if (extra.extra !== undefined) record.extra = describeValue(extra.extra, depth + 1);
	if (extra.code !== undefined) record.code = extra.code;
	if (extra.statusCode !== undefined) record.statusCode = extra.statusCode;
	const details = (error as Error & { details?: { errorCode?: unknown } }).details;
	if (details && typeof details === 'object' && details.errorCode !== undefined) {
		record.errorCode = details.errorCode;
	}
	if (extra.$metadata !== undefined) {
		record.httpStatusCode = extra.$metadata.httpStatusCode;
		record.attempts = extra.$metadata.attempts;
	}
	if (extra.cause !== undefined && depth < 3) record.cause = describeError(extra.cause, depth + 1);
	return record;
}

type LookupCallback = (error: Error | null, address: unknown, family?: number) => void;

/**
 * Resolves each `*.localhost` and `*.test` name to 127.0.0.1, for the virtual-hosted URLs of a
 * bucket, and the names of AWS and Azure too, so that no test reaches the cloud. Records each name
 * that is looked up. Gives a function that restores the lookup.
 */
export function resolveLocalhostSubdomains(dns: typeof import('node:dns'), lookups: string[] = []) {
	const original = dns.lookup;
	const patched = (hostname: string, options: unknown, next?: LookupCallback) => {
		const done = (typeof options === 'function' ? options : next) as LookupCallback;
		const all = typeof options === 'object' && options !== null && 'all' in options && options.all;
		lookups.push(hostname);
		if (
			hostname.endsWith('.localhost') ||
			hostname.endsWith('.test') ||
			hostname.endsWith('.amazonaws.com') ||
			hostname.endsWith('.core.windows.net')
		) {
			if (all) done(null, [{ address: '127.0.0.1', family: 4 }]);
			else done(null, '127.0.0.1', 4);
			return;
		}
		return (original as (...args: unknown[]) => unknown).call(dns, hostname, options, next);
	};
	(dns as { lookup: unknown }).lookup = patched;
	return () => {
		(dns as { lookup: unknown }).lookup = original;
	};
}

/** A forward proxy for plain HTTP that records each request and passes it on. */
export class FakeProxy {
	readonly requests: string[] = [];

	port = 0;

	private readonly server = http.createServer((req, res) => {
		this.requests.push(`${req.method} ${maskPorts(req.url ?? '')}`);
		let target: URL;
		try {
			target = new URL(req.url ?? '');
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		const upstream = http.request(
			{
				host: target.hostname,
				port: target.port,
				method: req.method,
				path: `${target.pathname}${target.search}`,
				headers: req.headers,
			},
			(response) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(res);
			},
		);
		upstream.on('error', () => {
			res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	});

	constructor() {
		this.server.on('connect', (req, socket) => {
			this.requests.push(`CONNECT ${maskPorts(req.url ?? '')}`);
			socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
		});
	}

	async start() {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const address = this.server.address();
		this.port = typeof address === 'object' && address ? address.port : 0;
	}

	async stop() {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

const PROXY_VARIABLES = [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'http_proxy',
	'https_proxy',
	'NO_PROXY',
	'no_proxy',
];

/** Runs `fn` with the proxy variables set to the fake proxy and no bypass. */
export async function withProxy<T>(proxy: FakeProxy, fn: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(PROXY_VARIABLES.map((name) => [name, process.env[name]]));
	const url = `http://127.0.0.1:${proxy.port}`;
	process.env.HTTP_PROXY = url;
	process.env.HTTPS_PROXY = url;
	process.env.http_proxy = url;
	process.env.https_proxy = url;
	process.env.NO_PROXY = '';
	process.env.no_proxy = '';
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}
