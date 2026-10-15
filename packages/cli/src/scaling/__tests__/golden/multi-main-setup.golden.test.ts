// Fork test (not in upstream n8n): the multi-main setup as a black box. The test drives the class
// with a scripted leader election client and fake timers, and records the calls to the client,
// the logs, the reports of errors, the changes of the instance role, the events and the calls of
// the handlers of `@OnLeaderTakeover` and `@OnLeaderStepdown`. The snapshot was recorded against
// the enterprise class, and the fork class gives the same snapshot. See `../../FORK.md`.
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { MultiMainMetadata, OnLeaderStepdown, OnLeaderTakeover } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { createResultError, createResultOk, type Result } from '@n8n/utils/result';
import { ErrorReporter, InstanceSettings } from 'n8n-core';

import { LeaderElectionClient } from '@/scaling/leader-election-client';

import { MultiMainSetup } from './subject';

// #region Recorder

type Entry = unknown[];

let entries: Entry[] = [];

const record = (...entry: unknown[]) => entries.push(entry);

function normalize(value: unknown): unknown {
	if (value instanceof Error) return { error: value.constructor.name, message: value.message };
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === 'function') return '<function>';
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
	}
	return value;
}

/** A logger or an error reporter that records each call. */
function recorder(name: string): unknown {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (typeof property === 'symbol' || property === 'then') return undefined;
				if (property === 'scoped') {
					return (scopes: unknown) => {
						record(name, 'scoped', normalize(scopes));
						return recorder(`${name}(${String(scopes)})`);
					};
				}
				return (...args: unknown[]) => record(name, property, ...args.map(normalize));
			},
		},
	);
}

/** The instance settings of a main instance. Records the changes of the role. */
class FakeInstanceSettings {
	instanceRole: 'unset' | 'leader' | 'follower' = 'unset';

	readonly instanceType = 'main';

	readonly isMultiMain = true;

	readonly isSingleMain = false;

	constructor(readonly hostId: string) {}

	get isLeader() {
		return this.instanceRole === 'leader';
	}

	get isFollower() {
		return this.instanceRole === 'follower';
	}

	markAsLeader() {
		record('instanceSettings', 'markAsLeader');
		this.instanceRole = 'leader';
	}

	markAsFollower() {
		record('instanceSettings', 'markAsFollower');
		this.instanceRole = 'follower';
	}
}

