// Fork test (not in upstream n8n): the data of the golden tests of the worker view. See
// `../../FORK.md`.
import type { RunningJobSummary, WorkerStatus } from '@n8n/api-types';
// #region Fixtures

/** Queue mode with the worker view. */
export const SETTINGS = {
	executionMode: 'queue',
	enterprise: { workerView: true },
};

export const GB = 1024 * 1024 * 1024;

/** A running job as the push message gives it: the dates are strings after JSON. */
export const job = (
	executionId: string,
	extra: Partial<Record<keyof RunningJobSummary, unknown>> = {},
): RunningJobSummary =>
	({
		executionId,
		workflowId: `wf-${executionId}`,
		workflowName: `Workflow ${executionId}`,
		mode: 'trigger',
		startedAt: '2026-03-01T11:59:00.000Z',
		status: 'running',
		...extra,
	}) as unknown as RunningJobSummary;

export const status = (senderId: string, extra: Partial<WorkerStatus> = {}): WorkerStatus => ({
	senderId,
	runningJobsSummary: [],
	isInContainer: false,
	process: {
		memory: {
			available: 2 * GB,
			constraint: 4 * GB,
			rss: 0.5 * GB,
			heapTotal: 0.25 * GB,
			heapUsed: 0.125 * GB,
		},
		uptime: 4_321,
	},
	host: { memory: { total: 8 * GB, free: 1 * GB } },
	freeMem: 1 * GB,
	totalMem: 8 * GB,
	uptime: 12_345,
	loadAvg: [0.5, 0.25, 0.125],
	cpus: '2x Fake CPU 3000',
	arch: 'x64',
	platform: 'linux',
	hostname: `${senderId}-host`,
	interfaces: [
		{ family: 'IPv4', address: '10.0.0.2', internal: false },
		{ family: 'IPv6', address: 'fe80::42:acff:fe11:2', internal: false },
		{ family: 'IPv4', address: '127.0.0.1', internal: true },
	],
	version: '1.2.3',
	poolName: '',
	queueName: 'jobs',
	...extra,
});

// #endregion
