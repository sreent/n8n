import { CircuitBreaker } from '../destinations/circuit-breaker';
import { CIRCUIT_BREAKER_DEFAULTS } from '../log-streaming.constants';

describe('CircuitBreaker', () => {
	let now: number;
	const clock = () => now;

	beforeEach(() => {
		now = 1_000_000;
	});

	/** Runs a delivery that fails. */
	const fail = (breaker: CircuitBreaker) => {
		expect(breaker.tryStart()).toBe(true);
		breaker.recordFailure();
	};

	it('opens after the maximum failures in the window', () => {
		const breaker = new CircuitBreaker({ maxFailures: 3, failureWindow: 10_000 }, clock);

		fail(breaker);
		fail(breaker);
		expect(breaker.currentState).toBe('closed');
		fail(breaker);

		expect(breaker.currentState).toBe('open');
		expect(breaker.tryStart()).toBe(false);
	});

	it('does not count the failures before the window', () => {
		const breaker = new CircuitBreaker({ maxFailures: 3, failureWindow: 10_000 }, clock);

		fail(breaker);
		fail(breaker);
		now += 10_000;
		fail(breaker);

		expect(breaker.currentState).toBe('closed');
	});

	it('tries again after the open time, and closes after the successful trials', () => {
		const breaker = new CircuitBreaker(
			{ maxFailures: 1, maxDuration: 5_000, halfOpenRequests: 2 },
			clock,
		);
		fail(breaker);
		now += 4_999;
		expect(breaker.tryStart()).toBe(false);

		now += 1;
		expect(breaker.currentState).toBe('half-open');
		expect(breaker.tryStart()).toBe(true);
		breaker.recordSuccess();
		expect(breaker.currentState).toBe('half-open');
		expect(breaker.tryStart()).toBe(true);
		breaker.recordSuccess();

		expect(breaker.currentState).toBe('closed');
	});

	it('limits the trials at the same time while half open', () => {
		const breaker = new CircuitBreaker(
			{ maxFailures: 1, maxDuration: 5_000, maxConcurrentHalfOpenRequests: 1 },
			clock,
		);
		fail(breaker);
		now += 5_000;

		expect(breaker.tryStart()).toBe(true);
		expect(breaker.tryStart()).toBe(false);
	});

	it('opens again when a trial fails', () => {
		const breaker = new CircuitBreaker({ maxFailures: 1, maxDuration: 5_000 }, clock);
		fail(breaker);
		now += 5_000;

		fail(breaker);

		expect(breaker.currentState).toBe('open');
		now += 4_999;
		expect(breaker.tryStart()).toBe(false);
	});

	it('uses the defaults for the options that are not set', () => {
		const breaker = new CircuitBreaker({ maxFailures: undefined }, clock);

		for (let failure = 1; failure < CIRCUIT_BREAKER_DEFAULTS.maxFailures; failure++) fail(breaker);
		expect(breaker.currentState).toBe('closed');
		fail(breaker);
		expect(breaker.currentState).toBe('open');

		now += CIRCUIT_BREAKER_DEFAULTS.maxDuration;
		expect(breaker.currentState).toBe('half-open');
	});
});
