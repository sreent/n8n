import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

/** Fork test helper (scratch): an HTTP proxy that logs CONNECT and plain requests and passes them on. */
export class ConnectProxy {
	log: string[] = [];

	private server: Server | undefined;

	port = 0;

	get url() {
		return `http://127.0.0.1:${this.port}`;
	}

	async start(port = 0) {
		const server = createServer((request, response) => {
			this.log.push(`${request.method} ${request.url}`);
			response.writeHead(502);
			response.end();
		});
		server.on('connect', (request, socket, head) => {
			this.log.push(`CONNECT ${request.url}`);
			const [host, port] = (request.url ?? '').split(':');
			const upstream = connect(Number(port), host, () => {
				socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				upstream.write(head);
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
		});
		await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
		this.server = server;
		const address = server.address();
		this.port = typeof address === 'object' && address ? address.port : port;
	}

	take() {
		const log = this.log;
		this.log = [];
		return log;
	}

	/** The distinct requests since the last read, with a count and without ports. */
	takeSummary() {
		const counts = new Map<string, number>();
		for (const line of this.take()) {
			const masked = line.replace(/:\d+$/, ':<port>');
			counts.set(masked, (counts.get(masked) ?? 0) + 1);
		}
		return [...counts].map(([line, count]) => `${line} x${count}`).sort();
	}

	async stop() {
		const server = this.server;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		this.server = undefined;
	}
}
