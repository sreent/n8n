import { OperationalError } from 'n8n-workflow';

export class DeliveryQueueFullError extends OperationalError {
	constructor() {
		super('Too many deliveries wait for this destination');
	}
}

/** Runs deliveries with a limit on the deliveries that run, and on the deliveries that wait. */
export class DeliveryQueue {
	private running = 0;

	private readonly waiting: Array<() => void> = [];

	private idleWaiters: Array<() => void> = [];

	constructor(
		private readonly concurrency: number,
		private readonly maxWaiting: number,
	) {}

	get size() {
		return this.running + this.waiting.length;
	}

	/** Runs the task when a slot is free. Rejects at once when too many tasks wait. */
	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.running >= this.concurrency) {
			if (this.waiting.length >= this.maxWaiting) throw new DeliveryQueueFullError();
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		} else {
			this.running++;
		}
		try {
			return await task();
		} finally {
			this.next();
		}
	}

	/** Resolves when no task runs or waits, or after the timeout. */
	async idle(timeoutMs: number): Promise<void> {
		if (this.size === 0) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			this.idleWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** Gives the slot of a finished task to the next waiting task, else frees it. */
	private next() {
		const resume = this.waiting.shift();
		if (resume) {
			resume();
			return;
		}
		this.running--;
		if (this.running === 0) {
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const notify of waiters) notify();
		}
	}
}
