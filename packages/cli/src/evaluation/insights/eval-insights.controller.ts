import { EVAL_COLLECTIONS_FLAG, GenerateInsightsDto } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { Body, Post, ProjectScope, RestController } from '@n8n/decorators';
import { ForbiddenError, NotFoundError } from '@n8n/errors';
import type { Response } from 'express';

import { ForkFeaturesConfig } from '@/fork-features';
import { PostHogClient } from '@/posthog';

import { EvalInsightsService } from './eval-insights.service';

type CollectionParams = { workflowId: string; collectionId: string };

/**
 * Fork code (not in upstream n8n): the insights of an evaluation collection
 * (`POST /rest/workflows/:workflowId/eval-collections/:collectionId/insights`). It needs the
 * PostHog flag of collections. It replaces the enterprise controller of the same name, which also
 * needs the licence feature `feat:aiAssistant`. The fork insights ask no language model, so the
 * route needs that feature only while the fork switch is off. See `../FORK.md`.
 */
@RestController('/workflows')
export class EvalInsightsController {
	constructor(
		private readonly evalInsightsService: EvalInsightsService,
		private readonly postHogClient: PostHogClient,
		private readonly licenseState: LicenseState,
		private readonly forkFeatures: ForkFeaturesConfig,
	) {}

	@Post('/:workflowId/eval-collections/:collectionId/insights')
	@ProjectScope('workflow:read')
	async generate(
		req: AuthenticatedRequest<CollectionParams>,
		_res: Response,
		@Body _payload: GenerateInsightsDto,
	) {
		await this.assertFlagEnabled(req.user);
		if (!this.forkFeatures.enabled && !this.licenseState.isAiAssistantLicensed()) {
			throw new ForbiddenError('AI Assistant license required for eval-collection insights');
		}
		const { workflowId, collectionId } = req.params;
		return await this.evalInsightsService.generateInsights(workflowId, collectionId, req.user);
	}

	async assertFlagEnabled(user: User) {
		const flags = await this.postHogClient.getFeatureFlags(user);
		if (flags?.[EVAL_COLLECTIONS_FLAG] !== true) throw new NotFoundError('Not found');
	}
}
