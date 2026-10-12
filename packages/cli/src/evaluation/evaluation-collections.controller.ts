import {
	AddRunToCollectionDto,
	CreateEvaluationCollectionDto,
	EVAL_COLLECTIONS_FLAG,
	UpdateEvaluationCollectionDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { Body, Delete, Get, Patch, Post, ProjectScope, RestController } from '@n8n/decorators';
import { BadRequestError, NotFoundError } from '@n8n/errors';
import type { Response } from 'express';

import { PostHogClient } from '@/posthog';

import { EvaluationCollectionService } from './evaluation-collection.service';

type WorkflowParams = { workflowId: string };
type CollectionParams = WorkflowParams & { collectionId: string };

/**
 * Fork code (not in upstream n8n): the REST API of evaluation collections
 * (`/rest/workflows/:workflowId/eval-collections`) and of the versions that they compare. The
 * PostHog flag `084_eval_collections` (or `N8N_EVAL_COLLECTIONS_ENABLED`) turns it on for a user.
 * It replaces the enterprise controller of the same name. See `FORK.md` in this folder.
 */
@RestController('/workflows')
export class EvaluationCollectionsController {
	constructor(
		private readonly evaluationCollectionService: EvaluationCollectionService,
		private readonly postHogClient: PostHogClient,
	) {}

	@Get('/:workflowId/eval-collections')
	@ProjectScope('workflow:read')
	async list(req: AuthenticatedRequest<WorkflowParams>) {
		await this.assertFlagEnabled(req.user);
		return await this.evaluationCollectionService.listCollections(req.params.workflowId);
	}

	@Get('/:workflowId/eval-collections/:collectionId')
	@ProjectScope('workflow:read')
	async get(req: AuthenticatedRequest<CollectionParams>) {
		await this.assertFlagEnabled(req.user);
		const { workflowId, collectionId } = req.params;
		return await this.evaluationCollectionService.getCollectionDetail(workflowId, collectionId);
	}

	@Post('/:workflowId/eval-collections')
	@ProjectScope('workflow:execute')
	async create(
		req: AuthenticatedRequest<WorkflowParams>,
		_res: Response,
		@Body payload: CreateEvaluationCollectionDto,
	) {
		await this.assertFlagEnabled(req.user);
		return await this.evaluationCollectionService.createCollection(
			req.params.workflowId,
			req.user,
			payload,
		);
	}

	@Post('/:workflowId/eval-collections/:collectionId/rerun')
	@ProjectScope('workflow:execute')
	async rerun(req: AuthenticatedRequest<CollectionParams>) {
		await this.assertFlagEnabled(req.user);
		const { workflowId, collectionId } = req.params;
		return await this.evaluationCollectionService.rerunCollection(
			workflowId,
			collectionId,
			req.user,
		);
	}

	@Patch('/:workflowId/eval-collections/:collectionId')
	@ProjectScope('workflow:update')
	async update(
		req: AuthenticatedRequest<CollectionParams>,
		_res: Response,
		@Body payload: UpdateEvaluationCollectionDto,
	) {
		await this.assertFlagEnabled(req.user);
		const { workflowId, collectionId } = req.params;
		return await this.evaluationCollectionService.updateCollectionMeta(
			workflowId,
			collectionId,
			payload,
		);
	}

	@Delete('/:workflowId/eval-collections/:collectionId')
	@ProjectScope('workflow:update')
	async delete(req: AuthenticatedRequest<CollectionParams>) {
		await this.assertFlagEnabled(req.user);
		const { workflowId, collectionId } = req.params;
		return await this.evaluationCollectionService.deleteCollection(
			workflowId,
			collectionId,
			req.user,
		);
	}

	@Post('/:workflowId/eval-collections/:collectionId/runs')
	@ProjectScope('workflow:update')
	async addRun(
		req: AuthenticatedRequest<CollectionParams>,
		_res: Response,
		@Body payload: AddRunToCollectionDto,
	) {
		await this.assertFlagEnabled(req.user);
		const { workflowId, collectionId } = req.params;
		return await this.evaluationCollectionService.addRunToCollection(
			workflowId,
			collectionId,
			payload.testRunId,
		);
	}

	@Delete('/:workflowId/eval-collections/:collectionId/runs/:runId')
	@ProjectScope('workflow:update')
	async removeRun(req: AuthenticatedRequest<CollectionParams & { runId: string }>) {
		await this.assertFlagEnabled(req.user);
		const { workflowId, collectionId, runId } = req.params;
		return await this.evaluationCollectionService.removeRunFromCollection(
			workflowId,
			collectionId,
			runId,
		);
	}

	/** The versions of the workflow that a collection of a config can compare. */
	@Get('/:workflowId/eval-versions')
	@ProjectScope('workflow:read')
	async listVersions(
		req: AuthenticatedRequest<WorkflowParams, {}, {}, { evaluationConfigId?: string }>,
	) {
		await this.assertFlagEnabled(req.user);
		const { evaluationConfigId } = req.query;
		if (typeof evaluationConfigId !== 'string' || evaluationConfigId.length === 0) {
			throw new BadRequestError('Missing required query parameter: evaluationConfigId');
		}
		return await this.evaluationCollectionService.getEvalVersions(
			req.params.workflowId,
			evaluationConfigId,
		);
	}

	/** A flag-off surface looks unknown, not forbidden. */
	async assertFlagEnabled(user: User) {
		const flags = await this.postHogClient.getFeatureFlags(user);
		if (flags?.[EVAL_COLLECTIONS_FLAG] !== true) throw new NotFoundError('Not found');
	}
}
