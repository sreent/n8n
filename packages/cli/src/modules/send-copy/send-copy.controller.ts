import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Param, Post, Query, RestController } from '@n8n/decorators';

import { ListCopyRecipientsQueryDto, SendWorkflowCopyDto } from './send-copy.dto';
import { SendCopyService } from './send-copy.service';

@RestController('/send-copy')
export class SendCopyController {
	constructor(private readonly sendCopyService: SendCopyService) {}

	/** Lists the users who can receive a copy. Uses the same scope as the users list. */
	@Get('/recipients')
	@GlobalScope('user:list')
	async listRecipients(
		req: AuthenticatedRequest,
		_res: unknown,
		@Query query: ListCopyRecipientsQueryDto,
	) {
		return await this.sendCopyService.listRecipients(req.user, {
			search: query.search,
			limit: query.limit,
		});
	}

	/**
	 * Sends a copy of a workflow to colleagues. The service checks that the sender
	 * can read the workflow.
	 */
	@Post('/workflows/:workflowId', {
		keyedRateLimit: { source: 'user', limit: 30, windowMs: 60_000 },
	})
	async sendWorkflowCopy(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('workflowId') workflowId: string,
		@Body body: SendWorkflowCopyDto,
	) {
		const results = await this.sendCopyService.sendWorkflowCopy(
			req.user,
			workflowId,
			body.recipientIds,
		);
		return { results };
	}
}
