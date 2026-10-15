// Fork code (not in upstream n8n): the formats of the worker view. See `./FORK.md`.
import type { WorkerStatus } from '@n8n/api-types';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The mean of the load averages of the operating system. */
export function averageWorkerLoadFromLoads(loads: number[]): number {
	return loads.reduce((sum, load) => sum + load, 0) / loads.length;
}

export function averageWorkerLoadFromLoadsAsString(loads: number[]): string {
	return averageWorkerLoadFromLoads(loads).toFixed(2);
}

/** Bytes as gigabytes with at most two decimals. */
export function memAsGb(bytes: number): number {
	return parseFloat((bytes / GB).toFixed(2));
}

/** Bytes as megabytes with at most two decimals. */
export function memAsMb(bytes: number): number {
	return parseFloat((bytes / MB).toFixed(2));
}

/** The memory that the worker can use: the limit of its container, or the memory of the host. */
export function workerMemoryTotal(worker: WorkerStatus): number {
	return worker.isInContainer ? worker.process.memory.constraint : worker.host.memory.total;
}

/** The used part of the memory that the worker can use, in percent. */
export function workerMemoryUsage(worker: WorkerStatus): number {
	const total = workerMemoryTotal(worker);
	return ((total - worker.process.memory.available) / total) * 100;
}

/** A time in seconds as days, hours, minutes and seconds. */
export function upTime(seconds: number): string {
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const rest = Math.floor(seconds % 60);
	return `${days}d ${hours}h ${minutes}m ${rest}s`;
}

/**
 * The time since a start as hours, minutes and seconds. A start in the future gives negative hours
 * and positive minutes and seconds.
 */
export function runningSince(startedAt: Date, now = Date.now()): string {
	const seconds = Math.floor((now - startedAt.getTime()) / 1_000);
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds - hours * 3_600) / 60);
	const rest = seconds - hours * 3_600 - minutes * 60;
	return `${hours}h ${minutes}m ${rest}s`;
}
