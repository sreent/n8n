import type { WorkflowReviewWorkflowCauseActivityType } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import type { OperationContext } from '@n8n/db';
import {
	DbLock,
	DbLockService,
	WorkflowReviewActivityRepository,
	WorkflowReviewLifecycleRepository,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';

import { CollaborationService } from '@/collaboration/collaboration.service';
import { WorkflowPublishBlockedError } from '@/errors/response-errors/workflow-publish-blocked.error';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';
import type { WorkflowMutationHooks } from '@/workflows/workflow-mutation-hooks-proxy.service';
import type { WorkflowPublishGuard } from '@/workflows/workflow-publish-guard-proxy.service';

type CloseTrigger = 'workflow-archived' | 'workflow-moved' | 'workflow-deleted' | 'unknown';

type AffectedRequest = { requestId: string; workflowIds: string[] };

/**
 * Fork code (not in upstream n8n): the publish guard and the mutation hooks of the workflow
 * reviews. An open review stops a publish. A publish, an archive, a move and a delete of a
 * workflow go into the feeds of its reviews, and close the reviews that have nothing left to
 * review. See `README.md`.
 */
@Service()
export class WorkflowReviewLifecycleService implements WorkflowPublishGuard, WorkflowMutationHooks {
	/** The open reviews of the workflows that are being deleted, found before the delete. */
	private readonly pendingDeletes = new Map<
		string,
		{ userId: string | null; requests: AffectedRequest[] }
	>();

	constructor(
		private readonly logger: Logger,
		private readonly dbLockService: DbLockService,
		private readonly requestRepository: WorkflowReviewRequestRepository,
		private readonly requestWorkflowRepository: WorkflowReviewRequestWorkflowRepository,
		private readonly lifecycleRepository: WorkflowReviewLifecycleRepository,
		private readonly activityRepository: WorkflowReviewActivityRepository,
		private readonly eventService: EventService,
		private readonly collaborationService: CollaborationService,
		private readonly policyService: WorkflowReviewPolicyService,
	) {}

	/** While the policy is on, an open review stops the publish of a new version. */
	async assertCanPublish(workflowId: string): Promise<void> {
		if (!(await this.policyService.get()).enabled) return;
		const open = await this.requestRepository.findOpenRequestForWorkflow(workflowId, {});
		if (!open) return;
		throw new WorkflowPublishBlockedError({
			reason: open.decision === 'changes_requested' ? 'changes_requested' : 'review_pending',
			workflowReviewRequestId: open.id,
		});
	}

	/** Each review, open or closed, that pins the published version gets the publish. */
	async afterWorkflowPublished(event: {
		workflowId: string;
		versionId: string;
		userId: string;
	}): Promise<void> {
		try {
			await this.withLock(async (ctx) => {
				const requestIds = await this.requestWorkflowRepository.findRequestIdsPinnedToVersion(
					{ workflowId: event.workflowId, workflowVersionId: event.versionId },
					ctx,
				);
				for (const requestId of requestIds) {
					await this.activityRepository.createActivity(
						{
							workflowReviewRequestId: requestId,
							createdById: event.userId,
							type: 'workflow.published',
							data: { workflowId: event.workflowId, workflowVersionId: event.versionId },
						},
						ctx,
					);
				}
			});
		} catch (error) {
			this.logger.warn('Failed to record a publish in the workflow reviews', { ...event, error });
		}
		await this.broadcast(event.workflowId);
	}

	async afterWorkflowArchived(workflowId: string, userId: string | null): Promise<void> {
		await this.recordAndClose([workflowId], userId, 'workflow.archived', 'workflow-archived');
	}

	async afterWorkflowsTransferred(workflowIds: string[], userId: string | null): Promise<void> {
		await this.recordAndClose(workflowIds, userId, 'workflow.moved', 'workflow-moved');
	}

	/** The delete cascades the links of the reviews away, so find the open reviews first. */
	async beforeWorkflowDeleted(workflowId: string, userId: string | null): Promise<void> {
		try {
			const affected = await this.lifecycleRepository.findOpenRequestsAffectedByWorkflows(
				[workflowId],
				{},
			);
			this.pendingDeletes.set(workflowId, {
				userId,
				requests: affected.map(({ request, links }) => ({
					requestId: request.id,
					workflowIds: links.map((link) => link.workflowId),
				})),
			});
		} catch (error) {
			this.logger.warn('Failed to find the reviews of a workflow before its delete', {
				workflowId,
				error,
			});
		}
	}

	async afterWorkflowsDeleted(workflowIds: string[]): Promise<void> {
		for (const workflowId of workflowIds) {
			const pending = this.pendingDeletes.get(workflowId);
			this.pendingDeletes.delete(workflowId);
			if (!pending || pending.requests.length === 0) continue;
			await this.recordAndClose(
				[workflowId],
				pending.userId,
				'workflow.deleted',
				'workflow-deleted',
				pending.requests,
			);
		}
	}

	/**
	 * Close the open reviews that have nothing left to review, for example after a change that ran
	 * without the hooks. The module runs it at the start.
	 */
	async closeUnreviewableRequests(): Promise<void> {
		try {
			const closed = await this.withLock(async (ctx) => {
				const requestIds = await this.lifecycleRepository.findUnreviewableOpenRequestIds(ctx);
				await this.close(requestIds, ctx);
				return requestIds;
			});
			for (const requestId of closed) {
				this.emitClosed(requestId, 'unknown', null);
			}
		} catch (error) {
			this.logger.warn('Failed to close the workflow reviews without a workflow', { error });
		}
	}

	/**
	 * Write the cause into the feed of each open review of the workflows, then close the reviews
	 * that have nothing left to review. A hook must not throw, so errors are only logged.
	 */
	private async recordAndClose(
		workflowIds: string[],
		userId: string | null,
		type: WorkflowReviewWorkflowCauseActivityType,
		trigger: CloseTrigger,
		known?: AffectedRequest[],
	) {
		const actorKind = userId ? 'user' : 'system';
		try {
			const { affected, closed } = await this.withLock(async (ctx) => {
				const requests =
					known ??
					(
						await this.lifecycleRepository.findOpenRequestsAffectedByWorkflows(workflowIds, ctx)
					).map(({ request, links }) => ({
						requestId: request.id,
						workflowIds: links.map((link) => link.workflowId),
					}));
				for (const { requestId, workflowIds: linked } of requests) {
					for (const workflowId of linked) {
						await this.activityRepository.createActivity(
							{
								workflowReviewRequestId: requestId,
								createdById: userId,
								type,
								data: { workflowId, actorKind },
							},
							ctx,
						);
					}
				}
				const closable = await this.lifecycleRepository.findUnreviewableOpenRequestIds(
					ctx,
					requests.map(({ requestId }) => requestId),
				);
				await this.close(closable, ctx);
				return { affected: requests, closed: closable };
			});

			for (const requestId of closed) this.emitClosed(requestId, trigger, userId);
			const touched = new Set(affected.flatMap(({ workflowIds: linked }) => linked));
			for (const workflowId of touched) await this.broadcast(workflowId);
		} catch (error) {
			this.logger.warn('Failed to update the workflow reviews after a workflow change', {
				workflowIds,
				error,
			});
		}
	}

	private async close(requestIds: string[], ctx: OperationContext) {
		for (const requestId of requestIds) {
			await this.activityRepository.createActivity(
				{
					workflowReviewRequestId: requestId,
					createdById: null,
					type: 'review.closed',
					data: { reason: 'no-reviewable-workflows' },
				},
				ctx,
			);
		}
		await this.requestRepository.closeRequests(requestIds, ctx);
	}

	private emitClosed(requestId: string, trigger: CloseTrigger, userId: string | null) {
		this.eventService.emit('workflow-review-closed', {
			workflowReviewRequestId: requestId,
			cause: { trigger, actorKind: userId ? 'user' : 'system', userId },
		});
	}

	private async withLock<T>(fn: (ctx: OperationContext) => Promise<T>) {
		return await this.dbLockService.withLockContext(DbLock.WORKFLOW_REVIEW_MUTATION, fn);
	}

	private async broadcast(workflowId: string) {
		try {
			await this.collaborationService.broadcastWorkflowReviewStateChanged(workflowId);
		} catch (error) {
			this.logger.warn('Failed to send the review state of a workflow', { workflowId, error });
		}
	}
}
