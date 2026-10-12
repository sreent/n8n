import { DeliveryQueue, DeliveryQueueFullError } from '../destinations/delivery-queue';

/** A task that ends when the test calls `finish`. */
function controlledTask() {
	let finish = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const task = vi.fn(async () => await done);
	return { task, finish };
}

const flushPromises = async () => await new Promise((resolve) => setImmediate(resolve));

describe('DeliveryQueue', () => {
	it('runs at most the given tasks at the same time, and the next when one ends', async () => {
		const queue = new DeliveryQueue(2, 10);
		const tasks = [controlledTask(), controlledTask(), controlledTask()];

		const runs = tasks.map(async ({ task }) => await queue.run(task));
		await flushPromises();
		expect(tasks.map(({ task }) => task.mock.calls.length)).toEqual([1, 1, 0]);
		expect(queue.size).toBe(3);

		tasks[0].finish();
		await flushPromises();
		expect(tasks[2].task).toHaveBeenCalledTimes(1);

		tasks[1].finish();
		tasks[2].finish();
		await Promise.all(runs);
		expect(queue.size).toBe(0);
	});

	it('rejects a task at once when too many tasks wait', async () => {
		const queue = new DeliveryQueue(1, 1);
		const running = controlledTask();
		const waiting = controlledTask();
		const runs = [queue.run(running.task), queue.run(waiting.task)];

		await expect(queue.run(vi.fn())).rejects.toThrow(DeliveryQueueFullError);

		running.finish();
		waiting.finish();
		await Promise.all(runs);
	});

	it('frees the slot of a task that fails', async () => {
		const queue = new DeliveryQueue(1, 1);

		await expect(queue.run(async () => await Promise.reject(new Error('failed')))).rejects.toThrow(
			'failed',
		);

		await expect(queue.run(async () => await Promise.resolve('next'))).resolves.toBe('next');
		expect(queue.size).toBe(0);
	});

	it('resolves idle when all tasks end, or at the timeout', async () => {
		vi.useFakeTimers();
		try {
			const queue = new DeliveryQueue(1, 1);
			await queue.idle(1_000);

			const { task, finish } = controlledTask();
			const run = queue.run(task);
			const idle = vi.fn();
			void queue.idle(1_000).then(idle);
			await vi.advanceTimersByTimeAsync(999);
			expect(idle).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(idle).toHaveBeenCalled();

			const idleAgain = vi.fn();
			void queue.idle(1_000).then(idleAgain);
			finish();
			await run;
			await vi.advanceTimersByTimeAsync(0);
			expect(idleAgain).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
