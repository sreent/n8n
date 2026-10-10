// A minimal HTTP/1.1 server for the fake secret stores of the golden tests. It accepts any
// request method, also `LIST`, which the Vault API uses and which the HTTP parser of Node.js
// refuses. It reads bodies with a Content-Length or with chunked transfer encoding, and keeps
// connections open between requests.
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface RawRequest {
	method: string;
	/** The path with the query string. */
	url: string;
	/** Header names in lower case. */
	headers: Record<string, string>;
	body: string;
}

export interface RawResponse {
	status: number;
	headers?: Record<string, string>;
	body?: unknown;
}

export interface RawServer {
	url: string;
	close: () => Promise<void>;
}

const STATUS_TEXT: Record<number, string> = {
	200: 'OK',
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	503: 'Service Unavailable',
};

/** Parse one request from the start of the buffer. Returns undefined when more bytes are needed. */
function parseRequest(buffer: Buffer): { request: RawRequest; rest: Buffer } | undefined {
	const headerEnd = buffer.indexOf('\r\n\r\n');
	if (headerEnd === -1) return undefined;
	const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
	const [method, url] = lines[0].split(' ');
	const headers: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
	}
	let offset = headerEnd + 4;
	let body: Buffer;
	if (headers['transfer-encoding']?.toLowerCase() === 'chunked') {
		const parts: Buffer[] = [];
		for (;;) {
			const lineEnd = buffer.indexOf('\r\n', offset);
			if (lineEnd === -1) return undefined;
			const size = parseInt(buffer.subarray(offset, lineEnd).toString('latin1'), 16);
			const start = lineEnd + 2;
			if (buffer.length < start + size + 2) return undefined;
			parts.push(buffer.subarray(start, start + size));
			offset = start + size + 2;
			if (size === 0) break;
		}
		body = Buffer.concat(parts);
	} else {
		const length = Number(headers['content-length'] ?? 0);
		if (buffer.length < offset + length) return undefined;
		body = buffer.subarray(offset, offset + length);
		offset += length;
	}
	return {
		request: { method, url, headers, body: body.toString('utf8') },
		rest: buffer.subarray(offset),
	};
}

function serialize(response: RawResponse) {
	const text =
		response.body === undefined
			? ''
			: typeof response.body === 'string'
				? response.body
				: JSON.stringify(response.body);
	const payload = Buffer.from(text, 'utf8');
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...response.headers,
		'content-length': String(payload.length),
		connection: 'keep-alive',
	};
	const head =
		`HTTP/1.1 ${response.status} ${STATUS_TEXT[response.status] ?? 'Status'}\r\n` +
		Object.entries(headers)
			.map(([name, value]) => `${name}: ${value}\r\n`)
			.join('') +
		'\r\n';
	return Buffer.concat([Buffer.from(head, 'latin1'), payload]);
}

export async function startRawServer(
	handler: (request: RawRequest) => Promise<RawResponse> | RawResponse,
): Promise<RawServer> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		let buffer: Buffer = Buffer.alloc(0);
		let busy = false;
		const drain = async () => {
			if (busy) return;
			busy = true;
			try {
				for (;;) {
					const parsed = parseRequest(buffer);
					if (!parsed) break;
					buffer = parsed.rest;
					const response = await handler(parsed.request);
					if (socket.destroyed) return;
					socket.write(serialize(response));
				}
			} finally {
				busy = false;
			}
		};
		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			void drain();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.listen(0, '127.0.0.1', resolve);
		server.on('error', reject);
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export function parseJsonBody(text: string): unknown {
	if (text === '') return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}