/** Records the reads of other members of the instance settings. */
function watched(settings: FakeInstanceSettings): FakeInstanceSettings {
	return new Proxy(settings, {
		get(target, property, receiver) {
			if (typeof property === 'string' && !(property in target)) {
				record('instanceSettings', 'read', property);
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

type ClientMethod = 'getLeader' | 'setLeaderIfNotExists' | 'tryRenewLeaderTtl' | 'clearLeader';

const ok = <T>(value: T) => createResultOk(value);
const failed = (message: string) => createResultError(new Error(message));

/** A leader election client that answers from a script. */
class ScriptedClient {
	private readonly queues: Partial<Record<ClientMethod, Array<Result<unknown, Error>>>> = {};

	private readonly defaults: Record<ClientMethod, Result<unknown, Error>> = {
		getLeader: ok(null),
		setLeaderIfNotExists: ok(true),
		tryRenewLeaderTtl: ok({ id: 'success' }),
		clearLeader: ok(undefined),
	};

	script(method: ClientMethod, ...results: Array<Result<unknown, Error>>) {
		(this.queues[method] ??= []).push(...results);
	}

	private next(method: ClientMethod) {
		const result = this.queues[method]?.shift() ?? this.defaults[method];
		record('client', method, normalize(result));
		return result;
	}

	async getLeader() {
		return this.next('getLeader');
	}

	async setLeaderIfNotExists() {
		return this.next('setLeaderIfNotExists');
	}

	async tryRenewLeaderTtl() {
		return this.next('tryRenewLeaderTtl');
	}

	async clearLeader() {
		return this.next('clearLeader');
	}

	destroy() {
		record('client', 'destroy');
	}
}

// #endregion

// #region Scenario

let intervalDelay: number | undefined;

function setupScenario(options: { hostId?: string; ttl?: number; interval?: number } = {}) {
	Container.reset();
	entries = [];
	intervalDelay = undefined;
	Container.set(MultiMainMetadata, new MultiMainMetadata());
	Container.set(Logger, recorder('logger') as Logger);
	Container.set(ErrorReporter, recorder('errorReporter') as ErrorReporter);
	const settings = new FakeInstanceSettings(options.hostId ?? 'main-a');
	Container.set(InstanceSettings, watched(settings) as unknown as InstanceSettings);
	const config = Container.get(GlobalConfig);
	config.multiMainSetup.enabled = true;
	config.multiMainSetup.ttl = options.ttl ?? 10;
	config.multiMainSetup.interval = options.interval ?? 3;
	config.redis.prefix = 'n8n';
	const client = new ScriptedClient();
	Container.set(LeaderElectionClient, client as unknown as LeaderElectionClient);
	const setup = Container.get(MultiMainSetup);
	const emit = setup.emit.bind(setup);
	setup.emit = ((...args: unknown[]) => {
		record('emit', ...args.map(normalize));
		return Reflect.apply(emit, undefined, args) as boolean;
	}) as typeof setup.emit;
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
		// Let the handlers of the events finish.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		steps.push({ step: name, outcome, role: settings.instanceRole, calls: entries });
	};
	const tick = async () => {
		await vi.advanceTimersByTimeAsync(intervalDelay ?? 3_000);
	};
	return { setup, client, settings, steps, step, tick };
}

/** Handlers of the two events, as other services of n8n declare them. */
function defineHandlers() {
	@Service()
	class LeaderTasks {
		@OnLeaderTakeover()
		async start() {
			record('handler', 'LeaderTasks.start');
		}

		@OnLeaderStepdown()
		async stop() {
			record('handler', 'LeaderTasks.stop');
		}
	}

	@Service()
	class Metrics {
		@OnLeaderTakeover()
		markLeader() {
			record('handler', 'Metrics.markLeader');
		}

		@OnLeaderStepdown()
		markFollower() {
			record('handler', 'Metrics.markFollower');
		}
	}

	return [LeaderTasks, Metrics];
}

function defineFailingHandlers() {
	@Service()
	class Failing {
		@OnLeaderTakeover()
		async rejectOnTakeover() {
			record('handler', 'Failing.rejectOnTakeover');
			throw new Error('takeover handler failed');
		}

		@OnLeaderStepdown()
		async rejectOnStepdown() {
			record('handler', 'Failing.rejectOnStepdown');
			throw new Error('stepdown handler failed');
		}
	}

	@Service()
	class AfterFailing {
		@OnLeaderTakeover()
		async onTakeover() {
			record('handler', 'AfterFailing.onTakeover');
		}
	}

	return [Failing, AfterFailing];
}

// #endregion

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
	});
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	vi.spyOn(globalThis, 'setInterval').mockImplementation(((
		handler: () => void,
		delay?: number,
		...args: unknown[]
	) => {
		record('timer', 'setInterval', delay);
		intervalDelay = delay;
		return realSetInterval(handler, delay, ...args);
	}) as typeof setInterval);
	vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
		id?: Parameters<typeof clearInterval>[0],
	) => {
		record('timer', 'clearInterval');
		realClearInterval(id);
	}) as typeof clearInterval);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	Container.reset();
});

/**
 * Runs an action and records the rejections that no code handles. A handler of an event that
 * rejects gives such a rejection.
 */
async function withUnhandledRejections(action: () => Promise<void>) {
	const listeners = process.listeners('unhandledRejection');
	process.removeAllListeners('unhandledRejection');
	const onRejection = (reason: unknown) => record('unhandledRejection', normalize(reason));
	process.on('unhandledRejection', onRejection);
	try {
		await action();
	} finally {
		process.off('unhandledRejection', onRejection);
		for (const listener of listeners) process.on('unhandledRejection', listener);
	}
}

