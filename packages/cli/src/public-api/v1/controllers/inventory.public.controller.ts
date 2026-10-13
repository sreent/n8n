// Fork code (not in upstream n8n): the inventory of workflows in the public API. See
// packages/cli/src/governance/README.md.
import {
	MAX_INVENTORY_PAGE_SIZE,
	WorkflowInventoryListPublicDto,
	WorkflowInventoryQueryPublicDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import {
	ApiDescription,
	ApiKeyScope,
	ApiResponse,
	ApiSummary,
	ApiTags,
	Get,
	PublicApiController,
	Query,
} from '@n8n/decorators';
import type { Response } from 'express';

import { WorkflowInventoryService } from '@/governance/workflow-inventory.service';

import { assertOffsetPage } from '../shared/services/offset-page';
import { encodeNextCursor, resolveOffsetPagination } from '../shared/services/pagination.service';

@PublicApiController('/inventory')
export class InventoryPublicController {
	constructor(private readonly workflowInventoryService: WorkflowInventoryService) {}

	@Get('/workflows')
	@ApiKeyScope({ allOf: ['workflow:list', 'execution:list'] })
	@ApiSummary('Retrieve the inventory of workflows')
	@ApiDescription(
		'Returns one page of the workflows that the user of the key can read, sorted by workflow id, with what a review needs in one call: the status, the home project and the owner, the projects that the workflow is shared with, the node types, the credentials and the triggers of the saved version, and the newest executions. The owner and the admins get all workflows.',
	)
	@ApiTags(['Workflow'])
	@ApiResponse(200, WorkflowInventoryListPublicDto)
	async getWorkflowInventory(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: WorkflowInventoryQueryPublicDto,
	): Promise<WorkflowInventoryListPublicDto> {
		const { offset, limit } = resolveOffsetPagination({ cursor: query.cursor, limit: query.limit });
		assertOffsetPage({ offset, limit }, MAX_INVENTORY_PAGE_SIZE);

		const { count, workflows } = await this.workflowInventoryService.list(req.user, {
			projectId: query.projectId,
			executions: query.executions,
			offset,
			limit,
		});

		return {
			data: workflows,
			nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: count }),
		};
	}
}
