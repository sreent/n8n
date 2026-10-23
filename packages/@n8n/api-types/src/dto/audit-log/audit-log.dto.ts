// Fork code (not in upstream n8n): the REST API of the audit log (`/rest/audit-log`), for the
// backend module and the editor module. See packages/cli/src/modules/audit-log/README.md.
import { z } from 'zod';

import { projectTypeSchema } from '../../schemas/project.schema';
import {
	dateTimeQueryParamSchema,
	wholeNumberQueryParamSchema,
} from '../../schemas/fork-query-params.schema';
import { Z } from '../../zod-class';

/** The default and the largest page size of the list of events. */
export const AUDIT_LOG_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_LOG_MAX_PAGE_SIZE = 250;

export const AUDIT_LOG_EXPORT_FORMATS = ['csv', 'json'] as const;

export type AuditLogExportFormat = (typeof AUDIT_LOG_EXPORT_FORMATS)[number];

const auditLogFilterSchema = {
	from: dateTimeQueryParamSchema.optional(),
	to: dateTimeQueryParamSchema.optional(),
	/** An event name, or a prefix that ends with a dot, for example `n8n.audit.user.`. */
	eventName: z.string().trim().min(1).max(128).optional(),
	userId: z.string().trim().min(1).max(36).optional(),
	projectId: z.string().trim().min(1).max(36).optional(),
	projectType: projectTypeSchema.optional(),
};

export class AuditLogEventsQueryDto extends Z.class({
	...auditLogFilterSchema,
	skip: wholeNumberQueryParamSchema(0, 0),
	take: wholeNumberQueryParamSchema(AUDIT_LOG_DEFAULT_PAGE_SIZE, 1, AUDIT_LOG_MAX_PAGE_SIZE),
}) {}

export class AuditLogExportQueryDto extends Z.class({
	...auditLogFilterSchema,
	format: z.enum(AUDIT_LOG_EXPORT_FORMATS).default('csv'),
}) {}

/** An audit event as the REST API gives it. */
export interface AuditLogEventResponse {
	id: string;
	eventName: string;
	/** The time of the event, in ISO 8601 (UTC). */
	timestamp: string;
	userId: string | null;
	userEmail: string | null;
	/** The project of the event, for example the home project of the workflow that it names. */
	projectId: string | null;
	/** `personal` or `team`. */
	projectType: string | null;
	payload: Record<string, unknown>;
}

/** The answer of `GET /rest/audit-log/events`. */
export interface AuditLogEventsPage {
	/** The number of all events that match the filters. */
	count: number;
	/** One page of the events, newest first. */
	events: AuditLogEventResponse[];
}
