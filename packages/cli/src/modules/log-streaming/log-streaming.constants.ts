import {
	LOGSTREAMING_CB_DEFAULT_CONCURRENT_HALF_OPEN_REQUESTS,
	LOGSTREAMING_CB_DEFAULT_FAILURE_WINDOW_MS,
	LOGSTREAMING_CB_DEFAULT_HALF_OPEN_REQUESTS,
	LOGSTREAMING_CB_DEFAULT_MAX_DURATION_MS,
	LOGSTREAMING_CB_DEFAULT_MAX_FAILURES,
	LOGSTREAMING_DEFAULT_SOCKET_TIMEOUT_MS,
} from '@n8n/constants';

import type { EventMessageConfirmSource } from '@/eventbus/event-message-classes/event-message-confirm';

/** The source that the module gives when it confirms the delivery of a message. */
export const CONFIRM_SOURCE: EventMessageConfirmSource = { id: '0', name: 'log-streaming' };

/** An entry of `subscribedEvents` that subscribes to all events. */
export const ALL_EVENTS = '*';

/** The prefix of the audit events, whose payloads anonymization changes. */
export const AUDIT_EVENT_PREFIX = 'n8n.audit.';

/** The defaults of the circuit breaker of a destination, from `@n8n/constants`. */
export const CIRCUIT_BREAKER_DEFAULTS = {
	maxFailures: LOGSTREAMING_CB_DEFAULT_MAX_FAILURES,
	failureWindow: LOGSTREAMING_CB_DEFAULT_FAILURE_WINDOW_MS,
	maxDuration: LOGSTREAMING_CB_DEFAULT_MAX_DURATION_MS,
	halfOpenRequests: LOGSTREAMING_CB_DEFAULT_HALF_OPEN_REQUESTS,
	maxConcurrentHalfOpenRequests: LOGSTREAMING_CB_DEFAULT_CONCURRENT_HALF_OPEN_REQUESTS,
};

/** The deliveries that a destination runs at the same time. Syslog keeps the order of messages. */
export const DELIVERY_CONCURRENCY = {
	webhook: 5,
	syslog: 1,
	sentry: 5,
} as const;

/** The deliveries that can wait for a destination. More fail at once, and stay unconfirmed. */
export const MAX_WAITING_DELIVERIES = 1_000;

/** The timeout of a webhook or Sentry request, when the destination sets none. */
export const DEFAULT_REQUEST_TIMEOUT_MS = LOGSTREAMING_DEFAULT_SOCKET_TIMEOUT_MS;

/** The timeout to open a TCP or TLS connection to a syslog server, and to write to it. */
export const SYSLOG_SOCKET_TIMEOUT_MS = LOGSTREAMING_DEFAULT_SOCKET_TIMEOUT_MS;

/** How long the module keeps the decrypted data of a credential of a webhook destination. */
export const CREDENTIAL_CACHE_TTL_MS = 60_000;

/** The time that the module waits for open deliveries on shutdown. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/** A destination logs a failed delivery at most this often. */
export const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * The namespace of the ids of the destinations from `N8N_LOG_STREAMING_DESTINATIONS`. The id of a
 * destination comes from its position in the list, so each main instance gives the same ids.
 */
export const ENV_DESTINATION_ID_NAMESPACE = '4b0d4bba-3c0c-4f63-9a52-5d2f6e1c7a90';

/** The text of the test message. */
export const TEST_MESSAGE_TEXT = 'Test message from n8n log streaming';
