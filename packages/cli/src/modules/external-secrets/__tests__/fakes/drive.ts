// Drives a secrets provider through its steps for the golden tests, and records the outcome of
// each step: the result or the error, and the state of the provider after it.
import type { IDataObject } from 'n8n-workflow';

export interface DrivenProvider {
	readonly state: string;
	init(settings: {
		connected: boolean;
		connectedAt: Date | null;
		settings: IDataObject;
	}): Promise<void>;
	connect(): Promise<void>;
	update(): Promise<void>;
	test(): Promise<[boolean] | [boolean, string]>;
	disconnect(): Promise<void>;
	getSecret(name: string): unknown;
	hasSecret(name: string): boolean;
	getSecretNames(): string[];
}

/** Ports of the local fake servers change on each run. */
const normalize = (text: string) => text.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');

/** The error class chain and the message of an error, or the value of a thrown non-error. */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) {
		return `non-error ${normalize(JSON.stringify(error) ?? String(error))}`;
	}
	const chain: string[] = [];
	let prototype: unknown = Object.getPrototypeOf(error);
	while (prototype && prototype !== Object.prototype) {
		chain.push((prototype as { constructor: { name: string } }).constructor.name);
		prototype = Object.getPrototypeOf(prototype);
	}
	return `${chain.join(' < ')}: ${normalize(error.message)}`;
}

export async function outcome(fn: () => Promise<unknown> | unknown): Promise<unknown> {
	try {
		const value = await fn();
		if (value === undefined) return 'ok';
		return typeof value === 'string' ? { ok: normalize(value) } : { ok: normalizeValue(value) };
	} catch (error) {
		return { error: describeError(error) };
	}
}

function normalizeValue(value: unknown): unknown {
	return JSON.parse(normalize(JSON.stringify(value) ?? 'null')) as unknown;
}

export interface DriveOptions {
	settings: IDataObject;
	/** Called before each step with its label. */
	step?: (label: string) => void;
	/** Names to read with getSecret and hasSecret after the update. */
	read?: string[];
	skipUpdate?: boolean;
}

/** init, connect, update, getSecretNames, getSecret and hasSecret, test, disconnect. */
export async function drive(provider: DrivenProvider, options: DriveOptions) {
	const step = options.step ?? (() => {});
	const result: Record<string, unknown> = { 'state at start': provider.state };
	step('init');
	result.init = await outcome(
		async () =>
			await provider.init({
				connected: true,
				connectedAt: new Date(0),
				settings: options.settings,
			}),
	);
	result['state after init'] = provider.state;
	step('connect');
	result.connect = await outcome(async () => await provider.connect());
	result['state after connect'] = provider.state;
	if (!options.skipUpdate) {
		step('update');
		result.update = await outcome(async () => await provider.update());
		result['state after update'] = provider.state;
		result.names = await outcome(() => provider.getSecretNames());
		for (const name of options.read ?? []) {
			result[`getSecret ${name}`] = await outcome(() => provider.getSecret(name));
			result[`hasSecret ${name}`] = await outcome(() => provider.hasSecret(name));
		}
	}
	step('test');
	result.test = await outcome(async () => await provider.test());
	result['state after test'] = provider.state;
	step('disconnect');
	result.disconnect = await outcome(async () => await provider.disconnect());
	result['state after disconnect'] = provider.state;
	step('end');
	return result;
}

/**
 * Requests grouped by step, in the order of the steps. Inside a step the lines are sorted,
 * because some providers send requests in parallel.
 */
export function sortedByStep(requests: string[]): string[] {
	const steps: string[] = [];
	const lines = new Map<string, string[]>();
	for (const line of requests) {
		const label = line.slice(0, line.indexOf(':'));
		if (!lines.has(label)) {
			steps.push(label);
			lines.set(label, []);
		}
		lines.get(label)!.push(line);
	}
	return steps.flatMap((label) => [...lines.get(label)!].sort());
}
