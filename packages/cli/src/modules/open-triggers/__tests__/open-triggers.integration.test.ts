import {
	createTeamProject,
	createWorkflowHistory,
	createWorkflowWithHistory,
	mockInstance,
	setActiveVersion,
	testDb,
} from '@n8n/backend-test-utils';
import { WorkflowsConfig } from '@n8n/config';
import { WorkflowRepository, type Project, type User } from '@n8n/db';
import { Container } from '@n8n/di';
import type { INode } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';
import { saveCredential } from '@test-integration/db/credentials';
import { createAdmin, createMember, createOwner } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';
import { loadNodesFromDist } from '@test-integration/utils/node-types-data';

import { OpenTriggersConfig } from '../open-triggers.config';

/**
 * Fork test (not in upstream n8n): the publish check of open triggers through the real activate
 * route and the real workflow reviews, and the list of open triggers. See `../README.md`.
 */

// Activation stops before the registration of the webhooks: the check runs in the service.
mockInstance(ActiveWorkflowManager);

const testServer = utils.setupTestServer({
	endpointGroups: ['workflows'],
	enabledFeatures: ['feat:sharing', 'feat:workflowReviews'],
	quotas: { 'quota:maxTeamProjects': -1 },
	modules: ['policy-infrastructure', 'workflow-reviews', 'open-triggers'],
});

const config = Container.get(OpenTriggersConfig);
const workflowsConfig = Container.get(WorkflowsConfig);
const originalUseWorkflowPublicationService = workflowsConfig.useWorkflowPublicationService;

let owner: User;
let admin: User;
let member: User;
let ownerAgent: SuperAgentTest;
let adminAgent: SuperAgentTest;
let memberAgent: SuperAgentTest;
let team: Project;
let headerCredentialId: string;

const webhook = (name: string, extra: Partial<INode> = {}): INode => ({
	id: uuid(),
	name,
	type: 'n8n-nodes-base.webhook',
	typeVersion: 2,
	position: [0, 0],
	webhookId: uuid(),
	parameters: { path: `${name.toLowerCase().replace(/\s/g, '-')}-${uuid()}`, httpMethod: 'POST' },
	...extra,
});

const withHeaderAuth = (node: INode): INode => ({
	...node,
	parameters: { ...node.parameters, authentication: 'headerAuth' },
	credentials: { httpHeaderAuth: { id: headerCredentialId, name: 'Webhook token' } },
});

const activate = (workflowId: string, versionId: string) =>
	ownerAgent.post(`/workflows/${workflowId}/activate`).send({ versionId });

const activeVersionOf = async (workflowId: string) =>
	(await Container.get(WorkflowRepository).findOneBy({ id: workflowId }))?.activeVersionId;

