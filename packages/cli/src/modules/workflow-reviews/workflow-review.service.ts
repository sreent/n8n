import type {
	CreateWorkflowReviewCommentDto,
	CreateWorkflowReviewRequestDto,
	DecideWorkflowReviewRequestDto,
	DecideWorkflowReviewRequestResponse,
	UpdateWorkflowReviewRequestVersionDto,
	WorkflowReviewActivityEntry,
	WorkflowReviewAutoPublishOutcome,
	WorkflowReviewRequestSummary,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import type { OperationContext, User, WorkflowReviewRequest } from '@n8n/db';
import {
	DbLock,
	DbLockService,
	SharedWorkflowRepository,
	UserRepository,
	WorkflowHistoryRepository,
	WorkflowReviewActivityCommentRepository,
	WorkflowReviewActivityRepository,
	WorkflowReviewRequestAuthorRepository,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestReviewerRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@n8n/errors';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import { CollaborationService } from '@/collaboration/collaboration.service';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';
import { WorkflowService } from '@/workflows/workflow.service';

import { WorkflowReviewAccessService } from './workflow-review-access.service';
import { toActivityEntry, toSummary } from './workflow-review-mapper';
import { WorkflowReviewReadService } from './workflow-review-read.service';

const NOT_OPEN = 'The review request is no longer open';

/** A blank text removes the value. */
function blankToNull(text: string) {
	const trimmed = text.trim();
	return trimmed === '' ? null : trimmed;
}

/** A text that is not in the body leaves the value as it is. */
function optionalBlankToNull(text: string | undefined) {
	return text === undefined ? undefined : blankToNull(text);
}

/**
 * Fork code (not in upstream n8n): the changes of the workflow reviews. They run one at a time
 * under the database lock `WORKFLOW_REVIEW_MUTATION`. See `README.md`.
 */
@Service()
export class WorkflowReviewService {
	constructor(
		private readonly logger: Logger,
		private readonly dbLockService: DbLockService,
		private readonly requestRepository: WorkflowReviewRequestRepository,
		private readonly requestWorkflowRepository: WorkflowReviewRequestWorkflowRepository,
		private readonly authorRepository: WorkflowReviewRequestAuthorRepository,
		private readonly reviewerRepository: WorkflowReviewRequestReviewerRepository,
		private readonly activityRepository: WorkflowReviewActivityRepository,
		private readonly commentRepository: WorkflowReviewActivityCommentRepository,
		private readonly workflowHistoryRepository: WorkflowHistoryRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly userRepository: UserRepository,
		private readonly workflowService: WorkflowService,
		private readonly eventService: EventService,
		private readonly collaborationService: CollaborationService,
		private readonly policyService: WorkflowReviewPolicyService,
		private readonly access: WorkflowReviewAccessService,
		private readonly read: WorkflowReviewReadService,
	) {}

	/** Each route needs the policy of the instance. */
	async assertEnabled() {
		if (!(await this.policyService.get()).enabled) {
			throw new ForbiddenError('Workflow reviews are disabled on this instance');
		}
	}

	async create(
		user: User,
		dto: CreateWorkflowReviewRequestDto,
	): Promise<WorkflowReviewRequestSummary> {
		const [entry] = dto.workflows;
		const workflow = await this.read.findWorkflowOrFail(user, entry.workflowId, 'workflow:publish');
		if (workflow.isArchived) {
			throw new BadRequestError(
				`The workflow '${workflow.id}' is archived and cannot be submitted for review`,
			);
		}
		await this.assertVersionExists(workflow.id, entry.workflowVersionId);
		const reviewerIds = [...new Set(dto.reviewerUserIds)];
		if (reviewerIds.includes(user.id)) {
			throw new BadRequestError('You cannot assign yourself as a reviewer');
		}
		const eligibleIds = new Set(
			(await this.read.findEligibleReviewers(workflow.id, user.id)).map(({ id }) => id),
		);
		const notEligible = reviewerIds.filter((id) => !eligibleIds.has(id));
		if (notEligible.length > 0) {
			throw new BadRequestError(
				`These users are not eligible to review this workflow: ${notEligible.join(', ')}`,
			);
		}
		const project = await this.sharedWorkflowRepository.getWorkflowOwningProject(workflow.id);
		if (!project) throw new NotFoundError('Could not find workflow');

		const request = await this.withLock(async (ctx) => {
			const open = await this.requestRepository.findOpenRequestForWorkflow(workflow.id, ctx);
			if (open) {
				throw new ConflictError(
					'An open review request already exists for this workflow',
					'Update the existing review request instead of creating a new one',
					{ workflowReviewRequestId: open.id },
				);
			}
			const created = await this.requestRepository.createRequest(
				{
					projectId: project.id,
					title: dto.title,
					description: dto.description === undefined ? null : blankToNull(dto.description),
					createdById: user.id,
				},
				ctx,
			);
			await this.requestWorkflowRepository.createWorkflowRow(
				{
					workflowReviewRequestId: created.id,
					workflowId: workflow.id,
					workflowVersionId: entry.workflowVersionId,
				},
				ctx,
			);
			await this.authorRepository.addAuthor(
				{ workflowReviewRequestId: created.id, userId: user.id },
				ctx,
			);
			await this.reviewerRepository.addReviewers(
				{ workflowReviewRequestId: created.id, userIds: reviewerIds },
				ctx,
			);
			await this.workflowHistoryRepository.updateVersionMetadata(
				{
					workflowId: workflow.id,
					versionId: entry.workflowVersionId,
					name: entry.workflowVersionName,
					description: optionalBlankToNull(entry.workflowVersionDescription),
				},
				ctx,
			);
			await this.activityRepository.createActivity(
				{
					workflowReviewRequestId: created.id,
					createdById: user.id,
					type: 'review.opened',
					data: {
						workflowVersions: [
							{ workflowId: workflow.id, workflowVersionId: entry.workflowVersionId },
						],
					},
				},
				ctx,
			);
			return created;
		});

		this.eventService.emit('workflow-review-requested', {
			user,
			workflowReviewRequestId: request.id,
			projectId: project.id,
			workflowId: workflow.id,
			workflowVersionId: entry.workflowVersionId,
			reviewerCount: reviewerIds.length,
		});
		await this.broadcast(workflow.id);
		return toSummary(request, entry.workflowVersionId);
	}

	async updateVersion(
		user: User,
		requestId: string,
		dto: UpdateWorkflowReviewRequestVersionDto,
	): Promise<WorkflowReviewRequestSummary> {
		const request = await this.read.findRequestOrFail(requestId);
		const links = await this.requestWorkflowRepository.findByRequestId(request.id, {});
		if (!links.some((link) => link.workflowId === dto.workflowId)) {
			throw new NotFoundError('Could not find review request');
		}
		await this.read.findWorkflowOrFail(user, dto.workflowId, 'workflow:publish');
		if (request.state !== 'open') throw new ConflictError(NOT_OPEN);
		await this.assertVersionExists(dto.workflowId, dto.workflowVersionId);

		const description = optionalBlankToNull(dto.description);
		const outcome = await this.withLock(async (ctx) => {
			const current = await this.findOpenRequest(request.id, ctx);
			const link = (await this.requestWorkflowRepository.findByRequestId(request.id, ctx)).find(
				(row) => row.workflowId === dto.workflowId,
			);
			if (!link) throw new NotFoundError('Could not find review request');

			await this.workflowHistoryRepository.updateVersionMetadata(
				{
					workflowId: dto.workflowId,
					versionId: dto.workflowVersionId,
					name: dto.workflowVersionName,
					description: optionalBlankToNull(dto.workflowVersionDescription),
				},
				ctx,
			);

			// The pinned version again: only its name, its description and the review description.
			if (link.workflowVersionId === dto.workflowVersionId) {
				const changed = description !== undefined && description !== current.description;
				if (changed) {
					current.description = description;
					current.updatedById = user.id;
					await this.requestRepository.saveRequest(current, ctx);
				}
				return { request: current, versionChanged: false, descriptionChanged: changed };
			}

			await this.requestWorkflowRepository.updateWorkflowVersion(
				{
					workflowReviewRequestId: request.id,
					workflowId: dto.workflowId,
					workflowVersionId: dto.workflowVersionId,
				},
				ctx,
			);
			current.decision = 'pending';
			current.updatedById = user.id;
			if (description !== undefined) current.description = description;
			const saved = await this.requestRepository.saveRequest(current, ctx);
			await this.authorRepository.addAuthorIfMissing(
				{ workflowReviewRequestId: request.id, userId: user.id },
				ctx,
			);
			await this.activityRepository.createActivity(
				{
					workflowReviewRequestId: request.id,
					createdById: user.id,
					type: 'review.version_updated',
					data: {
						workflowId: dto.workflowId,
						fromWorkflowVersionId: link.workflowVersionId,
						toWorkflowVersionId: dto.workflowVersionId,
					},
				},
				ctx,
			);
			return { request: saved, versionChanged: true, descriptionChanged: false };
		});

		if (outcome.versionChanged) {
			this.eventService.emit('workflow-review-version-updated', {
				user,
				workflowReviewRequestId: request.id,
				workflowId: dto.workflowId,
				workflowVersionId: dto.workflowVersionId,
			});
		}
		if (outcome.versionChanged || outcome.descriptionChanged) {
			await this.broadcast(dto.workflowId);
		}
		return toSummary(outcome.request, dto.workflowVersionId);
	}

	async decide(
		user: User,
		requestId: string,
		dto: DecideWorkflowReviewRequestDto,
	): Promise<DecideWorkflowReviewRequestResponse> {
		const request = await this.read.findRequestOrFail(requestId);
		const viewer = await this.access.getViewer(user, request);
		if (!this.access.canOpen(viewer) || viewer.linkedWorkflowIds.length === 0) {
			throw new NotFoundError('Could not find review request');
		}
		const eligibility = this.access.decisionEligibility(viewer);
		if (!eligibility.canDecide) {
			throw new ForbiddenError(
				eligibility.reason === 'author'
					? 'Authors cannot decide on their own review request'
					: 'You are not allowed to decide on this review request',
			);
		}
		if (request.state !== 'open') throw new ConflictError(NOT_OPEN);
		const note = dto.note ?? null;
		if (dto.decision === 'changes_requested' && note === null) {
			throw new BadRequestError('A note is required when requesting changes');
		}

		const links = await this.requestWorkflowRepository.findByRequestId(request.id, {});
		const [link] = links;
		const workflowVersions = links.flatMap(({ workflowId, workflowVersionId }) =>
			workflowVersionId ? [{ workflowId, workflowVersionId }] : [],
		);

		// The approval publishes as the requester, so check the requester before the approval.
		let publishBlocker: string | null = null;
		let requester: User | null = null;
		if (dto.decision === 'approved') {
			requester = request.createdById
				? await this.userRepository.findOne({
						where: { id: request.createdById },
						relations: ['role'],
					})
				: null;
			if (!requester) {
				publishBlocker = 'The review requester is no longer available';
			} else if (!(await this.access.canPublishWorkflow(requester, link.workflowId))) {
				publishBlocker = 'The review requester no longer has permission to publish this workflow';
			}
		}

		const saved = await this.withLock(async (ctx) => {
			const current = await this.findOpenRequest(request.id, ctx);
			current.decision = dto.decision;
			current.updatedById = user.id;
			if (dto.decision === 'approved') {
				for (const { workflowId } of links) {
					await this.requestWorkflowRepository.captureApprovalBaseline(
						{ workflowReviewRequestId: request.id, workflowId },
						ctx,
					);
				}
				current.state = 'closed';
				current.approvedAt = new Date();
				current.closedById = publishBlocker ? null : user.id;
			}
			const result = await this.requestRepository.saveRequest(current, ctx);
			await this.activityRepository.createActivity(
				{
					workflowReviewRequestId: request.id,
					createdById: user.id,
					type: dto.decision === 'approved' ? 'review.approved' : 'review.changes_requested',
					data: { workflowVersions, note },
				},
				ctx,
			);
			return result;
		});

		this.eventService.emit('workflow-review-decided', {
			user,
			workflowReviewRequestId: request.id,
			workflowId: link.workflowId,
			workflowVersionId: link.workflowVersionId,
			decision: dto.decision,
			decidedVia: eligibility.via,
			reviewCreatedAt: request.createdAt,
		});
		await this.broadcast(link.workflowId);

		const summary = toSummary(saved, link.workflowVersionId);
		if (dto.decision !== 'approved') return summary;
		return {
			...summary,
			autoPublish: await this.autoPublish(requester, link, publishBlocker),
		};
	}

	async comment(
		user: User,
		requestId: string,
		dto: CreateWorkflowReviewCommentDto,
	): Promise<WorkflowReviewActivityEntry> {
		const request = await this.read.findRequestOrFail(requestId);
		const viewer = await this.access.getViewer(user, request);
		if (!this.access.canOpen(viewer)) throw new NotFoundError('Could not find review request');
		if (!this.access.canComment(viewer)) {
			throw new ForbiddenError('You are not allowed to comment on this review');
		}
		if (request.state !== 'open') throw new ConflictError(NOT_OPEN);

		const { activity, comment } = await this.withLock(async (ctx) => {
			await this.findOpenRequest(request.id, ctx);
			const created = await this.activityRepository.createActivity(
				{
					workflowReviewRequestId: request.id,
					createdById: user.id,
					type: 'comment.created',
					data: null,
				},
				ctx,
			);
			const message = await this.commentRepository.createComment(
				{ activityId: created.id, createdById: user.id, body: dto.body },
				ctx,
			);
			return { activity: created, comment: message };
		});

		this.eventService.emit('workflow-review-comment-created', {
			user,
			workflowReviewRequestId: request.id,
		});
		return toActivityEntry(activity, [comment], new Map([[user.id, user]]));
	}

	/** The review changes run one at a time, in a transaction. */
	private async withLock<T>(fn: (ctx: OperationContext) => Promise<T>) {
		return await this.dbLockService.withLockContext(DbLock.WORKFLOW_REVIEW_MUTATION, fn);
	}

	/** The request again, under the lock: another change can have closed it meanwhile. */
	private async findOpenRequest(
		requestId: string,
		ctx: OperationContext,
	): Promise<WorkflowReviewRequest> {
		const current = await this.requestRepository.findById(requestId, ctx);
		if (!current) throw new NotFoundError('Could not find review request');
		if (current.state !== 'open') throw new ConflictError(NOT_OPEN);
		return current;
	}

	private async assertVersionExists(workflowId: string, versionId: string) {
		const version = await this.workflowHistoryRepository.findOne({
			select: { versionId: true },
			where: { workflowId, versionId },
		});
		if (!version) {
			throw new BadRequestError(
				`Version '${versionId}' does not exist for workflow '${workflowId}'`,
			);
		}
	}

	/** Publish the approved version as the requester. A failure leaves the approval as it is. */
	private async autoPublish(
		requester: User | null,
		link: { workflowId: string; workflowVersionId: string | null },
		publishBlocker: string | null,
	): Promise<WorkflowReviewAutoPublishOutcome> {
		if (publishBlocker !== null || requester === null) {
			return {
				status: 'failed',
				message: publishBlocker ?? 'The review requester is no longer available',
			};
		}
		if (!link.workflowVersionId) {
			return { status: 'failed', message: 'The reviewed version no longer exists' };
		}
		try {
			await this.workflowService.activateWorkflow(requester, link.workflowId, {
				versionId: link.workflowVersionId,
				source: 'review-approval',
			});
			return { status: 'published' };
		} catch (error) {
			return { status: 'failed', message: ensureError(error).message };
		}
	}

	private async broadcast(workflowId: string) {
		try {
			await this.collaborationService.broadcastWorkflowReviewStateChanged(workflowId);
		} catch (error) {
			this.logger.warn('Failed to send the review state of a workflow', { workflowId, error });
		}
	}
}
