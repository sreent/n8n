// Fork test (not in upstream n8n): the worker status service of the worker view as a black box.
// The test calls the service on a main instance and on a worker, with fake values of the
// operating system and the process, and records the handlers that the service registers for the
// pub/sub events, the messages that it publishes and the push messages that it sends. The
// snapshot was recorded against the enterprise service, and the fork service gives the same
// snapshot. See `../../FORK.md`.
import type { WorkerStatus } from '@n8n/api-types';
import { GlobalConfig } from '@n8n/config';
import { PubSubMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';

import { N8N_VERSION } from '@/constants';
import { Push } from '@/push';
import { JobProcessor } from '@/scaling/job-processor';
import { Publisher } from '@/scaling/pubsub/publisher.service';

import { WorkerStatusService } from './subject';

const cpuTimes = { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 };

/** The CPUs that the fake operating system gives. A scenario can change them. */
const machine = vi.hoisted(() => ({
	cpus: [] as Array<{ model: string; speed: number; times: Record<string, number> }>,
}));

const fakeOs = vi.hoisted(() => ({
	hostname: () => 'worker-host',
	cpus: () => machine.cpus,
	freemem: () => 1_000_000,
	totalmem: () => 8_000_000,
	uptime: () => 12_345,
	loadavg: () => [0.5, 0.25, 0.125],
	arch: () => 'os-arch',
	platform: () => 'os-platform',
	networkInterfaces: () => ({
		lo: [
			{
				address: '127.0.0.1',
				netmask: '255.0.0.0',
				family: 'IPv4',
				mac: '00:00:00:00:00:00',
				internal: true,
				cidr: '127.0.0.1/8',
			},
		],
		eth0: [
			{
				address: '10.0.0.2',
				netmask: '255.255.255.0',
				family: 'IPv4',
				mac: '02:42:ac:11:00:02',
				internal: false,
				cidr: '10.0.0.2/24',
			},
			{
				address: 'fe80::42:acff:fe11:2',
				netmask: 'ffff:ffff:ffff:ffff::',
				family: 'IPv6',
				mac: '02:42:ac:11:00:02',
				internal: false,
				cidr: 'fe80::42:acff:fe11:2/64',
				scopeid: 2,
			},
		],
	}),
}));

vi.mock('node:os', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, ...fakeOs, default: { ...actual, ...fakeOs } };
});

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, ...fakeOs, default: { ...actual, ...fakeOs } };
});

// #region Recorder

let entries: unknown[][] = [];

const record = (...entry: unknown[]) => entries.push(entry);

/** Values of this machine that the fakes do not set. */
const machineValues = new Map<unknown, string>([
	[N8N_VERSION, '<n8n version>'],
	[process.arch, '<process arch>'],
	[process.platform, '<process platform>'],
	[process.version, '<node version>'],
]);

function normalize(value: unknown): unknown {
	if (machineValues.has(value)) return machineValues.get(value);
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) return { error: value.constructor.name, message: value.message };
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === 'function') return '<function>';
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
	}
	return value;
}

function recorder(name: string): unknown {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (typeof property === 'symbol' || property === 'then') return undefined;
				return (...args: unknown[]) => {
					record(name, property, ...args.map(normalize));
					return undefined;
				};
			},
		},
	);
}

