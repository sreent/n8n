import { CIRCUIT_BREAKER_DEFAULTS } from '../log-streaming.constants';

export interface CircuitBreakerOptions {
	/** Failures in the window that open the circuit. */
	maxFailures?: number;
	/** The window in milliseconds that counts failures. */
	failureWindow?: number;
	/** How long in milliseconds the circuit stays open before it tries again. */
	maxDuration?: number;
	/** Successful trial deliveries that close the circuit again. */
	halfOpenRequests?: number;
	/** Trial deliveries at the same time while the circuit is half open. */
	maxConcurrentHalfOpenRequests?: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Stops the deliveries to a destination after repeated failures. While the circuit is open, a
 * delivery fails at once. After `maxDuration`, trial deliveries run: successes close the circuit,
 * and a failure opens it again.
 */
export class CircuitBreaker {
	private state: CircuitState = 'closed';

	private failures: number[] = [];

	private openedAt = 0;

	private trialsInFlight = 0;

	private trialSuccesses = 0;

	private readonly settings: Required<CircuitBreakerOptions>;

	constructor(
		options: CircuitBreakerOptions = {},
		private readonly now: () => number = Date.now,
	) {
		this.settings = { ...CIRCUIT_BREAKER_DEFAULTS, ...definedOptions(options) };
	}

	get currentState(): CircuitState {
		this.leaveOpenStateWhenDue();
		return this.state;
	}

	/** Whether a delivery may start. A `true` answer must be followed by a success or a failure. */
	tryStart(): boolean {
		this.leaveOpenStateWhenDue();
		if (this.state === 'open') return false;
		if (this.state === 'half-open') {
			if (this.trialsInFlight >= this.settings.maxConcurrentHalfOpenRequests) return false;
			this.trialsInFlight++;
		}
		return true;
	}

	recordSuccess() {
		if (this.state !== 'half-open') return;
		this.trialsInFlight = Math.max(0, this.trialsInFlight - 1);
		this.trialSuccesses++;
		if (this.trialSuccesses >= this.settings.halfOpenRequests) this.close();
	}

	recordFailure() {
		const now = this.now();
		if (this.state === 'half-open') {
			this.open(now);
			return;
		}
		this.failures = this.failures.filter((at) => now - at < this.settings.failureWindow);
		this.failures.push(now);
		if (this.failures.length >= this.settings.maxFailures) this.open(now);
	}

	private leaveOpenStateWhenDue() {
		if (this.state === 'open' && this.now() - this.openedAt >= this.settings.maxDuration) {
			this.state = 'half-open';
			this.trialsInFlight = 0;
			this.trialSuccesses = 0;
		}
	}

	private open(now: number) {
		this.state = 'open';
		this.openedAt = now;
		this.failures = [];
	}

	private close() {
		this.state = 'closed';
		this.failures = [];
		this.trialsInFlight = 0;
		this.trialSuccesses = 0;
	}
}

/** The options that are set, so that an `undefined` value does not hide a default. */
function definedOptions(options: CircuitBreakerOptions): CircuitBreakerOptions {
	return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}