beforeAll(async () => {
	await utils.initNodeTypes(loadNodesFromDist(['n8n-nodes-base.webhook']));

	owner = await createOwner();
	admin = await createAdmin();
	member = await createMember();
	ownerAgent = testServer.authAgentFor(owner);
	adminAgent = testServer.authAgentFor(admin);
	memberAgent = testServer.authAgentFor(member);
	team = await createTeamProject('Sales', owner);

	const credential = await saveCredential(
		{ name: 'Webhook token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'x' } },
		{ project: team, role: 'credential:owner' },
	);
	headerCredentialId = credential.id;

	await Container.get(WorkflowReviewPolicyService).set(true);
	workflowsConfig.useWorkflowPublicationService = false;
});

afterAll(() => {
	workflowsConfig.useWorkflowPublicationService = originalUseWorkflowPublicationService;
});

beforeEach(() => {
	config.needApproval = true;
});

afterEach(async () => {
	await testDb.truncate([
		'WorkflowReviewRequestWorkflow',
		'WorkflowReviewRequest',
		'WorkflowEntity',
		'SharedWorkflow',
		'WorkflowHistory',
		'WorkflowPublishHistory',
	]);
});

describe('the publish check', () => {
	test('should stop the publish of a webhook without authentication', async () => {
		const orders = webhook('Orders');
		const workflow = await createWorkflowWithHistory({ nodes: [orders] }, team);

		const response = await activate(workflow.id, workflow.versionId).expect(403);

		expect(response.body).toMatchObject({
			message:
				'The webhook "Orders" accepts calls without authentication. Add authentication, or get an approval in a workflow review.',
			meta: {
				violations: [
					{
						kind: 'open-trigger',
						checkId: 'open-triggers',
						subject: orders.id,
						subjectType: 'node',
					},
				],
			},
		});
		expect(await activeVersionOf(workflow.id)).toBeNull();
	});

	test('should publish a webhook with header authentication', async () => {
		const workflow = await createWorkflowWithHistory(
			{ nodes: [withHeaderAuth(webhook('Orders'))] },
			team,
		);

		await activate(workflow.id, workflow.versionId).expect(200);

		expect(await activeVersionOf(workflow.id)).toBe(workflow.versionId);
	});

	test('should publish every webhook while N8N_OPEN_TRIGGERS_NEED_APPROVAL is false', async () => {
		config.needApproval = false;
		const workflow = await createWorkflowWithHistory({ nodes: [webhook('Orders')] }, team);

		await activate(workflow.id, workflow.versionId).expect(200);
	});

	test('should keep a published open trigger, and stop a new one', async () => {
		const orders = webhook('Orders');
		const workflow = await createWorkflowWithHistory({ nodes: [orders] }, team);
		// Published before the check was on.
		await setActiveVersion(workflow.id, workflow.versionId);

		// A new version that keeps the trigger publishes.
		const renamedVersionId = uuid();
		await createWorkflowHistory(workflow, owner, undefined, {
			versionId: renamedVersionId,
			nodes: [{ ...orders, name: 'Orders v2' }],
		});
		await activate(workflow.id, renamedVersionId).expect(200);

		// A new version with a second open trigger stops, for the second trigger only.
		const refunds = webhook('Refunds');
		const extendedVersionId = uuid();
		await createWorkflowHistory(workflow, owner, undefined, {
			versionId: extendedVersionId,
			nodes: [orders, refunds],
		});
		const response = await activate(workflow.id, extendedVersionId).expect(403);

		expect(
			response.body.meta.violations.map((violation: { subject: string }) => violation.subject),
		).toEqual([refunds.id]);
		expect(await activeVersionOf(workflow.id)).toBe(renamedVersionId);
	});

	test('should publish an open trigger when a workflow review approves it', async () => {
		const orders = webhook('Orders');
		const workflow = await createWorkflowWithHistory({ nodes: [orders] }, team);
		await activate(workflow.id, workflow.versionId).expect(403);

		const review = await ownerAgent
			.post('/workflow-review-requests')
			.send({
				title: 'Open webhook for the shop',
				workflows: [
					{
						workflowId: workflow.id,
						workflowVersionId: workflow.versionId,
						workflowVersionName: 'Shop webhook',
					},
				],
				reviewerUserIds: [admin.id],
			})
			.expect(201);

		const decision = await adminAgent
			.post(`/workflow-review-requests/${review.body.data.id}/decision`)
			.send({ decision: 'approved' })
			.expect(200);

		expect(decision.body.data.autoPublish).toEqual({ status: 'published' });
		expect(await activeVersionOf(workflow.id)).toBe(workflow.versionId);

		// After an unpublish, the approval still covers the trigger.
		await ownerAgent.post(`/workflows/${workflow.id}/deactivate`).expect(200);
		await activate(workflow.id, workflow.versionId).expect(200);
	});
});

describe('GET /open-triggers', () => {
	test('should list the open triggers of the published workflows, with the approvals', async () => {
		const orders = webhook('Orders');
		const shop = await createWorkflowWithHistory({ name: 'Shop', nodes: [orders] }, team);
		await setActiveVersion(shop.id, shop.versionId);
		const secured = await createWorkflowWithHistory(
			{ name: 'Secured', nodes: [withHeaderAuth(webhook('Leads'))] },
			team,
		);
		await setActiveVersion(secured.id, secured.versionId);
		// Not published: not in the list.
		await createWorkflowWithHistory({ name: 'Draft', nodes: [webhook('Draft')] }, team);

		const response = await ownerAgent.get('/open-triggers').expect(200);

		expect(response.body.data).toEqual([
			{
				workflowId: shop.id,
				workflowName: 'Shop',
				homeProject: { id: team.id, name: 'Sales', type: 'team' },
				owner: null,
				nodeId: orders.id,
				nodeName: 'Orders',
				nodeType: 'n8n-nodes-base.webhook',
				typeVersion: 2,
				kind: 'webhook',
				path: orders.parameters.path,
				approved: false,
			},
		]);
	});

	test('should refuse a member', async () => {
		await memberAgent.get('/open-triggers').expect(403);
	});
});