function settingsOf(hostId: string, instanceType: 'main' | 'worker') {
	const settings = { hostId, instanceType, instanceRole: 'unset' };
	return new Proxy(settings, {
		get(target, property, receiver) {
			if (typeof property === 'string' && !(property in target)) {
				record('instanceSettings', 'read', property);
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

const JOBS = [
	{
		executionId: '101',
		workflowId: 'wf1',
		workflowName: 'Nightly import',
		mode: 'trigger',
		startedAt: new Date('2026-03-01T11:59:00.000Z'),
		status: 'running',
	},
	{
		executionId: '102',
		workflowId: 'wf2',
		workflowName: 'Retry of a sync',
		mode: 'retry',
		startedAt: new Date('2026-03-01T11:58:30.000Z'),
		retryOf: '99',
		status: 'running',
	},
];

function setupScenario(
	options: {
		hostId?: string;
		instanceType?: 'main' | 'worker';
		jobs?: unknown[];
		pool?: { enabled: boolean; name: string };
	} = {},
) {
	Container.reset();
	entries = [];
	const config = Container.get(GlobalConfig);
	config.queue.workerPool.enabled = options.pool?.enabled ?? false;
	config.queue.workerPool.name = options.pool?.name ?? '';
	Container.set(
		InstanceSettings,
		settingsOf(
			options.hostId ?? 'worker-a',
			options.instanceType ?? 'worker',
		) as unknown as InstanceSettings,
	);
	Container.set(JobProcessor, {
		getRunningJobsSummary: () => {
			record('jobProcessor', 'getRunningJobsSummary');
			return options.jobs ?? JOBS;
		},
	} as unknown as JobProcessor);
	Container.set(Publisher, recorder('publisher') as Publisher);
	Container.set(Push, recorder('push') as Push);
	const service = Container.get(WorkerStatusService);
	const steps: unknown[] = [];
	const step = async (name: string, action: () => unknown) => {
		entries = [];
		let outcome: unknown;
		try {
			const value = await action();
			outcome = value === undefined ? 'done' : { value: normalize(value) };
		} catch (error) {
			outcome = { threw: normalize(error) };
		}
		steps.push({ step: name, outcome, calls: entries });
	};
	return { service, steps, step };
}

// #endregion

const TWO_CPUS = [
	{ model: 'Fake CPU 3000', speed: 3000, times: cpuTimes },
	{ model: 'Fake CPU 3000', speed: 3000, times: cpuTimes },
];

beforeEach(() => {
	machine.cpus = TWO_CPUS;
	vi.useFakeTimers({ now: new Date('2026-03-01T12:00:00.000Z'), toFake: ['Date'] });
	vi.spyOn(process, 'memoryUsage').mockReturnValue({
		rss: 300_000,
		heapTotal: 200_000,
		heapUsed: 100_000,
		external: 10_000,
		arrayBuffers: 5_000,
	});
	vi.spyOn(process, 'uptime').mockReturnValue(4_321);
	if ('constrainedMemory' in process)
		vi.spyOn(process, 'constrainedMemory').mockReturnValue(4_000_000);
	if ('availableMemory' in process) vi.spyOn(process, 'availableMemory').mockReturnValue(2_000_000);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	Container.reset();
});

describe('the worker status service', () => {
	test('the worker view', async () => {
		const transcript: Record<string, unknown> = {};

		transcript['the handlers of the pub/sub events'] = Container.get(PubSubMetadata)
			.getHandlers()
			.filter(({ eventHandlerClass }) => (eventHandlerClass as unknown) === WorkerStatusService)
			.map(({ eventName, methodName, filter }) => ({ eventName, methodName, filter }));

		{
			const { service, steps, step } = setupScenario({ hostId: 'main-a', instanceType: 'main' });
			await step(
				'a main instance asks the workers',
				async () => await service.requestWorkerStatus('user-1'),
			);
			await step('a second request', async () => await service.requestWorkerStatus('user-2'));
			transcript['the request of the status'] = steps;
		}

		{
			const { service, steps, step } = setupScenario();
			await step(
				'a worker answers',
				async () => await service.publishWorkerResponse({ requestingUserId: 'user-1' }),
			);
			transcript['the answer of a worker'] = steps;
		}

		{
			const { service, steps, step } = setupScenario({
				hostId: 'worker-gpu',
				jobs: [],
				pool: { enabled: true, name: 'gpu' },
			});
			await step(
				'a worker of a pool without jobs answers',
				async () => await service.publishWorkerResponse({ requestingUserId: 'user-2' }),
			);
			transcript['the answer of a worker in a pool'] = steps;
		}

		{
			const { service, steps, step } = setupScenario({
				hostId: 'worker-b',
				jobs: [],
				pool: { enabled: false, name: 'gpu' },
			});
			await step(
				'a worker with a pool name while pools are off',
				async () => await service.publishWorkerResponse({ requestingUserId: 'user-3' }),
			);
			transcript['a pool name while pools are off'] = steps;
		}

		{
			const { service, steps, step } = setupScenario({ hostId: 'main-a', instanceType: 'main' });
			const status: WorkerStatus = {
				senderId: 'worker-a',
				runningJobsSummary: [],
				isInContainer: false,
				process: {
					memory: { available: 1, constraint: 2, rss: 3, heapTotal: 4, heapUsed: 5 },
					uptime: 6,
				},
				host: { memory: { total: 7, free: 8 } },
				freeMem: 8,
				totalMem: 7,
				uptime: 9,
				loadAvg: [1, 2, 3],
				cpus: 'Fake CPU',
				arch: 'arm64',
				platform: 'darwin',
				hostname: 'worker-host',
				interfaces: [],
				version: '1.2.3',
				poolName: '',
				queueName: 'jobs',
			};
			await step('the main instance gets an answer', () =>
				service.handleWorkerStatusResponse({ ...status, requestingUserId: 'user-1' }),
			);
			await step('an answer for another user', () =>
				service.handleWorkerStatusResponse({
					...status,
					senderId: 'worker-b',
					requestingUserId: 'user-2',
				}),
			);
			transcript['the answer on the main instance'] = steps;
		}

		{
			const { service, steps, step } = setupScenario({ hostId: 'worker-c', jobs: [] });
			const cpusOf = async (cpus: typeof machine.cpus) => {
				machine.cpus = cpus;
				await service.publishWorkerResponse({ requestingUserId: 'user-1' });
			};
			await step(
				'one CPU',
				async () => await cpusOf([{ model: 'Solo', speed: 1000, times: cpuTimes }]),
			);
			await step(
				'mixed CPUs',
				async () =>
					await cpusOf([
						{ model: 'Big core', speed: 3000, times: cpuTimes },
						{ model: 'Little core', speed: 1000, times: cpuTimes },
						{ model: 'Little core', speed: 1000, times: cpuTimes },
					]),
			);
			await step('no CPU information', async () => await cpusOf([]));
			transcript['the CPUs of a worker'] = steps;
		}

		{
			const { service, steps, step } = setupScenario({ hostId: 'worker-d', jobs: [] });
			const constraintOf = async (constraint: number) => {
				vi.spyOn(process, 'constrainedMemory').mockReturnValue(constraint);
				await service.publishWorkerResponse({ requestingUserId: 'user-1' });
			};
			await step('no memory constraint', async () => await constraintOf(0));
			await step(
				'a constraint as large as the host memory',
				async () => await constraintOf(8_000_000),
			);
			await step('a constraint above the host memory', async () => await constraintOf(2 ** 53));
			await step('a small constraint', async () => await constraintOf(1_000));
			await step(
				'a constraint a little above the host memory',
				async () => await constraintOf(9_000_000),
			);
			await step('a large constraint', async () => await constraintOf(2 ** 52));
			await step(
				'the largest safe integer',
				async () => await constraintOf(Number.MAX_SAFE_INTEGER),
			);
			transcript['the memory constraint of a worker'] = steps;
		}

		expect(transcript).toMatchSnapshot();
	}, 60_000);
});
