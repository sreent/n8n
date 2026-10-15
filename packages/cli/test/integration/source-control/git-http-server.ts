import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A request that the server answered, without the parts that change from run to run. */
export interface GitHttpRequest {
	method: string;
	path: string;
	service: string | null;
	auth: 'none' | 'valid' | 'invalid';
	status: number;
}

/**
 * Fork test helper (not in upstream n8n): a local Git server over HTTPS for the golden tests of
 * source control. It serves the bare repositories of a folder with `git http-backend`, asks for
 * Basic authentication, and uses a self-signed certificate. `GIT_SSL_CAINFO` tells Git to trust
 * the certificate.
 */
export class LocalGitHttpServer {
	readonly dir = mkdtempSync(path.join(tmpdir(), 'n8n-sc-https-'));

	readonly certFile = path.join(this.dir, 'cert.pem');

	private readonly keyFile = path.join(this.dir, 'key.pem');

	private server: Server | undefined;

	port = 0;

	requests: GitHttpRequest[] = [];

	/** Connection events, for debugging. */
	events: string[] = [];

	/** The user name and the password that the server accepts. */
	credentials = { username: 'git-user', password: 'git-token' };

	constructor(private readonly projectRoot: string) {}

	get origin() {
		return `https://127.0.0.1:${this.port}`;
	}

	async start() {
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-keyout',
				this.keyFile,
				'-out',
				this.certFile,
				'-days',
				'2',
				'-subj',
				'/CN=localhost',
				'-addext',
				'subjectAltName=DNS:localhost,IP:127.0.0.1',
			],
			{ stdio: 'ignore' },
		);
		const server = createServer(
			{ key: readFileSync(this.keyFile), cert: readFileSync(this.certFile) },
			(request, response) => this.handle(request, response),
		);
		server.on('connection', () => this.events.push('connection'));
		server.on('tlsClientError', (error) => this.events.push(`tlsClientError: ${error.message}`));
		server.on('secureConnection', () => this.events.push('secureConnection'));
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		this.server = server;
		const address = server.address();
		this.port = typeof address === 'object' && address ? (address as AddressInfo).port : 0;
	}

	async stop() {
		const server = this.server;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		rmSync(this.dir, { recursive: true, force: true });
	}

	/** The requests since the last read. */
	takeRequests() {
		const requests = this.requests;
		this.requests = [];
		return requests;
	}

	private handle(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? '/', 'https://localhost');
		const header = request.headers.authorization;
		let auth: GitHttpRequest['auth'] = 'none';
		let user = '';
		if (header?.startsWith('Basic ')) {
			const [name, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf-8').split(':');
			const valid =
				name === this.credentials.username && rest.join(':') === this.credentials.password;
			auth = valid ? 'valid' : 'invalid';
			if (valid) user = name;
		}
		const entry: GitHttpRequest = {
			method: request.method ?? '',
			path: url.pathname,
			service: url.searchParams.get('service'),
			auth,
			status: 0,
		};
		this.requests.push(entry);
		if (!user) {
			entry.status = 401;
			response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
			response.end();
			return;
		}
		const child = spawn('git', ['http-backend'], {
			env: {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				GIT_PROJECT_ROOT: this.projectRoot,
				GIT_HTTP_EXPORT_ALL: '1',
				PATH_INFO: url.pathname,
				REQUEST_METHOD: request.method ?? 'GET',
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: request.headers['content-type'] ?? '',
				CONTENT_LENGTH: request.headers['content-length'] ?? '',
				HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
				GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
				REMOTE_USER: user,
				REMOTE_ADDR: '127.0.0.1',
			},
		});
		request.pipe(child.stdin);
		let head = Buffer.alloc(0);
		let headersSent = false;
		child.stdout.on('data', (chunk: Buffer) => {
			if (headersSent) {
				response.write(chunk);
				return;
			}
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf('\r\n\r\n');
			if (end === -1) return;
			const lines = head.subarray(0, end).toString('utf-8').split('\r\n');
			let status = 200;
			const headers: Record<string, string> = {};
			for (const line of lines) {
				const index = line.indexOf(':');
				const name = line.slice(0, index).trim();
				const value = line.slice(index + 1).trim();
				if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
				else headers[name] = value;
			}
			entry.status = status;
			response.writeHead(status, headers);
			headersSent = true;
			response.write(head.subarray(end + 4));
		});
		child.stdout.on('end', () => response.end());
		child.on('error', () => {
			entry.status = 500;
			if (!headersSent) response.writeHead(500);
			response.end();
		});
	}
}
