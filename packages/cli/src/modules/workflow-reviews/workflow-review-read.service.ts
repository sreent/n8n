import type {
	InboxCounts,
	InboxWorkflowReviewItem,
	ListWorkflowReviewActivityQueryDto,
	ListWorkflowReviewActivityResponse,
	ListWorkflowReviewRequestsQueryDto,
	WorkflowReviewEligibleReviewersList,
	WorkflowReviewInboxItem,
	WorkflowReviewRequestDetail,
	WorkflowReviewRequestList,
	WorkflowReviewVersionSnapshot,
} from '@n8n/api-types';
import { RoleService } from '@n8n/backend-services';
import type { User, WorkflowReviewRequest } from '@n8n/db';
import {
	ProjectRelationRepository,
	SharedWorkflowRepository,
	UserRepository,
	WorkflowHistoryRepository,
	WorkflowReviewActivityRepository,
	WorkflowReviewInboxRepository,
	WorkflowReviewRequestAuthorRepository,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestReviewerRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { NotFoundError } from '@n8n/errors';

import type { InboxSourceQuery } from '@/modules/inbox/inbox-source.registry';
import { userHasScopes } from '@/permissions/check-access';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { WorkflowReviewAccessService } from './workflow-review-access.service';
import { decodeActivityCursor, encodeActivityCursor } from './workflow-review-cursor';
import { reviewerOrNull, toActivityEntry, toIso, toReviewer } from './workflow-review-mapper';

/**
 * Fork code (not in upstream n8n): the reads of the workflow reviews and the eligible reviewers.
 * See `README.md`.
 */
@Service()
export class WorkflowReviewReadService {
	constructor(
		private readonly requestRepository: WorkflowReviewRequestRepository,
		private readonly requestWorkflowRepository: WorkflowReviewRequestWorkflowRepository,
		private readonly authorRepository: WorkflowReviewRequestAuthorRepository,
		private readonly reviewerRepository: WorkflowReviewRequestReviewerRepository,
		private readonly inboxRepository: WorkflowReviewInboxRepository,
		private readonly activityRepository: WorkflowReviewActivityRepository,
		private readonly workflowHistoryRepository: WorkflowHistoryRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly userRepository: UserRepository,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly roleService: RoleService,
		private readonly access: WorkflowReviewAccessService,
	) {}

	async getEligibleReviewers(
		user: User,
		workflowId: string,
	): Promise<WorkflowReviewEligibleReviewersList> {
		await this.findWorkflowOrFail(user, workflowId, 'workflow:publish');
		const reviewers = await this.findEligibleReviewers(workflowId, user.id);
		return { count: reviewers.length, data: reviewers.map(toReviewer) };
	}

	/**
	 * The users who can read the workflow, without `excludedUserId`, pending users and disabled
	 * users, in the order of their e-mail addresses.
	 */
	async findEligibleReviewers(workflowId: string, excludedUserId: string) {
		const candidateIds = new Set<string>();
		for (const slug of await this.roleService.rolesWithScope('global', ['workflow:read'])) {
			const users = await this.userRepository.find({
				select: { id: true },
				where: { role: { slug } },
			});
			for (const { id } of users) candidateIds.add(id);
		}
		const shares = await this.sharedWorkflowRepository.find({ where: { workflowId } });
		for (const { projectId } of shares) {
			for (const id of await this.projectRelationRepository.findUserIdsByProjectId(projectId)) {
				candidateIds.add(id);
			}
		}
		candidateIds.delete(excludedUserId);

		const candidates = await this.userRepository.findManyByIds([...candidateIds], {
			includeRole: true,
		});
		const reviewers: User[] = [];
		for (const candidate of candidates) {
			if (candidate.isPending || candidate.disabled) continue;
			if (await userHasScopes(candidate, ['workflow:read'], false, { workflowId })) {
				reviewers.push(candidate);
			}
		}
		return reviewers.sort((a, b) => String(a.email).localeCompare(String(b.email)));
	}

	async listForWorkflow(
		user: User,
		query: ListWorkflowReviewRequestsQueryDto,
	): Promise<WorkflowReviewRequestList> {
		await this.findWorkflowOrFail(user, query.workflowId, 'workflow:read');
		const canPublish = await this.access.canPublishWorkflow(user, query.workflowId);
		const [rows, count] = await this.requestRepository.findRequestsForWorkflow(query.workflowId, {
			state: query.state,
			skip: query.skip,
			take: query.take,
		});
		const users = await this.loadUsers(
			rows.map((row) => (row.decision === 'changes_requested' ? row.updatedById : null)),
		);

		const data = [];
		for (const row of rows) {
			const viewer = await this.access.getViewer(user, row);
			data.push({
				id: row.id,
				state: row.state,
				decision: row.decision,
				description: canPublish ? row.description : null,
				workflowVersionId: row.workflowVersionId,
				workflowVersionName: row.workflowVersionName,
				createdAt: toIso(row.createdAt),
				updatedAt: toIso(row.updatedAt),
				decisionBy:
					row.decision === 'changes_requested' ? reviewerOrNull(users, row.updatedById) : null,
				viewerCanOpen: this.access.canOpen(viewer),
			});
		}
		return { count, data };
	}

	/**
	 * The reviews of the inbox (its source `workflow_review`): the newest change first, then the
	 * IDs in database order. The inbox merges them with the items of its other sources.
	 */
	async listForInbox(user: User, query: InboxSourceQuery): Promise<InboxWorkflowReviewItem[]> {
		const requests = await this.inboxRepository.findRequests({
			visibility: await this.access.inboxVisibility(user),
			state: query.state,
			category: query.category ? { userId: user.id, category: query.category } : undefined,
			limit: query.limit,
			boundary: query.boundary,
		});
		const items = await this.toInboxItems(requests);
		return items.map((item) => ({ ...item, type: 'workflow_review' as const }));
	}

	/** The numbers of open and closed reviews that the user sees in the inbox. */
	async countForInbox(user: User): Promise<InboxCounts> {
		return await this.inboxRepository.countRequestsByState(await this.access.inboxVisibility(user));
	}

	async getDetail(user: User, requestId: string): Promise<WorkflowReviewRequestDetail> {
		const request = await this.findRequestOrFail(requestId);
		const viewer = await this.access.getViewer(user, request);
		if (!this.access.canOpen(viewer)) throw new NotFoundError('Could not find review request');

		const [item] = await this.toInboxItems([request]);
		const { workflowName: _name, workflowVersionId: _version, ...summary } = item;
		const rows = await this.requestWorkflowRepository.findLinkedWorkflowDetailsByRequestId(
			request.id,
		);
		const workflows = [];
		for (const row of rows) {
			workflows.push({
				workflowId: row.workflowId,
				workflowName: row.workflowName,
				workflowVersionId: row.workflowVersionId,
				pinnedVersion: await this.findVersionSnapshot(row.workflowId, row.workflowVersionId),
				publishedVersionId: row.activeVersionId,
				// The live published version while the review is open, else the one that the
				// approval kept.
				baselineVersion: await this.findVersionSnapshot(
					row.workflowId,
					row.requestState === 'open' ? row.activeVersionId : row.baselineVersionId,
				),
			});
		}
		const eligibility = this.access.decisionEligibility(viewer);

		return {
			...summary,
			description: request.description,
			workflows,
			viewerCanDecide: eligibility.canDecide,
			viewerDecisionIneligibilityReason: eligibility.canDecide ? null : eligibility.reason,
			viewerCanComment: this.access.canComment(viewer),
		};
	}

	async getActivity(
		user: User,
		requestId: string,
		query: ListWorkflowReviewActivityQueryDto,
	): Promise<ListWorkflowReviewActivityResponse> {
		const request = await this.findRequestOrFail(requestId);
		const viewer = await this.access.getViewer(user, request);
		if (!this.access.canOpen(viewer)) throw new NotFoundError('Could not find review request');

		const beforeId = query.cursor ? decodeActivityCursor(query.cursor) : undefined;
		const { entries, hasMore } = await this.activityRepository.findFeedPage(
			{ workflowReviewRequestId: request.id, limit: query.limit, beforeId },
			{},
		);
		const users = await this.loadUsers(
			entries.flatMap(({ activity, messages }) => [
				activity.createdById,
				...messages.map((message) => message.createdById),
			]),
		);
		const oldest = entries.at(0);

		return {
			data: entries.map(({ activity, messages }) => toActivityEntry(activity, messages, users)),
			nextCursor: hasMore && oldest ? encodeActivityCursor(oldest.activity.id) : null,
			hasMore,
		};
	}

	async findRequestOrFail(requestId: string) {
		const request = await this.requestRepository.findById(requestId, {});
		if (!request) throw new NotFoundError('Could not find review request');
		return request;
	}

	async findWorkflowOrFail(
		user: User,
		workflowId: string,
		scope: 'workflow:read' | 'workflow:publish',
	) {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, [
			scope,
		]);
		if (!workflow) throw new NotFoundError('Could not find workflow');
		return workflow;
	}

	/** The users with these ids, by id. Missing ids and gone users are not in the map. */
	async loadUsers(ids: (string | null)[]) {
		const uniqueIds = [...new Set(ids.filter((id): id is string => id !== null))];
		const users = uniqueIds.length > 0 ? await this.userRepository.findManyByIds(uniqueIds) : [];
		return new Map(users.map((user) => [user.id, user]));
	}

	private async toInboxItems(
		requests: WorkflowReviewRequest[],
	): Promise<WorkflowReviewInboxItem[]> {
		const requestIds = requests.map((request) => request.id);
		const [authors, reviewers, linked] = await Promise.all([
			this.authorRepository.findByRequestIds(requestIds),
			this.reviewerRepository.findByRequestIds(requestIds),
			this.requestWorkflowRepository.findLinkedWorkflowsByRequestIds(requestIds),
		]);
		const users = await this.loadUsers([
			...requests.map((request) => request.createdById),
			...authors.map((author) => author.userId),
			...reviewers.map((reviewer) => reviewer.userId),
		]);
		const usersOf = (rows: { workflowReviewRequestId: string; userId: string }[], id: string) =>
			rows
				.filter((row) => row.workflowReviewRequestId === id)
				.flatMap((row) => {
					const user = users.get(row.userId);
					return user ? [toReviewer(user)] : [];
				});

		return requests.map((request) => ({
			id: request.id,
			projectId: request.projectId,
			title: request.title,
			decision: request.decision,
			state: request.state,
			createdAt: toIso(request.createdAt),
			updatedAt: toIso(request.updatedAt),
			requester: reviewerOrNull(users, request.createdById),
			authors: usersOf(authors, request.id),
			reviewers: usersOf(reviewers, request.id),
			workflowName: linked.get(request.id)?.workflowName ?? null,
			workflowVersionId: linked.get(request.id)?.workflowVersionId ?? null,
		}));
	}

	private async findVersionSnapshot(
		workflowId: string,
		versionId: string | null,
	): Promise<WorkflowReviewVersionSnapshot | null> {
		if (!versionId) return null;
		const version = await this.workflowHistoryRepository.findOne({
			where: { workflowId, versionId },
		});
		if (!version) return null;
		return {
			versionId: version.versionId,
			name: version.name ?? null,
			nodes: version.nodes,
			connections: version.connections,
			nodeGroups: version.nodeGroups ?? [],
			createdAt: toIso(version.createdAt),
		};
	}
}