/** Lets Node report the rejections that no code handles. */
const settleRejections = async () => {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('the multi-main setup', () => {
	test('the leader election', async () => {
		const transcript: Record<string, unknown> = {};

		{
			const { setup, client, steps, step, tick } = setupScenario();
			defineHandlers();
			await step('register the handlers', () => setup.registerEventHandlers());
			await step('init with a free key', async () => await setup.init());
			await step('a renewal', tick);
			client.script('tryRenewLeaderTtl', ok({ id: 'key-missing' }));
			await step('a missing key, claimed again', tick);
			client.script('tryRenewLeaderTtl', failed('Command timed out'));
			await step('a failed renewal', tick);
			client.script('tryRenewLeaderTtl', ok({ id: 'key-missing' }));
			client.script('setLeaderIfNotExists', failed('Command timed out'));
			await step('a missing key, and a failed claim', tick);
			client.script('getLeader', ok('main-b'));
			await step('a follower sees the leader', tick);
			client.script('getLeader', failed('Connection is closed.'));
			await step('a follower with a failed read', tick);
			client.script('getLeader', ok(null));
			client.script('setLeaderIfNotExists', ok(false));
			await step('a free key, claimed by another host', tick);
			client.script('getLeader', ok(null));
			client.script('setLeaderIfNotExists', failed('Command timed out'));
			await step('a free key, and a failed claim', tick);
			client.script('getLeader', ok('main-a'));
			await step('a follower sees its own host id', tick);
			client.script('tryRenewLeaderTtl', ok({ id: 'key-missing' }));
			client.script('setLeaderIfNotExists', ok(false));
			await step('a missing key, claimed by another host', tick);
			client.script('getLeader', ok(null));
			await step('a free key, claimed', tick);
			client.script(
				'tryRenewLeaderTtl',
				ok({ id: 'other-host-is-leader', currentLeaderId: 'main-b' }),
			);
			await step('another host holds the key', tick);
			client.script('getLeader', ok(null));
			await step('a free key, claimed again', tick);
			await step('shutdown as the leader', async () => await setup.shutdown());
			await step('a check after the shutdown', tick);
			await step('a second shutdown', async () => await setup.shutdown());
			transcript['a leader, then a follower, then the leader'] = steps;
		}

		{
			const { setup, client, steps, step, tick } = setupScenario();
			defineHandlers();
			await step('register the handlers', () => setup.registerEventHandlers());
			client.script('setLeaderIfNotExists', ok(false));
			await step('init with a taken key', async () => await setup.init());
			client.script('getLeader', ok('main-b'));
			await step('a check', tick);
			client.script('getLeader', ok('main-b'));
			await step('the leader key', async () => await setup.fetchLeaderKey());
			await step('shutdown as a follower', async () => await setup.shutdown());
			transcript['a follower from the start'] = steps;
		}

		{
			const { setup, client, steps, step, tick } = setupScenario();
			client.script('setLeaderIfNotExists', failed('Connection is closed.'));
			await step('init with a failed claim', async () => await setup.init());
			client.script('getLeader', ok(null));
			await step('a check', tick);
			client.script('clearLeader', failed('Connection is closed.'));
			await step('shutdown with a failed clear', async () => await setup.shutdown());
			transcript['a failed claim at init'] = steps;
		}

		{
			const { setup, steps, step, tick } = setupScenario();
			await step('init before the handlers', async () => await setup.init());
			defineHandlers();
			await step('register the handlers after init', () => setup.registerEventHandlers());
			await step('a renewal', tick);
			await step('shutdown', async () => await setup.shutdown());
			transcript['handlers that come after init'] = steps;
		}

		{
			const { setup, client, steps, step } = setupScenario();
			await step('shutdown before init', async () => await setup.shutdown());
			client.script('getLeader', ok('main-a'));
			await step('the leader key before init', async () => await setup.fetchLeaderKey());
			await step('the empty leader key', async () => await setup.fetchLeaderKey());
			client.script('getLeader', failed('Connection is closed.'));
			await step('a failed read of the leader key', async () => await setup.fetchLeaderKey());
			transcript['shutdown and the leader key without init'] = steps;
		}

		{
			const { setup, client, steps, step, tick } = setupScenario({ hostId: 'main-z' });
			await withUnhandledRejections(async () => {
				defineFailingHandlers();
				defineHandlers();
				await step('register the handlers', () => setup.registerEventHandlers());
				await step('init with failing handlers', async () => {
					await setup.init();
					await settleRejections();
				});
				client.script(
					'tryRenewLeaderTtl',
					ok({ id: 'other-host-is-leader', currentLeaderId: 'main-a' }),
				);
				await step('a step-down with failing handlers', async () => {
					await tick();
					await settleRejections();
				});
			});
			await step('shutdown', async () => await setup.shutdown());
			transcript['handlers that fail'] = steps;
		}

		{
			const { setup, steps, step, tick } = setupScenario({ ttl: 30, interval: 7 });
			await step('init with other timings', async () => await setup.init());
			await step('a check after the interval', tick);
			await step('shutdown', async () => await setup.shutdown());
			transcript['other timings'] = steps;
		}

		expect(transcript).toMatchSnapshot();
	});
});
