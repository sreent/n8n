import type { ChatTriggerConfig } from '@n8n/config';
import type { ProjectRelationRepository, User, WorkflowEntity } from '@n8n/db';
import { Container } from '@n8n/di';
import { WEBHOOK_NODE_TYPE, type INode } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import type { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import type { OpenTriggerRepository } from '../database/open-trigger.repository';
import { OpenTriggersConfig } from '../open-triggers.config';
import { OpenTriggersService } from '../open-triggers.service';

const webhook = (id: string, name: string, authentication?: string): INode => ({
	id,
	name,
	type: WEBHOOK_NODE_TYPE,
	typeVersion: 2,
	position: [0, 0],
	parameters: { path: name.toLowerCase(), ...(authentication && { authentication }) },
});

const published = (
	id: string,
	name: string,
	nodes: INode[],
	home: { id: string; name: string; type: string },
) =>
	({
		id,
		name,
		activeVersion: { nodes },
		shared: [{ role: 'workflow:owner', project: home }],
	}) as unknown as WorkflowEntity;

describe('OpenTriggersService', () => {
	const repository = mock<OpenTriggerRepository>();
	const workflowFinderService = mock<WorkflowFinderService>();
	const projectRelationRepository = mock<ProjectRelationRepository>();
	const service = new OpenTriggersService(
		repository,
		mock<ChatTriggerConfig>({ disablePublicChat: false }),
		workflowFinderService,
		projectRelationRepository,
	);
	const user = mock<User>({ id: 'u1' });

	beforeEach(() => {
		vi.resetAllMocks();
		repository.findApprovedVersionNodes.mockResolvedValue([]);
	});

	describe('allowedTriggerKeys', () => {
		it('should give the open triggers of the published version and of the approved versions', async () => {
			repository.findPublishedVersionNodes.mockResolvedValue([
				webhook('n1', 'Orders'),
				webhook('n2', 'Refunds', 'headerAuth'),
			]);
			repository.findApprovedVersionNodes.mockResolvedValue([
				{ workflowId: 'wf-1', versionId: 'v2', nodes: [webhook('n3', 'Returns')] },
			]);

			const keys = await service.allowedTriggerKeys('wf-1');

			expect([...keys]).toEqual([`n1:${WEBHOOK_NODE_TYPE}`, `n3:${WEBHOOK_NODE_TYPE}`]);
		});

		it('should give no keys for a workflow that nobody published or approved', async () => {
			repository.findPublishedVersionNodes.mockResolvedValue(null);

			expect((await service.allowedTriggerKeys('wf-1')).size).toBe(0);
		});
	});

	describe('listPublished', () => {
		it('should list the open triggers of the published versions, sorted, with the approvals', async () => {
			workflowFinderService.findWorkflowsForUser.mockResolvedValue({
				workflows: [
					published('wf-2', 'Shop', [webhook('n2', 'Refunds'), webhook('n1', 'Orders')], {
						id: 'p-team',
						name: 'Sales',
						type: 'team',
					}),
					published('wf-1', 'Leads', [webhook('n3', 'Leads', 'basicAuth')], {
						id: 'p-team',
						name: 'Sales',
						type: 'team',
					}),
					published('wf-3', 'Alerts', [webhook('n4', 'Alert')], {
						id: 'p-personal',
						name: 'Ann <ann@example.com>',
						type: 'personal',
					}),
				],
				count: 3,
			});
			repository.findApprovedVersionNodes.mockResolvedValue([
				{ workflowId: 'wf-2', versionId: 'v1', nodes: [webhook('n1', 'Orders')] },
			]);
			projectRelationRepository.getPersonalProjectOwners.mockResolvedValue([
				mock({
					projectId: 'p-personal',
					user: { id: 'u2', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' },
				}),
			]);

			const items = await service.listPublished(user, { projectId: 'p-team' });

			expect(workflowFinderService.findWorkflowsForUser).toHaveBeenCalledWith(
				user,
				['workflow:read'],
				{
					filters: { active: true, projectId: 'p-team' },
					includeProjects: true,
					includeActiveVersion: true,
				},
			);
			expect(repository.findApprovedVersionNodes).toHaveBeenCalledWith(['wf-2', 'wf-3']);
			expect(projectRelationRepository.getPersonalProjectOwners).toHaveBeenCalledWith([
				'p-personal',
			]);
			expect(
				items.map(({ workflowName, nodeName, approved, owner, homeProject }) => ({
					workflowName,
					nodeName,
					approved,
					owner: owner?.email ?? null,
					project: homeProject?.name,
				})),
			).toEqual([
				{
					workflowName: 'Alerts',
					nodeName: 'Alert',
					approved: false,
					owner: 'ann@example.com',
					project: 'Ann <ann@example.com>',
				},
				{ workflowName: 'Shop', nodeName: 'Orders', approved: true, owner: null, project: 'Sales' },
				{
					workflowName: 'Shop',
					nodeName: 'Refunds',
					approved: false,
					owner: null,
					project: 'Sales',
				},
			]);
			expect(items[1]).toMatchObject({
				workflowId: 'wf-2',
				nodeId: 'n1',
				nodeType: WEBHOOK_NODE_TYPE,
				typeVersion: 2,
				kind: 'webhook',
				path: 'orders',
			});
		});

		it('should not read the approvals when no workflow has an open trigger', async () => {
			workflowFinderService.findWorkflowsForUser.mockResolvedValue({
				workflows: [
					published('wf-1', 'Leads', [webhook('n3', 'Leads', 'basicAuth')], {
						id: 'p-team',
						name: 'Sales',
						type: 'team',
					}),
				],
				count: 1,
			});

			expect(await service.listPublished(user)).toEqual([]);
			expect(repository.findApprovedVersionNodes).not.toHaveBeenCalled();
		});
	});
});

describe('OpenTriggersConfig', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		Container.reset();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('should default to no approval', () => {
		process.env = {};

		expect(Container.get(OpenTriggersConfig).needApproval).toBe(false);
	});

	it('should read N8N_OPEN_TRIGGERS_NEED_APPROVAL', () => {
		process.env = { N8N_OPEN_TRIGGERS_NEED_APPROVAL: 'true' };

		expect(Container.get(OpenTriggersConfig).needApproval).toBe(true);
	});
});
