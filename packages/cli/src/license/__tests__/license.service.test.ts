import type { LicenseState } from '@n8n/backend-common';
import type { WorkflowRepository } from '@n8n/db';
import type { TEntitlement } from '@n8n_io/license-sdk';
import { mock } from 'vitest-mock-extended';

import type { License } from '@/license';
import { LicenseService } from '@/license/license.service';

describe('LicenseService', () => {
	const license = mock<License>();
	const licenseState = mock<LicenseState>();
	const workflowRepository = mock<WorkflowRepository>();
	const entitlement = mock<TEntitlement>({ productId: '123' });
	// Fork: the service only reads the licence data (packages/cli/src/license/FORK.md).
	const licenseService = new LicenseService(license, licenseState, workflowRepository);

	license.getMainPlan.mockReturnValue(entitlement);
	license.getTriggerLimit.mockReturnValue(400);
	license.getPlanName.mockReturnValue('Test Plan');
	licenseState.getMaxWorkflowsWithEvaluations.mockReturnValue(2);
	workflowRepository.getActiveTriggerCount.mockResolvedValue(7);
	workflowRepository.getWorkflowsWithEvaluationCount.mockResolvedValue(1);

	beforeEach(() => vi.clearAllMocks());

	describe('getLicenseData', () => {
		it('should return usage and license data', async () => {
			const data = await licenseService.getLicenseData();
			expect(data).toEqual({
				usage: {
					activeWorkflowTriggers: {
						limit: 400,
						value: 7,
						warningThreshold: 0.8,
					},
					workflowsHavingEvaluations: {
						limit: 2,
						value: 1,
					},
				},
				license: {
					planId: '123',
					planName: 'Test Plan',
				},
			});
		});
	});
});
