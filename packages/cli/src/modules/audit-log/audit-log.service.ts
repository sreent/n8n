import { Service } from '@n8n/di';
import { Readable } from 'node:stream';

import { eventNamesAll } from '@/eventbus/event-message-classes';

import { AUDIT_EVENT_PREFIX, EXPORT_BATCH_SIZE } from './audit-log.constants';
import type { AuditLogEvent } from './database/audit-log-event.entity';
import {
	AuditLogEventRepository,
	type AuditLogCursor,
	type AuditLogFilter,
} from './database/audit-log-event.repository';

export type AuditLogExportFormat = 'csv' | 'json';

/** An audit event as the REST API gives it. */
export type AuditLogEventResponse = Pick<
	AuditLogEvent,
	'id' | 'eventName' | 'userId' | 'userEmail' | 'projectId' | 'projectType' | 'payload'
> & { timestamp: string };

const toResponse = (event: AuditLogEvent): AuditLogEventResponse => ({
	id: event.id,
	eventName: event.eventName,
	timestamp: event.timestamp.toISOString(),
	userId: event.userId,
	userEmail: event.userEmail,
	projectId: event.projectId,
	projectType: event.projectType,
	payload: event.payload,
});

/** The project columns come last, so that a reader of the older files finds the same columns. */
const CSV_COLUMNS = [
	'timestamp',
	'eventName',
	'userId',
	'userEmail',
	'payload',
	'projectId',
	'projectType',
] as const;

/**
 * A CSV cell. A spreadsheet reads a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
 * return as a formula, so such a cell starts with a single quote.
 */
function toCsvCell(value: string | null) {
	if (value === null) return '';
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsvLine(event: AuditLogEventResponse) {
	const cells = [
		event.timestamp,
		event.eventName,
		event.userId,
		event.userEmail,
		JSON.stringify(event.payload),
		event.projectId,
		event.projectType,
	];
	return `${cells.map(toCsvCell).join(',')}\r\n`;
}

@Service()
export class AuditLogService {
	constructor(private readonly repository: AuditLogEventRepository) {}

	/** One page of the events that match the filter, newest first. */
	async listEvents(filter: AuditLogFilter, skip: number, take: number) {
		const { count, events } = await this.repository.findPage(filter, skip, take);
		return { count, events: events.map(toResponse) };
	}

	/**
	 * The names of the audit events of this n8n version, for the filter of the editor. Some groups
	 * of events, for example the events of the MCP server, have their own list but the audit prefix.
	 */
	eventNames(): string[] {
		return eventNamesAll.filter((name) => name.startsWith(AUDIT_EVENT_PREFIX));
	}

	/** All events that match the filter, newest first, as a file that the response streams. */
	exportEvents(filter: AuditLogFilter, format: AuditLogExportFormat, now = new Date()) {
		const date = now.toISOString().slice(0, 10);
		return {
			contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
			fileName: `audit-log-${date}.${format}`,
			stream: Readable.from(format === 'csv' ? this.csvChunks(filter) : this.jsonChunks(filter)),
		};
	}

	private async *batches(filter: AuditLogFilter) {
		let cursor: AuditLogCursor | undefined;
		while (true) {
			const batch = await this.repository.findBatch(filter, cursor, EXPORT_BATCH_SIZE);
			if (batch.length > 0) yield batch.map(toResponse);
			if (batch.length < EXPORT_BATCH_SIZE) return;
			const last = batch[batch.length - 1];
			cursor = { timestamp: last.timestamp, id: last.id };
		}
	}

	private async *csvChunks(filter: AuditLogFilter) {
		yield `${CSV_COLUMNS.join(',')}\r\n`;
		for await (const events of this.batches(filter)) yield events.map(toCsvLine).join('');
	}

	private async *jsonChunks(filter: AuditLogFilter) {
		yield '[';
		let separator = '';
		for await (const events of this.batches(filter)) {
			yield separator + events.map((event) => JSON.stringify(event)).join(',');
			separator = ',';
		}
		yield ']';
	}
}
