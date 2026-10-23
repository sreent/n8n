/** The names of the audit events of the event bus start with this prefix. */
export const AUDIT_EVENT_PREFIX = 'n8n.audit.';

/** The collection writes the buffered events at least this often. */
export const FLUSH_INTERVAL_MS = 1_000;

/** The collection writes the buffer at once when it holds this many events. */
export const FLUSH_BATCH_SIZE = 100;

/** While the database does not accept writes, the buffer keeps at most this many events. */
export const MAX_BUFFERED_EVENTS = 10_000;

/** The export reads the events from the database in batches of this size. */
export const EXPORT_BATCH_SIZE = 1_000;
