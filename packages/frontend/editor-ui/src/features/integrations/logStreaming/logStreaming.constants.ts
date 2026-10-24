// Fork code (not in upstream n8n): the constants of the log streaming page. See `FORK.md`.
import type { EventBus } from '@n8n/utils/event-bus';

/** Must match the name of the backend module: the page works only while that module runs. */
export const LOG_STREAMING_MODULE_ID = 'log-streaming';

export const LOG_STREAMING_SCOPE = 'logStreaming:manage';

export const LOG_STREAM_MODAL_KEY = 'settingsLogStream';

/** The data of the modal of one destination. A new destination has none. */
export type LogStreamModalData = {
	destination?: object;
	isNew?: boolean;
	eventBus?: EventBus;
};
