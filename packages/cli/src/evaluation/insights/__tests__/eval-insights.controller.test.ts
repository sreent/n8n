// Fork test (not in upstream n8n): the insights of an evaluation collection need the licence of
// the AI assistant only while the fork switch is off, because the fork insights ask no language
// model. See `../../FORK.md`.
import { EVAL_COLLECTIONS_FLAG } from '@n8n/api-types';
import type { GenerateInsightsDto } from '@n8n/api-types';
import type { LicenseState } from '@n8n/backend-common';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { ForbiddenError } from '@n8n/errors';
import type { Response } from 'express';
import { mock } from 'vitest-mock-extended';

import type { ForkFeaturesConfig } from '@/fork-features';
import type { PostHogClient } from '@/posthog';

import { EvalInsightsController } from '../eval-insights.controller';
import type { EvalInsightsService } from '../eval-insights.service';

describe('EvalInsightsController', () => {
	const evalInsightsService = mock<EvalInsightsService>();
	const postHogClient = mock<PostHogClient>();
	const licenseState = mock<LicenseState>();
	const user = mock<User>();
	const req = mock<AuthenticatedRequest<{ workflowId: string; collectionId: string }>>({
		user,
		params: { workflowId: 'workflow-1', collectionId: 'collection-1' },
	});
	const insights = {} as Awaited<ReturnType<EvalInsightsService['generateInsights']>>;

	const generate = async (forkFeaturesEnabled: boolean) =>
		await new EvalInsightsController(
			evalInsightsService,
			postHogClient,
			licenseState,
			mock<ForkFeaturesConfig>({ enabled: forkFeaturesEnabled }),
		).generate(req, mock<Response>(), mock<GenerateInsightsDto>());

	beforeEach(() => {
		vi.clearAllMocks();
		postHogClient.getFeatureFlags.mockResolvedValue({ [EVAL_COLLECTIONS_FLAG]: true });
		licenseState.isAiAssistantLicensed.mockReturnValue(false);
		evalInsightsService.generateInsights.mockResolvedValue(insights);
	});

	it('gives the insights without the licence of the AI assistant while the fork switch is on', async () => {
		await expect(generate(true)).resolves.toBe(insights);
		expect(evalInsightsService.generateInsights).toHaveBeenCalledWith(
			'workflow-1',
			'collection-1',
			user,
		);
	});

	it('needs the licence of the AI assistant while the fork switch is off, as upstream n8n', async () => {
		await expect(generate(false)).rejects.toThrow(ForbiddenError);
		expect(evalInsightsService.generateInsights).not.toHaveBeenCalled();
	});

	it('gives the insights with the licence of the AI assistant while the fork switch is off', async () => {
		licenseState.isAiAssistantLicensed.mockReturnValue(true);

		await expect(generate(false)).resolves.toBe(insights);
	});
});
