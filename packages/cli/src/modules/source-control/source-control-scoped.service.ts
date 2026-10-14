import type { AuthenticatedRequest, User } from '@n8n/db';
import { Service } from '@n8n/di';
import { ForbiddenError } from '@n8n/errors';
import { hasGlobalScope } from '@n8n/permissions';

import { ProjectService } from '@/services/project.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

/**
 * Fork code (not in upstream n8n): the access checks of source control that depend on the
 * projects of a user. A user with `sourceControl:push` in one team project may read the status
 * for a push and push the resources of that project. See `README.md` in this folder.
 */
@Service()
export class SourceControlScopedService {
	constructor(
		private readonly projectService: ProjectService,
		private readonly workflowFinderService: WorkflowFinderService,
	) {}

	private async canPushSomewhere(user: User) {
		if (hasGlobalScope(user, 'sourceControl:push')) return true;
		const projectIds = await this.projectService.getProjectIdsWithScope(user, [
			'sourceControl:push',
		]);
		return projectIds.length > 0;
	}

	/** The status for a pull needs the global scope `sourceControl:pull`. */
	async ensureIsAllowedToGetStatus(req: AuthenticatedRequest) {
		if (!(await this.canPushSomewhere(req.user))) {
			throw new ForbiddenError('You do not have permission to read source control status');
		}
		const query: Record<string, unknown> = req.query ?? {};
		const direction = query.direction;
		if (direction === 'pull' && !hasGlobalScope(req.user, 'sourceControl:pull')) {
			throw new ForbiddenError('You do not have permission to pull from source control');
		}
	}

	async ensureIsAllowedToPush(req: AuthenticatedRequest) {
		if (!(await this.canPushSomewhere(req.user))) {
			throw new ForbiddenError('You are not allowed to push changes');
		}
	}

	/** A user without the global scope `workflow:read` must have access to the workflow. */
	async ensureIsAllowedToReadWorkflow(user: User, workflowId: string) {
		if (hasGlobalScope(user, 'workflow:read')) return;
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, [
			'workflow:read',
		]);
		if (!workflow) {
			throw new ForbiddenError(`You are not allowed to access workflow with id ${workflowId}`);
		}
	}
}
