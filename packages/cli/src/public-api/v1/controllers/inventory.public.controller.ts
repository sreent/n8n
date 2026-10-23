// Fork code (not in upstream n8n): the inventory of workflows and the open triggers in the public
// API. See packages/cli/src/governance/README.md and packages/cli/src/modules/open-triggers/README.md.
import {
	MAX_INVENTORY_PAGE_SIZE,
	MAX_OPEN_TRIGGER_PAGE_SIZE,
	OpenTriggerListPublicDto,
	OpenTriggerQueryPublicDto,
	WorkflowInventoryListPublicDto,
	WorkflowInventoryQueryPublicDto,
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
	PublicApiController,
	Query,
} from '@n8n/decorators';
import { Container } from '@n8n/di';
import { ServiceUnavailableError } from '@n8n/errors';
import type { Response } from 'express';

import { WorkflowInventoryService } from '@/governance/workflow-inventory.service';

import { assertOffsetPage } from '../shared/services/offset-page';
import {
	encodeNextCursor,
	paginateArray,
	resolveOffsetPagination,
} from '../shared/services/pagination.service';

@PublicApiController('/inventory')
export class InventoryPublicController {
	constructor(
		private readonly workflowInventoryService: WorkflowInventoryService,
		private readonly moduleRegistry: ModuleRegistry,
	) {}

	/** The service of the open-triggers module. The module can be off: then the route answers 503. */
	private async openTriggersService() {
		if (!this.moduleRegistry.isActive('open-triggers')) {
			throw new ServiceUnavailableError('The open-triggers module is not enabled');
		}
		const { OpenTriggersService } = await import(
			'@/modules/open-triggers/open-triggers.service.js'
		);
		return Container.get(OpenTriggersService);
	}

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

	@Get('/open-triggers')
	@ApiKeyScope({ allOf: ['workflow:list'] })
	@ApiSummary('Retrieve the open triggers of published workflows')
	@ApiDescription(
		'Returns one page of the triggers without authentication in the published versions of the workflows that the user of the key can read: Webhook nodes, Form Triggers, public Chat Triggers and MCP Server Triggers. The items are sorted by the names of the workflows and of the nodes. Each item tells whether an approved workflow review covers the trigger. The owner and the admins get all workflows.',
	)
	@ApiTags(['Workflow'])
	@ApiResponse(200, OpenTriggerListPublicDto)
	@ApiErrorResponse(503)
	async getOpenTriggers(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: OpenTriggerQueryPublicDto,
	): Promise<OpenTriggerListPublicDto> {
		const { offset, limit } = resolveOffsetPagination({ cursor: query.cursor, limit: query.limit });
		assertOffsetPage({ offset, limit }, MAX_OPEN_TRIGGER_PAGE_SIZE);

		const items = await (await this.openTriggersService()).listPublished(req.user, {
			projectId: query.projectId,
		});

		return paginateArray(items, { offset, limit });
	}
}
