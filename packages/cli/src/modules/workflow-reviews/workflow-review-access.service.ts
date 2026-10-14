import type { WorkflowReviewDecisionIneligibilityReason } from '@n8n/api-types';
import { RoleService } from '@n8n/backend-services';
import type { InboxVisibility, User, WorkflowReviewRequest } from '@n8n/db';
import {
	GLOBAL_ADMIN_ROLE,
	GLOBAL_OWNER_ROLE,
	ProjectRelationRepository,
	WorkflowReviewRequestAuthorRepository,
	WorkflowReviewRequestReviewerRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { hasGlobalScope, PROJECT_ADMIN_ROLE_SLUG } from '@n8n/permissions';

import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

/** Who the viewer is for a review, and which linked workflows the viewer can read. */
export type ReviewViewer = {
	isInstanceAdmin: boolean;
	isProjectAdmin: boolean;
	isAuthor: boolean;
	isReviewer: boolean;
	linkedWorkflowIds: string[];
	readableWorkflowIds: string[];
};

export type DecisionEligibility =
	| { canDecide: true; via: 'assigned-reviewer' | 'admin-override' }
	| { canDecide: false; reason: WorkflowReviewDecisionIneligibilityReason };

/**
 * Fork code (not in upstream n8n): who may open a workflow review, decide on it and comment on
 * it. The instance owner and admins may open each review. Other users may open a review when they
 * are an admin of its project (the role `project:admin`), an author or a reviewer, and can read a
 * linked workflow, or no workflow is left. See `README.md`.
 */
@Service()
export class WorkflowReviewAccessService {
	constructor(
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly authorRepository: WorkflowReviewRequestAuthorRepository,
		private readonly reviewerRepository: WorkflowReviewRequestReviewerRepository,
		private readonly requestWorkflowRepository: WorkflowReviewRequestWorkflowRepository,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly roleService: RoleService,
	) {}

	isInstanceAdmin(user: User) {
		return user.role.slug === GLOBAL_OWNER_ROLE.slug || user.role.slug === GLOBAL_ADMIN_ROLE.slug;
	}

	/** Only the role `project:admin` counts, not a custom role with the same scopes. */
	async isProjectAdmin(user: User, projectId: string) {
		const relation = await this.projectRelationRepository.findOne({
			where: { projectId, userId: user.id },
			relations: { role: true },
			loadEagerRelations: false,
		});
		return relation?.role.slug === PROJECT_ADMIN_ROLE_SLUG;
	}

	async canReadWorkflow(user: User, workflowId: string) {
		const workflow = await this.workflowFinderService.findWorkflowHeadForUser(workflowId, user, [
			'workflow:read',
		]);
		return workflow !== null;
	}

	async canPublishWorkflow(user: User, workflowId: string) {
		const workflow = await this.workflowFinderService.findWorkflowHeadForUser(workflowId, user, [
			'workflow:publish',
		]);
		return workflow !== null;
	}

	async getViewer(
		user: User,
		request: Pick<WorkflowReviewRequest, 'id' | 'projectId'>,
	): Promise<ReviewViewer> {
		const ctx = {};
		const links = await this.requestWorkflowRepository.findByRequestId(request.id, ctx);
		const linkedWorkflowIds = links.map((link) => link.workflowId);
		const readableWorkflowIds: string[] = [];
		for (const workflowId of linkedWorkflowIds) {
			if (await this.canReadWorkflow(user, workflowId)) readableWorkflowIds.push(workflowId);
		}

		return {
			isInstanceAdmin: this.isInstanceAdmin(user),
			isProjectAdmin: await this.isProjectAdmin(user, request.projectId),
			isAuthor: await this.authorRepository.isAuthor(
				{ workflowReviewRequestId: request.id, userId: user.id },
				ctx,
			),
			isReviewer: await this.reviewerRepository.isReviewer(
				{ workflowReviewRequestId: request.id, userId: user.id },
				ctx,
			),
			linkedWorkflowIds,
			readableWorkflowIds,
		};
	}

	/** The same rule as the visibility of the inbox. */
	canOpen(viewer: ReviewViewer) {
		if (viewer.isInstanceAdmin) return true;
		const involved = viewer.isProjectAdmin || viewer.isAuthor || viewer.isReviewer;
		return (
			involved && (viewer.linkedWorkflowIds.length === 0 || viewer.readableWorkflowIds.length > 0)
		);
	}

	/**
	 * Who may decide. It ignores the state of the review: the caller checks that the review is
	 * open. Without a linked workflow, nobody may decide.
	 */
	decisionEligibility(viewer: ReviewViewer): DecisionEligibility {
		const canReadAll =
			viewer.linkedWorkflowIds.length > 0 &&
			viewer.readableWorkflowIds.length === viewer.linkedWorkflowIds.length;
		if (viewer.linkedWorkflowIds.length === 0) {
			return { canDecide: false, reason: 'missing_permission' };
		}
		if (viewer.isReviewer) {
			return canReadAll
				? { canDecide: true, via: 'assigned-reviewer' }
				: { canDecide: false, reason: 'missing_reviewer_permission' };
		}
		if ((viewer.isInstanceAdmin || viewer.isProjectAdmin) && canReadAll) {
			return { canDecide: true, via: 'admin-override' };
		}
		if (viewer.isAuthor) return { canDecide: false, reason: 'author' };
		return { canDecide: false, reason: 'missing_permission' };
	}

	/** A comment needs a linked workflow that the viewer can read. */
	canComment(viewer: ReviewViewer) {
		return this.canOpen(viewer) && viewer.readableWorkflowIds.length > 0;
	}

	/** The rows of the inbox that the user may see (see `WorkflowReviewInboxRepository`). */
	async inboxVisibility(user: User): Promise<InboxVisibility> {
		if (this.isInstanceAdmin(user)) return { scope: 'all' };

		const adminProjectIds = await this.projectRelationRepository.getAccessibleProjectsByRoles(
			user.id,
			[PROJECT_ADMIN_ROLE_SLUG],
		);
		const readableWorkflowRoles = await this.roleService.rolesWithScope('workflow', [
			'workflow:read',
		]);
		const readableProjectIds = hasGlobalScope(user, 'workflow:read')
			? null
			: await this.projectRelationRepository.getAccessibleProjectsByRoles(
					user.id,
					await this.roleService.rolesWithScope('project', ['workflow:read']),
				);

		return {
			scope: 'involved',
			userId: user.id,
			adminProjectIds,
			readableProjectIds,
			readableWorkflowRoles,
		};
	}
}
