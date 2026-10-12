import {
	createTeamProject,
	createWorkflow,
	createWorkflowHistory,
	testDb,
} from '@n8n/backend-test-utils';
import type { Project, User, WorkflowEntity } from '@n8n/db';
import {
	WorkflowRepository,
	WorkflowReviewActivityCommentRepository,
	WorkflowReviewActivityRepository,
	WorkflowReviewInboxRepository,
	WorkflowReviewLifecycleRepository,
	WorkflowReviewRequestAuthorRepository,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestReviewerRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { v4 as uuid } from 'uuid';

import { createMember } from '../../shared/db/users';

/**
 * Fork test (not in upstream n8n): the ordinary review repositories on the fork's entities of the
 * workflow review tables. See `packages/@n8n/db/src/entities/FORK.md`.
 */
describe('workflow review repositories on the fork entities', () => {
	const requests = () => Container.get(WorkflowReviewRequestRepository);
	const links = () => Container.get(WorkflowReviewRequestWorkflowRepository);
	const reviewers = () => Container.get(WorkflowReviewRequestReviewerRepository);
	const authors = () => Container.get(WorkflowReviewRequestAuthorRepository);

	let project: Project;
	let workflow: WorkflowEntity;
	let author: User;
	let reviewer: User;
	let firstVersionId: string;
	let secondVersionId: string;

	beforeAll(async () => {
		await testDb.init();
	});

	beforeEach(async () => {
		await testDb.truncate([
			'WorkflowReviewActivityComment',
			'WorkflowReviewActivity',
			'WorkflowReviewRequestReviewer',
			'WorkflowReviewRequestAuthor',
			'WorkflowReviewRequestWorkflow',
			'WorkflowReviewRequest',
			// The workflow first: its `activeVersionId` points at a history row.
			'WorkflowEntity',
			'WorkflowHistory',
			'Project',
			'User',
		]);

		project = await createTeamProject('Reviews');
		author = await createMember();
		reviewer = await createMember();
		firstVersionId = uuid();
		secondVersionId = uuid();
		workflow = await createWorkflow({ name: 'Invoices', versionId: secondVersionId }, project);
		await createWorkflowHistory({ ...workflow, versionId: firstVersionId });
		await createWorkflowHistory(workflow, undefined, undefined, { name: 'Release 2' });
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	async function openReview(title = 'Review the invoices') {
		const request = await requests().createRequest(
			{ projectId: project.id, title, createdById: author.id },
			{},
		);
		await links().createWorkflowRow(
			{
				workflowReviewRequestId: request.id,
				workflowId: workflow.id,
				workflowVersionId: firstVersionId,
			},
			{},
		);
		await authors().addAuthor({ workflowReviewRequestId: request.id, userId: author.id }, {});
		await reviewers().addReviewers(
			{ workflowReviewRequestId: request.id, userIds: [reviewer.id] },
			{},
		);
		return request;
	}

	it('stores a request with its defaults, and saves and closes it', async () => {
		const request = await openReview();

		expect(request.id).toEqual(expect.any(String));
		const stored = await requests().findById(request.id, {});
		expect(stored).toMatchObject({
			projectId: project.id,
			state: 'open',
			decision: 'pending',
			title: 'Review the invoices',
			description: null,
			createdById: author.id,
			updatedById: author.id,
			closedById: null,
			approvedAt: null,
		});
		expect(stored?.createdAt).toBeInstanceOf(Date);
		expect(stored?.updatedAt).toBeInstanceOf(Date);

		const approvedAt = new Date('2026-01-02T03:04:05.678Z');
		await requests().saveRequest({ ...stored!, decision: 'approved', approvedAt }, {});
		await requests().closeRequests([request.id], {});

		expect(await requests().findById(request.id, {})).toMatchObject({
			state: 'closed',
			decision: 'approved',
			approvedAt,
			closedById: null,
		});
	});

	it('pins a workflow version, and finds the request through the workflow', async () => {
		const request = await openReview();
		await links().updateWorkflowVersion(
			{
				workflowReviewRequestId: request.id,
				workflowId: workflow.id,
				workflowVersionId: secondVersionId,
			},
			{},
		);
		await Container.get(WorkflowRepository).update(workflow.id, {
			activeVersionId: secondVersionId,
		});
		await links().captureApprovalBaseline(
			{ workflowReviewRequestId: request.id, workflowId: workflow.id },
			{},
		);

		const [link] = await links().findByRequestId(request.id, {});
		expect(link).toMatchObject({
			id: expect.any(String),
			workflowReviewRequestId: request.id,
			workflowId: workflow.id,
			workflowVersionId: secondVersionId,
			baselineVersionId: secondVersionId,
		});
		expect(
			await links().findRequestIdsPinnedToVersion(
				{ workflowId: workflow.id, workflowVersionId: secondVersionId },
				{},
			),
		).toEqual([request.id]);
		expect((await links().findLinkedWorkflowsByRequestIds([request.id])).get(request.id)).toEqual({
			workflowName: 'Invoices',
			workflowVersionId: secondVersionId,
		});
		expect(await links().findLinkedWorkflowDetailsByRequestId(request.id)).toEqual([
			{
				workflowId: workflow.id,
				workflowName: 'Invoices',
				workflowVersionId: secondVersionId,
				activeVersionId: secondVersionId,
				baselineVersionId: secondVersionId,
				requestState: 'open',
			},
		]);

		const [rows, count] = await requests().findRequestsForWorkflow(workflow.id);
		expect(count).toBe(1);
		expect(rows).toEqual([
			expect.objectContaining({
				id: request.id,
				state: 'open',
				workflowVersionId: secondVersionId,
				workflowVersionName: 'Release 2',
			}),
		]);
		expect(await requests().findOpenRequestForWorkflow(workflow.id, {})).toMatchObject({
			id: request.id,
		});
	});

	it('keeps the reviewers and the authors of each request', async () => {
		const request = await openReview();
		await reviewers().addReviewers(
			{ workflowReviewRequestId: request.id, userIds: [reviewer.id, reviewer.id] },
			{},
		);
		await authors().addAuthorIfMissing(
			{ workflowReviewRequestId: request.id, userId: author.id },
			{},
		);

		expect(
			await reviewers().isReviewer(
				{ workflowReviewRequestId: request.id, userId: reviewer.id },
				{},
			),
		).toBe(true);
		expect(
			await reviewers().isReviewer({ workflowReviewRequestId: request.id, userId: author.id }, {}),
		).toBe(false);
		expect(
			await authors().isAuthor({ workflowReviewRequestId: request.id, userId: author.id }, {}),
		).toBe(true);
		expect(await reviewers().findByRequestIds([request.id])).toEqual([
			{ workflowReviewRequestId: request.id, userId: reviewer.id },
		]);
		expect(await authors().findByRequestIds([request.id])).toEqual([
			{ workflowReviewRequestId: request.id, userId: author.id },
		]);
		expect(await reviewers().findRequestIdsForUser([request.id], reviewer.id)).toEqual(
			new Set([request.id]),
		);
		expect(await authors().findRequestIdsForUser([request.id], reviewer.id)).toEqual(new Set());
	});

	it('keeps the activity feed with its comment threads', async () => {
		const request = await openReview();
		const activities = Container.get(WorkflowReviewActivityRepository);
		const data = {
			workflowVersions: [{ workflowId: workflow.id, workflowVersionId: firstVersionId }],
		};

		const opened = await activities.createActivity(
			{ workflowReviewRequestId: request.id, createdById: author.id, type: 'review.opened', data },
			{},
		);
		const thread = await activities.createActivity(
			{
				workflowReviewRequestId: request.id,
				createdById: reviewer.id,
				type: 'comment.created',
				data: null,
			},
			{},
		);
		await Container.get(WorkflowReviewActivityCommentRepository).createComment(
			{ activityId: thread.id, createdById: reviewer.id, body: 'Looks good' },
			{},
		);

		const newest = await activities.findFeedPage(
			{ workflowReviewRequestId: request.id, limit: 1 },
			{},
		);
		expect(newest.hasMore).toBe(true);
		expect(newest.entries).toHaveLength(1);
		expect(newest.entries[0].activity).toMatchObject({
			id: thread.id,
			type: 'comment.created',
			typeVersion: 1,
			data: null,
			createdById: reviewer.id,
		});
		expect(newest.entries[0].messages).toEqual([
			expect.objectContaining({
				activityId: thread.id,
				body: 'Looks good',
				createdById: reviewer.id,
				history: null,
				updatedAt: null,
				deletedAt: null,
				createdAt: expect.any(Date),
			}),
		]);

		const older = await activities.findFeedPage(
			{ workflowReviewRequestId: request.id, limit: 10, beforeId: thread.id },
			{},
		);
		expect(older.hasMore).toBe(false);
		expect(older.entries).toEqual([
			{
				activity: expect.objectContaining({ id: opened.id, type: 'review.opened', data }),
				messages: [],
			},
		]);
	});

	it('lists the inbox for each participant, and counts the requests by state', async () => {
		const open = await openReview('Open review');
		const closed = await openReview('Closed review');
		await requests().closeRequests([closed.id], {});
		const inbox = Container.get(WorkflowReviewInboxRepository);
		const stranger = await createMember();
		const involved = (user: User) => ({
			scope: 'involved' as const,
			userId: user.id,
			adminProjectIds: [],
			readableProjectIds: null,
			readableWorkflowRoles: [],
		});

		const all = await inbox.findRequests({ visibility: { scope: 'all' }, limit: 10 });
		expect(new Set(all.map(({ id }) => id))).toEqual(new Set([open.id, closed.id]));
		expect(await inbox.countRequestsByState({ scope: 'all' })).toEqual({ open: 1, closed: 1 });

		const waiting = await inbox.findRequests({
			visibility: involved(reviewer),
			category: { userId: reviewer.id, category: 'waiting' },
			state: 'open',
			limit: 10,
		});
		expect(waiting.map(({ id }) => id)).toEqual([open.id]);

		const authored = await inbox.findRequests({
			visibility: involved(author),
			category: { userId: author.id, category: 'authored' },
			limit: 10,
		});
		expect(new Set(authored.map(({ id }) => id))).toEqual(new Set([open.id, closed.id]));

		expect(await inbox.findRequests({ visibility: involved(stranger), limit: 10 })).toEqual([]);
	});

	it('finds the open requests of a changed workflow, and closes the ones left without one', async () => {
		const request = await openReview();
		const lifecycle = Container.get(WorkflowReviewLifecycleRepository);

		expect(await lifecycle.findOpenRequestsAffectedByWorkflows([workflow.id], {})).toEqual([
			{
				request: expect.objectContaining({ id: request.id, state: 'open' }),
				links: [{ workflowId: workflow.id, workflowVersionId: firstVersionId }],
			},
		]);
		expect(await lifecycle.findUnreviewableOpenRequestIds({})).toEqual([]);

		await Container.get(WorkflowRepository).update(workflow.id, { isArchived: true });

		expect(await lifecycle.findUnreviewableOpenRequestIds({})).toEqual([request.id]);
	});
});
