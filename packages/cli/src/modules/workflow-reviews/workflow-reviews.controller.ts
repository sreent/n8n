import {
	CreateWorkflowReviewCommentDto,
	CreateWorkflowReviewRequestDto,
	DecideWorkflowReviewRequestDto,
	GetWorkflowReviewEligibleReviewersQueryDto,
	ListWorkflowReviewActivityQueryDto,
	ListWorkflowReviewRequestsQueryDto,
	UpdateWorkflowReviewRequestVersionDto,
} from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, Licensed, Param, Post, Query, RestController } from '@n8n/decorators';
import { Response } from 'express';

import { WorkflowReviewReadService } from './workflow-review-read.service';
import { WorkflowReviewService } from './workflow-review.service';

/**
 * Fork code (not in upstream n8n): the REST API of the workflow reviews
 * (`/rest/workflow-review-requests`). Each route needs the licence value and the policy of the
 * instance. The routes with a fixed path come before `/:id`. See `README.md`.
 */
@RestController('/workflow-review-requests')
export class WorkflowReviewsController {
	constructor(
		private readonly reviews: WorkflowReviewService,
		private readonly reads: WorkflowReviewReadService,
	) {}

	@Get('/')
	@Licensed('feat:workflowReviews')
	async list(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: ListWorkflowReviewRequestsQueryDto,
	) {
		await this.reviews.assertEnabled();
		return await this.reads.listForWorkflow(req.user, query);
	}

	@Get('/eligible-reviewers')
	@Licensed('feat:workflowReviews')
	async eligibleReviewers(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: GetWorkflowReviewEligibleReviewersQueryDto,
	) {
		await this.reviews.assertEnabled();
		return await this.reads.getEligibleReviewers(req.user, query.workflowId);
	}

	@Post('/')
	@Licensed('feat:workflowReviews')
	async create(
		req: AuthenticatedRequest,
		res: Response,
		@Body payload: CreateWorkflowReviewRequestDto,
	) {
		await this.reviews.assertEnabled();
		const summary = await this.reviews.create(req.user, payload);
		res.status(201);
		return summary;
	}

	@Get('/:id')
	@Licensed('feat:workflowReviews')
	async detail(req: AuthenticatedRequest, _res: Response, @Param('id') id: string) {
		await this.reviews.assertEnabled();
		return await this.reads.getDetail(req.user, id);
	}

	@Get('/:id/activity')
	@Licensed('feat:workflowReviews')
	async activity(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Query query: ListWorkflowReviewActivityQueryDto,
	) {
		await this.reviews.assertEnabled();
		return await this.reads.getActivity(req.user, id, query);
	}

	@Post('/:id/update-version')
	@Licensed('feat:workflowReviews')
	async updateVersion(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body payload: UpdateWorkflowReviewRequestVersionDto,
	) {
		await this.reviews.assertEnabled();
		return await this.reviews.updateVersion(req.user, id, payload);
	}

	@Post('/:id/decision')
	@Licensed('feat:workflowReviews')
	async decide(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body payload: DecideWorkflowReviewRequestDto,
	) {
		await this.reviews.assertEnabled();
		return await this.reviews.decide(req.user, id, payload);
	}

	@Post('/:id/comments')
	@Licensed('feat:workflowReviews')
	async comment(
		req: AuthenticatedRequest,
		res: Response,
		@Param('id') id: string,
		@Body payload: CreateWorkflowReviewCommentDto,
	) {
		await this.reviews.assertEnabled();
		const entry = await this.reviews.comment(req.user, id, payload);
		res.status(201);
		return entry;
	}
}
