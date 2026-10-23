import type { OpenTriggerItem, PolicyViolation } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, Param, ProjectScope, RestController } from '@n8n/decorators';
import { NotFoundError } from '@n8n/errors';

import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { OpenTriggerCheck } from './open-trigger.check';
import { OpenTriggersService } from './open-triggers.service';

@RestController('/open-triggers')
export class OpenTriggersController {
	constructor(
		private readonly openTriggersService: OpenTriggersService,
		private readonly openTriggerCheck: OpenTriggerCheck,
		private readonly workflowFinderService: WorkflowFinderService,
	) {}

	/**
	 * The open triggers of the published workflows, for the page Settings > Open triggers. Only
	 * users with the global scope `workflow:list` can call it: the owner and the admins.
	 */
	@Get('/')
	@GlobalScope('workflow:list')
	async list(req: AuthenticatedRequest): Promise<OpenTriggerItem[]> {
		return await this.openTriggersService.listPublished(req.user);
	}

	/**
	 * The open triggers that stop a publish of the saved workflow, as the publish check gives them.
	 * The editor asks before it opens the dialogs of a publish, so the user fixes the triggers first.
	 */
	@Get('/workflows/:workflowId/violations')
	@ProjectScope('workflow:publish')
	async violations(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('workflowId') workflowId: string,
	): Promise<PolicyViolation[]> {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, req.user, [
			'workflow:publish',
		]);
		if (!workflow) throw new NotFoundError('Could not find the workflow');

		return await this.openTriggerCheck.violationsFor(workflow);
	}
}
