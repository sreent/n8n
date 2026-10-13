import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { jsonParse, type JsonObject } from 'n8n-workflow';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { AuditLogProjectsService } from './audit-log-projects.service';
import { AuditLogConfig } from './audit-log.config';
import {
	AUDIT_EVENT_PREFIX,
	FLUSH_BATCH_SIZE,
	FLUSH_INTERVAL_MS,
	MAX_BUFFERED_EVENTS,
} from './audit-log.constants';
import {
	AuditLogEventRepository,
	type AuditLogEventRow,
} from './database/audit-log-event.repository';

/** The event bus emits this event for each message that it sends, after it logs the message. */
const SENT_MESSAGE_EVENT = 'metrics.eventBus.event';

/** The lengths of the id and e-mail columns of the table. */
const MAX_ID_LENGTH = 36;
const MAX_EMAIL_LENGTH = 254;

/**
 * A text that fits its column, else null. A value that is too long must not stop the writes of
 * the batch. The payload keeps the full value.
 */
const fittingText = (value: unknown, maxLength: number) =>
	typeof value === 'string' && value && value.length <= maxLength ? value : null;

/**
 * The row of an audit event message. The payload goes through JSON, as on the event log. The
 * project is the one that the payload names, if any. `AuditLogProjectsService` finds the others.
 */
export function toAuditLogEventRow(message: EventMessageTypes): AuditLogEventRow {
	const payload = jsonParse<JsonObject>(JSON.stringify(message.payload ?? {}));
	const projectId = fittingText(payload.projectId, MAX_ID_LENGTH);
	return {
		id: message.id,
		eventName: message.eventName,
		timestamp: message.ts.toJSDate(),
		userId: fittingText(payload.userId, MAX_ID_LENGTH),
		userEmail:
			fittingText(payload._email, MAX_EMAIL_LENGTH) ??
			fittingText(payload.userEmail, MAX_EMAIL_LENGTH),
		projectId,
		projectType: projectId ? fittingText(payload.projectType, MAX_ID_LENGTH) : null,
		payload,
	};
}

/**
 * Stores the audit events that the event bus of this process sends. It writes them in batches, at
 * least once a second.
 */
@Service()
export class AuditLogCollectionService {
	private buffer: AuditLogEventRow[] = [];

	private flushTimer: NodeJS.Timeout | undefined;

	private flushing: Promise<void> = Promise.resolve();

	private droppedEvents = 0;

	private writeFailing = false;

	private projectLookupFailing = false;

	private readonly onMessage = (message: EventMessageTypes) => this.collect(message);

	constructor(
		private readonly logger: Logger,
		private readonly eventBus: MessageEventBus,
		private readonly repository: AuditLogEventRepository,
		private readonly config: AuditLogConfig,
		private readonly projects: AuditLogProjectsService,
	) {
		this.logger = this.logger.scoped('audit-log');
	}

	/**
	 * Listens to the messages that the event bus sends. The module does not listen to the event
	 * `message` of the bus: a listener of that event confirms the delivery of each message, and
	 * that belongs to the destinations of log streaming.
	 */
	init() {
		this.projects.init();
		this.eventBus.on(SENT_MESSAGE_EVENT, this.onMessage);
		this.flushTimer = setInterval(() => {
			void this.flush();
		}, FLUSH_INTERVAL_MS);
	}

	collect(message: EventMessageTypes) {
		const { eventName } = message;
		if (!eventName.startsWith(AUDIT_EVENT_PREFIX) || this.isExcluded(eventName)) return;

		if (this.buffer.length >= MAX_BUFFERED_EVENTS) {
			this.droppedEvents++;
			return;
		}

		this.buffer.push(toAuditLogEventRow(message));
		if (this.buffer.length >= FLUSH_BATCH_SIZE) void this.flush();
	}

	/** Writes the buffered events. After a failed write, the events wait for the next flush. */
	async flush() {
		this.flushing = this.flushing.then(async () => await this.writeBuffer());
		await this.flushing;
	}

	async shutdown() {
		clearInterval(this.flushTimer);
		this.flushTimer = undefined;
		this.eventBus.off(SENT_MESSAGE_EVENT, this.onMessage);
		await this.flush();
		this.projects.shutdown();
	}

	private async writeBuffer() {
		while (this.buffer.length > 0) {
			const batch = this.buffer.slice(0, FLUSH_BATCH_SIZE);
			await this.addProjects(batch);
			try {
				await this.repository.insertIgnoringDuplicates(batch);
			} catch (error) {
				if (!this.writeFailing) {
					this.logger.error('Failed to store audit events. Trying again in the next flush.', {
						error,
					});
				}
				this.writeFailing = true;
				return;
			}
			this.writeFailing = false;
			this.buffer.splice(0, batch.length);
		}

		if (this.droppedEvents > 0) {
			this.logger.warn(
				`Dropped ${this.droppedEvents} audit events, because the buffer was full while the database did not accept writes`,
			);
			this.droppedEvents = 0;
		}
	}

	/** A failed search for the projects must not stop the writes: the rows then keep no project. */
	private async addProjects(batch: AuditLogEventRow[]) {
		try {
			await this.projects.addProjects(batch);
			this.projectLookupFailing = false;
		} catch (error) {
			if (!this.projectLookupFailing) {
				this.logger.warn('Failed to find the projects of audit events. Storing them without.', {
					error,
				});
			}
			this.projectLookupFailing = true;
		}
	}

	private isExcluded(eventName: string) {
		return this.config.excludedEvents.some((excluded) =>
			excluded.endsWith('.') ? eventName.startsWith(excluded) : eventName === excluded,
		);
	}
}
