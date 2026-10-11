import type { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, Query, RestController } from '@n8n/decorators';
import type { Response } from 'express';

import { AuditLogEventsQueryDto, AuditLogExportQueryDto } from './audit-log.dto';
import { AuditLogService } from './audit-log.service';

/** The audit log, for users with the global scope `auditLogs:manage`: the owner and admins. */
@RestController('/audit-log')
export class AuditLogController {
	constructor(private readonly auditLogService: AuditLogService) {}

	@Get('/events')
	@GlobalScope('auditLogs:manage')
	async listEvents(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: AuditLogEventsQueryDto,
	) {
		const { skip, take, ...filter } = query;
		return await this.auditLogService.listEvents(filter, skip, take);
	}

	@Get('/event-names')
	@GlobalScope('auditLogs:manage')
	eventNames() {
		return this.auditLogService.eventNames();
	}

	@Get('/export')
	@GlobalScope('auditLogs:manage')
	exportEvents(_req: AuthenticatedRequest, res: Response, @Query query: AuditLogExportQueryDto) {
		const { format, ...filter } = query;
		const { contentType, fileName, stream } = this.auditLogService.exportEvents(filter, format);
		res.setHeader('Content-Type', contentType);
		res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
		// A failed read after the start of the response can only end the connection.
		stream.on('error', (error) => res.destroy(error));
		return stream;
	}
}
