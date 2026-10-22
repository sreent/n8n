import type { Logger } from '@n8n/backend-common';
import type { InstanceSettingsLoaderConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import { mock } from 'vitest-mock-extended';

import type { InstanceRedactionEnforcementService } from '@/modules/redaction/instance-redaction-enforcement.service';
import type { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';

import {
	ForkSecurityPolicyConfig,
	ForkSecurityPolicyInstanceSettingsLoader,
} from '../loaders/fork-security-policy.instance-settings-loader';

describe('ForkSecurityPolicyInstanceSettingsLoader', () => {
	const logger = mock<Logger>({ scoped: vi.fn().mockReturnThis() });
	const workflowReviewPolicyService = mock<WorkflowReviewPolicyService>();
	const instanceRedactionEnforcementService = mock<InstanceRedactionEnforcementService>();

	const createLoader = (
		securityPolicyManagedByEnv: boolean,
		forkConfig: Partial<ForkSecurityPolicyConfig> = {},
	) =>
		new ForkSecurityPolicyInstanceSettingsLoader(
			{ securityPolicyManagedByEnv } as InstanceSettingsLoaderConfig,
			{
				workflowReviewsEnabled: false,
				redactionEnforcementFloor: 'off',
				...forkConfig,
			} as ForkSecurityPolicyConfig,
			workflowReviewPolicyService,
			instanceRedactionEnforcementService,
			logger,
		);

	beforeEach(() => {
		vi.resetAllMocks();
		logger.scoped.mockReturnThis();
	});

	it('should skip when the security policy is not managed by the environment', async () => {
		const loader = createLoader(false, {
			workflowReviewsEnabled: true,
			redactionEnforcementFloor: 'all',
		});

		const result = await loader.run();

		expect(result).toBe('skipped');
		expect(workflowReviewPolicyService.set).not.toHaveBeenCalled();
		expect(instanceRedactionEnforcementService.set).not.toHaveBeenCalled();
	});

	it('should set workflow reviews and the redaction floor from the environment', async () => {
		const loader = createLoader(true, {
			workflowReviewsEnabled: true,
			redactionEnforcementFloor: 'production',
		});

		const result = await loader.run();

		expect(result).toBe('created');
		expect(workflowReviewPolicyService.set).toHaveBeenCalledWith(true);
		expect(instanceRedactionEnforcementService.set).toHaveBeenCalledWith('production');
	});

	it('should turn workflow reviews off and the floor to off with the default values', async () => {
		const loader = createLoader(true);

		await loader.run();

		expect(workflowReviewPolicyService.set).toHaveBeenCalledWith(false);
		expect(instanceRedactionEnforcementService.set).toHaveBeenCalledWith('off');
	});
});

describe('ForkSecurityPolicyConfig', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		Container.reset();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('should default to workflow reviews off and the floor off', () => {
		process.env = {};

		const config = Container.get(ForkSecurityPolicyConfig);

		expect(config.workflowReviewsEnabled).toBe(false);
		expect(config.redactionEnforcementFloor).toBe('off');
	});

	it('should read N8N_WORKFLOW_REVIEWS_ENABLED and N8N_REDACTION_ENFORCEMENT_FLOOR', () => {
		process.env = {
			N8N_WORKFLOW_REVIEWS_ENABLED: 'true',
			N8N_REDACTION_ENFORCEMENT_FLOOR: 'all',
		};

		const config = Container.get(ForkSecurityPolicyConfig);

		expect(config.workflowReviewsEnabled).toBe(true);
		expect(config.redactionEnforcementFloor).toBe('all');
	});

	it('should keep the floor off when N8N_REDACTION_ENFORCEMENT_FLOOR is not a floor', () => {
		process.env = { N8N_REDACTION_ENFORCEMENT_FLOOR: 'everything' };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const config = Container.get(ForkSecurityPolicyConfig);

		expect(config.redactionEnforcementFloor).toBe('off');
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Invalid value for N8N_REDACTION_ENFORCEMENT_FLOOR'),
		);
		warn.mockRestore();
	});
});
