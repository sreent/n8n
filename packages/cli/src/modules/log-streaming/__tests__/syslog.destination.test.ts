import { mockLogger } from '@n8n/backend-test-utils';
import { DateTime } from 'luxon';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { hostname } from 'node:os';

import { EventMessageAudit } from '@/eventbus/event-message-classes/event-message-audit';
import { EventMessageWorkflow } from '@/eventbus/event-message-classes/event-message-workflow';

import {
	buildDestinationOptions,
	type SyslogDestinationOptions,
} from '../destinations/destination-options';
import { SyslogDestination } from '../destinations/syslog.destination';

const ID = '3f1b8a52-6e7c-4f0e-9a51-2d9c7f8e1a20';

const loginEvent = () =>
	new EventMessageAudit({
		id: 'b1d6a3a2-8f0c-4d3e-9c1b-7a6e5f4d3c2b',
		eventName: 'n8n.audit.user.login.success',
		ts: DateTime.fromISO('2026-10-01T10:00:00.000Z', { zone: 'utc' }),
		payload: { userId: 'user-1', _email: 'ann@example.com' },
	});

function syslogOptions(input: Partial<SyslogDestinationOptions> = {}): SyslogDestinationOptions {
	const options = buildDestinationOptions(
		{
			__type: '$$MessageEventBusDestinationSyslog',
			host: '127.0.0.1',
			enabled: true,
			subscribedEvents: ['*'],
			...input,
		},
		ID,
	);
	if (options?.__type !== '$$MessageEventBusDestinationSyslog') throw new Error('Invalid options');
	return options;
}

describe('SyslogDestination', () => {
	describe('format', () => {
		it('gives an RFC 5424 message with the event as JSON', () => {
			const destination = new SyslogDestination(
				syslogOptions({ facility: 16, app_name: 'n8n prod' }),
				mockLogger(),
			);

			const line = destination.format(loginEvent());

			const [header, json] = [
				line.slice(0, line.indexOf(' {')),
				line.slice(line.indexOf(' {') + 1),
			];
			expect(header).toBe(
				`<134>1 2026-10-01T10:00:00.000Z ${hostname()} n8n_prod ${process.pid} - -`,
			);
			expect(JSON.parse(json)).toEqual({
				__type: '$$EventMessageAudit',
				id: 'b1d6a3a2-8f0c-4d3e-9c1b-7a6e5f4d3c2b',
				ts: '2026-10-01T10:00:00.000Z',
				eventName: 'n8n.audit.user.login.success',
				message: 'n8n.audit.user.login.success',
				payload: { userId: 'user-1', _email: 'ann@example.com' },
			});
		});

		it('gives a failed event the severity error', () => {
			const destination = new SyslogDestination(syslogOptions({ facility: 1 }), mockLogger());

			const line = destination.format(
				new EventMessageWorkflow({ eventName: 'n8n.workflow.failed' }),
			);

			expect(line.startsWith('<11>1 ')).toBe(true);
		});
	});

	describe('over UDP', () => {
		it('sends one datagram for each event', async () => {
			const server = createSocket('udp4');
			const received = new Promise<string>((resolve) =>
				server.once('message', (data) => resolve(data.toString())),
			);
			await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
			const destination = new SyslogDestination(
				syslogOptions({ protocol: 'udp', port: server.address().port }),
				mockLogger(),
			);

			try {
				await expect(destination.deliver(loginEvent())).resolves.toBe(true);
				expect(await received).toMatch(/^<134>1 .*"eventName":"n8n.audit.user.login.success"/);
			} finally {
				await destination.close();
				server.close();
			}
		});
	});

	describe('over TCP', () => {
		let server: Server;
		let lines: string[];
		let connections: number;

		beforeEach(async () => {
			lines = [];
			connections = 0;
			server = createServer((socket) => {
				connections++;
				let buffer = '';
				socket.on('data', (data) => {
					buffer += data.toString();
					const parts = buffer.split('\n');
					buffer = parts.pop() ?? '';
					lines.push(...parts);
				});
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		});

		afterEach(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		const port = () => (server.address() as AddressInfo).port;

		it('sends the events in order over one connection, each with the line end', async () => {
			const destination = new SyslogDestination(
				syslogOptions({ protocol: 'tcp', port: port() }),
				mockLogger(),
			);

			try {
				const first = new EventMessageWorkflow({ eventName: 'n8n.workflow.started' });
				const second = new EventMessageWorkflow({ eventName: 'n8n.workflow.success' });
				expect(
					await Promise.all([destination.deliver(first), destination.deliver(second)]),
				).toEqual([true, true]);

				await vi.waitFor(() => expect(lines).toHaveLength(2));
				expect(lines[0]).toContain('"eventName":"n8n.workflow.started"');
				expect(lines[1]).toContain('"eventName":"n8n.workflow.success"');
				expect(connections).toBe(1);
			} finally {
				await destination.close();
			}
		});

		it('fails when no server listens', async () => {
			const closedPort = port();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			server = createServer();
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const destination = new SyslogDestination(
				syslogOptions({ protocol: 'tcp', port: closedPort }),
				mockLogger(),
			);

			try {
				await expect(destination.sendTest(loginEvent())).resolves.toBe(false);
			} finally {
				await destination.close();
			}
		});
	});
});
