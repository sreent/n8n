// Fork code (not in upstream n8n): the audit log in the public API (`/api/v1/audit-log`). See
// packages/cli/src/modules/audit-log/README.md.
import '../../openapi-extend';

import { z } from 'zod';

import {
	auditLogEventFieldDocs,
	auditLogListFieldDocs,
	auditLogQueryFieldDocs,
} from './audit-log-public.openapi';
import { projectTypeSchema } from '../../schemas/project.schema';
import { Z } from '../../zod-class';
import { publicApiPaginationSchema } from '../pagination/pagination.dto';

// `.datetime()` only checks the pattern, so an impossible offset such as `+99:99` passes it; the
// refine rejects those values.
const dateTimeQuerySchema = z
	.string()
	.datetime({ offset: true })
	.refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid datetime');

const auditLogFilterPublicSchema = {
	from: dateTimeQuerySchema.optional().openapi(auditLogQueryFieldDocs.from),
	to: dateTimeQuerySchema.optional().openapi(auditLogQueryFieldDocs.to),
	eventName: z.string().trim().min(1).max(128).optional().openapi(auditLogQueryFieldDocs.eventName),
	userId: z.string().trim().min(1).max(36).optional().openapi(auditLogQueryFieldDocs.userId),
	projectId: z.string().trim().min(1).max(36).optional().openapi(auditLogQueryFieldDocs.projectId),
	projectType: projectTypeSchema.optional().openapi(auditLogQueryFieldDocs.projectType),
};

export class ListAuditLogEventsQueryPublicDto extends Z.class({
	...auditLogFilterPublicSchema,
	limit: publicApiPaginationSchema.limit,
	cursor: z.string().optional(),
}) {}

export class ExportAuditLogQueryPublicDto extends Z.class({
	...auditLogFilterPublicSchema,
	format: z.enum(['csv', 'json']).default('csv').openapi(auditLogQueryFieldDocs.format),
}) {}

export const auditLogEventPublicSchema = z.object({
	id: z.string().openapi(auditLogEventFieldDocs.id),
	eventName: z.string().openapi(auditLogEventFieldDocs.eventName),
	timestamp: z.string().datetime().openapi(auditLogEventFieldDocs.timestamp),
	userId: z.string().nullable().openapi(auditLogEventFieldDocs.userId),
	userEmail: z.string().nullable().openapi(auditLogEventFieldDocs.userEmail),
	projectId: z.string().nullable().openapi(auditLogEventFieldDocs.projectId),
	projectType: z.string().nullable().openapi(auditLogEventFieldDocs.projectType),
	payload: z.record(z.unknown()).openapi(auditLogEventFieldDocs.payload),
});

export type AuditLogEventPublic = z.infer<typeof auditLogEventPublicSchema>;

export class AuditLogEventListPublicDto extends Z.class({
	data: z.array(auditLogEventPublicSchema),
	nextCursor: z.string().nullable().openapi(auditLogListFieldDocs.nextCursor),
}) {}
