// Fork code (not in upstream n8n): the audit log in the public API. The routes give the same events
// as the REST API of the audit log module. See packages/cli/src/modules/audit-log/README.md.
import {
	AuditLogEventListPublicDto,
	ExportAuditLogQueryPublicDto,
	ListAuditLogEventsQueryPublicDto,
	MAX_ITEMS_PER_PAGE,
} from '@n8n/api-types';
import { ModuleRegistry } from '@n8n/backend-common';
import type { AuthenticatedRequest } from '@n8n/db';
import {
	ApiDescription,
	ApiErrorResponse,
	ApiKeyScope,
	ApiResponse,
	ApiSummary,
	ApiTags,
	Get,
	GlobalScope,
	PublicApiController,
	Query,
} from '@n8n/decorators';
import { Container } from '@n8n/di';
import { BadRequestError, ServiceUnavailableError } from '@n8n/errors';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';

import { encodeNextCursor, resolveOffsetPagination } from '../shared/services/pagination.service';

const tags = ['AuditLog'];

type AuditLogFilterQuery = Pick<
	ListAuditLogEventsQueryPublicDto,
	'from' | 'to' | 'eventName' | 'userId'
>;

const toFilter = ({ from, to, eventName, userId }: AuditLogFilterQuery) => ({
	from: from ? new Date(from) : undefined,
	to: to ? new Date(to) : undefined,
	eventName,
	userId,
});

/**
 * A client can change the cursor, and `limit=0` reads without a limit. The table can hold many
 * events, so a page must have 1 to 250 events.
 */
const isValidPage = ({ offset, limit }: { offset: number; limit: number }) =>
	Number.isSafeInteger(offset) &&
	offset >= 0 &&
	Number.isSafeInteger(limit) &&
	limit >= 1 &&
	limit <= MAX_ITEMS_PER_PAGE;

@PublicApiController('/audit-log')
export class AuditLogPublicController {
	constructor(private readonly moduleRegistry: ModuleRegistry) {}

	/** The service of the audit log module. The module can be off: then the routes answer 503. */
	private async service() {
		if (!this.moduleRegistry.isActive('audit-log')) {
			throw new ServiceUnavailableError('The audit log module is not enabled');
		}
		const { AuditLogService } = await import('@/modules/audit-log/audit-log.service.js');
		return Container.get(AuditLogService);
	}

	@Get('/events')
	@ApiKeyScope('auditLogs:manage')
	@GlobalScope('auditLogs:manage')
	@ApiSummary('Retrieve audit events')
	@ApiDescription(
		'Returns one page of the audit events, newest first. The audit log keeps the events for 90 days by default (`N8N_AUDIT_LOG_RETENTION_DAYS`).',
	)
	@ApiTags(tags)
	@ApiResponse(200, AuditLogEventListPublicDto)
	@ApiErrorResponse(503)
	async getAuditLogEvents(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: ListAuditLogEventsQueryPublicDto,
	): Promise<AuditLogEventListPublicDto> {
		const { offset, limit } = resolveOffsetPagination({ cursor: query.cursor, limit: query.limit });
		if (!isValidPage({ offset, limit })) {
			throw new BadRequestError(
				`The limit must be 1 to ${MAX_ITEMS_PER_PAGE}, and the cursor must come from a previous page`,
			);
		}
		const { count, events } = await (await this.service()).listEvents(
			toFilter(query),
			offset,
			limit,
		);

		return {
			data: events,
			nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: count }),
		};
	}

	@Get('/export')
	@ApiKeyScope('auditLogs:manage')
	@GlobalScope('auditLogs:manage')
	@ApiSummary('Export audit events')
	@ApiDescription(
		'Returns a file with all audit events that match the filter, newest first: a CSV file with the columns `timestamp`, `eventName`, `userId`, `userEmail` and `payload`, or a JSON array of events.',
	)
	@ApiTags(tags)
	@ApiResponse(200)
	@ApiErrorResponse(503)
	async exportAuditLog(
		_req: AuthenticatedRequest,
		res: Response,
		@Query query: ExportAuditLogQueryPublicDto,
	): Promise<void> {
		const { format, ...filter } = query;
		const { contentType, fileName, stream } = (await this.service()).exportEvents(
			toFilter(filter),
			format,
		);

		res.status(200);
		res.setHeader('Content-Type', contentType);
		res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
		await pipeline(stream, res);
	}
}
