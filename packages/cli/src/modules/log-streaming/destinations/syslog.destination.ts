import type { Logger } from '@n8n/backend-common';
import { OperationalError } from 'n8n-workflow';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { connect as connectTcp, isIP, isIPv6, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as connectTls } from 'node:tls';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';

import type { SyslogDestinationOptions } from './destination-options';
import { isErrorEvent, LogStreamingDestination } from './log-streaming-destination';
import { DELIVERY_CONCURRENCY, SYSLOG_SOCKET_TIMEOUT_MS } from '../log-streaming.constants';

const DEFAULT_PORT = 514;
const DEFAULT_FACILITY = 16;

/** The syslog severities that the events use (RFC 5424). */
const SEVERITY_ERROR = 3;
const SEVERITY_INFORMATIONAL = 6;

/** A header field of RFC 5424: printable US-ASCII without spaces, else `-`. */
function headerField(value: string | number | undefined, maxLength: number) {
	const text = String(value ?? '')
		.replace(/[^\x21-\x7e]/g, '_')
		.slice(0, maxLength);
	return text || '-';
}

/**
 * Sends each event as an RFC 5424 message to a syslog server, over UDP, TCP or TLS. The message
 * text is the event as JSON. Over TCP and TLS, `eol` ends each message, and one connection stays
 * open for the deliveries. One delivery runs at a time, so the server gets the events in order.
 */
export class SyslogDestination extends LogStreamingDestination<SyslogDestinationOptions> {
	private socket: Socket | undefined;

	private connecting: Promise<Socket> | undefined;

	private udpSocket: UdpSocket | undefined;

	constructor(options: SyslogDestinationOptions, logger: Logger) {
		super(options, logger, DELIVERY_CONCURRENCY.syslog);
	}

	private get port() {
		return this.options.port ?? DEFAULT_PORT;
	}

	protected async send(message: EventMessageTypes) {
		const line = this.format(message);
		if (this.options.protocol === 'udp') {
			await this.sendDatagram(line);
		} else {
			await this.write(`${line}${this.options.eol ?? '\n'}`);
		}
	}

	/** The RFC 5424 message of an event. */
	format(message: EventMessageTypes) {
		const facility = this.options.facility ?? DEFAULT_FACILITY;
		const severity = isErrorEvent(message.eventName) ? SEVERITY_ERROR : SEVERITY_INFORMATIONAL;
		const timestamp = message.ts.toUTC().toISO() ?? '-';
		const header = [
			`<${facility * 8 + severity}>1`,
			timestamp,
			headerField(hostname(), 255),
			headerField(this.options.app_name, 48),
			headerField(process.pid, 128),
			'-',
			'-',
		].join(' ');
		return `${header} ${JSON.stringify(this.serialize(message))}`;
	}

	protected async dispose() {
		this.udpSocket?.close();
		this.udpSocket = undefined;
		this.socket?.end();
		this.socket = undefined;
	}

	private async sendDatagram(line: string) {
		const socket = (this.udpSocket ??= this.createUdpSocket());
		await new Promise<void>((resolve, reject) => {
			socket.send(line, this.port, this.options.host, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	private createUdpSocket() {
		const socket = createSocket(isIPv6(this.options.host) ? 'udp6' : 'udp4');
		socket.on('error', (error) => {
			this.logger.debug(
				`Syslog destination "${this.label}" closed its UDP socket: ${error.message}`,
			);
			socket.close();
			if (this.udpSocket === socket) this.udpSocket = undefined;
		});
		socket.unref();
		return socket;
	}

	private async write(data: string) {
		const socket = await this.connection();
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new OperationalError('The syslog server did not take the message in time'));
			}, SYSLOG_SOCKET_TIMEOUT_MS);
			socket.write(data, (error) => {
				clearTimeout(timer);
				if (error) reject(error);
				else resolve();
			});
		});
	}

	/** The open connection, else a new one. */
	private async connection(): Promise<Socket> {
		if (this.socket && !this.socket.destroyed) return this.socket;
		this.connecting ??= this.connect().finally(() => {
			this.connecting = undefined;
		});
		return await this.connecting;
	}

	private async connect(): Promise<Socket> {
		const { host, protocol, tlsCa } = this.options;
		const secure = protocol === 'tls';
		const socket = secure
			? connectTls({
					host,
					port: this.port,
					ca: tlsCa || undefined,
					servername: isIP(host) ? undefined : host,
				})
			: connectTcp({ host, port: this.port });

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.destroy(new OperationalError('The connection to the syslog server timed out'));
			}, SYSLOG_SOCKET_TIMEOUT_MS);
			socket.once(secure ? 'secureConnect' : 'connect', () => {
				clearTimeout(timer);
				resolve();
			});
			socket.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});

		// A syslog server sends nothing back. Reading drops any data, so that no buffer fills.
		socket.resume();
		socket.setKeepAlive(true);
		socket.unref();
		socket.on('error', (error) => {
			this.logger.debug(`Syslog destination "${this.label}" lost its connection: ${error.message}`);
		});
		socket.on('close', () => {
			if (this.socket === socket) this.socket = undefined;
		});
		this.socket = socket;
		return socket;
	}
}
