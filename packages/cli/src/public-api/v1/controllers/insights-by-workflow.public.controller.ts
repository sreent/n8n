// Fork code (not in upstream n8n): the insights of each workflow in the public API. The route gives
// the data of `GET /rest/insights/by-workflow`, which the Insights page of the editor shows. A
// separate controller keeps the upstream file of `/insights/summary` as it is.
import { InsightsByWorkflowPublicDto, InsightsByWorkflowQueryPublicDto } from '@n8n/api-types';
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
	Licensed,
	PublicApiController,
	Query,
} from '@n8n/decorators';
import { Container } from '@n8n/di';
import { BadRequestError, ForbiddenError, ServiceUnavailableError } from '@n8n/errors';
import type { Response } from 'express';
import { DateTime } from 'luxon';
import { UserError } from 'n8n-workflow';

import { assertOffsetPage } from '../shared/services/offset-page';
import { encodeNextCursor, resolveOffsetPagination } from '../shared/services/pagination.service';

@PublicApiController('/insights/by-workflow')
export class InsightsByWorkflowPublicController {
	constructor(private readonly moduleRegistry: ModuleRegistry) {}

	/** The service of the insights module. The module can be off: then the route answers 503. */
	private async service() {
		if (!this.moduleRegistry.isActive('insights')) {
			throw new ServiceUnavailableError('The insights module is not enabled');
		}
		const { InsightsService } = await import('@n8n/backend-module-insights');
		return Container.get(InsightsService);
	}

	@Get('/')
	@ApiKeyScope('insights:read')
	@Licensed('feat:insights:viewDashboard')
	@ApiSummary('Retrieve insights by workflow')
	@ApiDescription(
		'Returns one page of the workflows with their production executions in the date range: the number of executions and failures, the failure rate, the run time and the time saved. Most executions first, by default. The user of the key gets only the workflows that the user can read. The workflows that were deleted have `workflowId: null`.',
	)
	@ApiTags(['Insights'])
	@ApiResponse(200, InsightsByWorkflowPublicDto)
	@ApiErrorResponse(503)
	async getInsightsByWorkflow(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: InsightsByWorkflowQueryPublicDto,
	): Promise<InsightsByWorkflowPublicDto> {
		const { offset, limit } = resolveOffsetPagination({ cursor: query.cursor, limit: query.limit });
		assertOffsetPage({ offset, limit });

		const endDate = query.endDate ? new Date(query.endDate) : new Date();
		const startDate = query.startDate
			? new Date(query.startDate)
			: DateTime.now().minus({ days: 7 }).toJSDate();
		if (query.startDate && query.endDate && startDate > endDate) {
			throw new BadRequestError('endDate must be the same as or after startDate');
		}

		const insightsService = await this.service();
		try {
			insightsService.validateDateFiltersLicense({ startDate, endDate });
		} catch (error) {
			if (error instanceof UserError) throw new ForbiddenError(error.message);
			throw error;
		}

		const { count, data } = await insightsService.getInsightsByWorkflow({
			user: req.user,
			skip: offset,
			take: limit,
			sortBy: query.sortBy,
			projectId: query.projectId,
			startDate,
			endDate,
		});

		return {
			// `hasReadAccess` only repeats that `workflowId` is not null.
			data: data.map(({ hasReadAccess: _, ...workflow }) => workflow),
			nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: count }),
		};
	}
}
