import type { ChatTriggerConfig } from '@n8n/config';
import type { PolicedWorkflow } from '@n8n/decorators';
import { WEBHOOK_NODE_TYPE, type INode } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import type { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';

import type { OpenTriggerRepository } from '../database/open-trigger.repository';
import { OpenTriggerCheck } from '../open-trigger.check';
import type { OpenTriggersConfig } from '../open-triggers.config';
import { OpenTriggersService } from '../open-triggers.service';

const webhook = (id: string, name: string, authentication?: string): INode => ({
	id,
	name,
	type: WEBHOOK_NODE_TYPE,
	typeVersion: 2,
	position: [0, 0],
	parameters: authentication ? { authentication } : {},
});

const workflow = (nodes: INode[], id: string | null = 'wf-1'): PolicedWorkflow => ({
	id,
	name: 'Orders',
	nodes,
});

describe('OpenTriggerCheck', () => {
	const repository = mock<OpenTriggerRepository>();
	const reviewPolicyService = mock<WorkflowReviewPolicyService>();
	const config = { needApproval: true } as OpenTriggersConfig;
	const service = new OpenTriggersService(
		repository,
		mock<ChatTriggerConfig>({ disablePublicChat: false }),
		mock(),
		mock(),
	);
	const check = new OpenTriggerCheck(config, service, reviewPolicyService);

	beforeEach(() => {
		vi.resetAllMocks();
		config.needApproval = true;
		repository.findPublishedVersionNodes.mockResolvedValue(null);
		repository.findApprovedVersionNodes.mockResolvedValue([]);
		reviewPolicyService.get.mockResolvedValue({ enabled: true });
	});

	it('should do nothing while N8N_OPEN_TRIGGERS_NEED_APPROVAL is false', async () => {
		config.needApproval = false;

		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders')]),
			projectId: 'p1',
		});

		expect(result.violations).toEqual([]);
		expect(repository.findPublishedVersionNodes).not.toHaveBeenCalled();
	});

	it('should not read the database for a workflow without open triggers', async () => {
		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders', 'headerAuth')]),
			projectId: 'p1',
		});

		expect(result.violations).toEqual([]);
		expect(repository.findPublishedVersionNodes).not.toHaveBeenCalled();
	});

	it('should report a new open trigger with a hint to the workflow reviews', async () => {
		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders'), webhook('n2', 'Refunds', 'basicAuth')]),
			projectId: 'p1',
		});

		expect(result.violations).toEqual([
			{
				kind: 'open-trigger',
				checkId: 'open-triggers',
				message:
					'The webhook "Orders" accepts calls without authentication. Add authentication, or get an approval in a workflow review.',
				subject: 'n1',
				subjectType: 'node',
			},
		]);
		expect(repository.findPublishedVersionNodes).toHaveBeenCalledWith('wf-1');
		expect(repository.findApprovedVersionNodes).toHaveBeenCalledWith(['wf-1']);
	});

	it('should not give the hint to the workflow reviews while they are off', async () => {
		reviewPolicyService.get.mockResolvedValue({ enabled: false });

		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders')]),
			projectId: 'p1',
		});

		expect(result.violations[0].message).toBe(
			'The webhook "Orders" accepts calls without authentication. Add authentication.',
		);
	});

	it('should allow an open trigger of the published version', async () => {
		repository.findPublishedVersionNodes.mockResolvedValue([webhook('n1', 'Old name')]);

		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders')]),
			projectId: 'p1',
		});

		expect(result.violations).toEqual([]);
	});

	it('should allow an open trigger that an approved review covers', async () => {
		repository.findApprovedVersionNodes.mockResolvedValue([
			{ workflowId: 'wf-1', versionId: 'v1', nodes: [webhook('n1', 'Orders')] },
		]);

		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders'), webhook('n2', 'Refunds')]),
			projectId: 'p1',
		});

		expect(result.violations.map((violation) => violation.subject)).toEqual(['n2']);
	});

	it('should not take an approval of a node that had authentication then', async () => {
		repository.findApprovedVersionNodes.mockResolvedValue([
			{ workflowId: 'wf-1', versionId: 'v1', nodes: [webhook('n1', 'Orders', 'headerAuth')] },
		]);

		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders')]),
			projectId: 'p1',
		});

		expect(result.violations.map((violation) => violation.subject)).toEqual(['n1']);
	});

	it('should report each open trigger of a workflow that has no id', async () => {
		const result = await check.onWorkflowPublish({
			workflow: workflow([webhook('n1', 'Orders')], null),
			projectId: null,
		});

		expect(result.violations).toHaveLength(1);
		expect(repository.findPublishedVersionNodes).not.toHaveBeenCalled();
	});
});
