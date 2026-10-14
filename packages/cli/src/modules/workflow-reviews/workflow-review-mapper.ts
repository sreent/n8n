import type {
	WorkflowReviewActivityEntry,
	WorkflowReviewActivityMessage,
	WorkflowReviewEligibleReviewer,
	WorkflowReviewRequestSummary,
} from '@n8n/api-types';
import {
	workflowReviewClosedActivityDataSchema,
	workflowReviewDecisionActivityDataSchema,
	workflowReviewOpenedActivityDataSchema,
	workflowReviewVersionUpdatedActivityDataSchema,
	workflowReviewWorkflowCauseActivityDataSchema,
	workflowReviewWorkflowPublishedActivityDataSchema,
} from '@n8n/api-types';
import type {
	User,
	WorkflowReviewActivity,
	WorkflowReviewActivityComment,
	WorkflowReviewRequest,
} from '@n8n/db';
import type { z } from 'zod';

/**
 * Fork code (not in upstream n8n): the shapes of the answers of the workflow reviews. See
 * `README.md`.
 */

export function toIso(date: Date | string) {
	return (date instanceof Date ? date : new Date(date)).toISOString();
}

/** The public part of a user, as the review answers show it. */
export function toReviewer(user: User): WorkflowReviewEligibleReviewer {
	return {
		id: user.id,
		email: user.email,
		firstName: user.firstName ?? null,
		lastName: user.lastName ?? null,
	};
}

/** The user with this id, or `null` when there is no id or the user is gone. */
export function reviewerOrNull(users: Map<string, User>, id: string | null) {
	const user = id ? users.get(id) : undefined;
	return user ? toReviewer(user) : null;
}

export function toSummary(
	request: WorkflowReviewRequest,
	workflowVersionId: string | null,
): WorkflowReviewRequestSummary {
	return {
		id: request.id,
		state: request.state,
		decision: request.decision,
		workflowVersionId,
		createdAt: toIso(request.createdAt),
		updatedAt: toIso(request.updatedAt),
	};
}

/** The stored data of an entry, or `null` when it does not match the schema of its type. */
function parseData<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> | null {
	const parsed = schema.safeParse(data);
	return parsed.success ? parsed.data : null;
}

function toMessage(
	comment: WorkflowReviewActivityComment,
	users: Map<string, User>,
): WorkflowReviewActivityMessage {
	return {
		id: String(comment.id),
		body: comment.body,
		createdBy: reviewerOrNull(users, comment.createdById),
		createdAt: toIso(comment.createdAt),
		updatedAt: comment.updatedAt ? toIso(comment.updatedAt) : null,
		deletedAt: comment.deletedAt ? toIso(comment.deletedAt) : null,
	};
}

export function toActivityEntry(
	activity: WorkflowReviewActivity,
	messages: WorkflowReviewActivityComment[],
	users: Map<string, User>,
): WorkflowReviewActivityEntry {
	const base = {
		id: String(activity.id),
		typeVersion: activity.typeVersion,
		createdBy: reviewerOrNull(users, activity.createdById),
		createdAt: toIso(activity.createdAt),
	};
	const { type, data } = activity;

	switch (type) {
		case 'comment.created':
			return {
				...base,
				type,
				data: null,
				messages: messages.map((message) => toMessage(message, users)),
			};
		case 'review.opened':
			return { ...base, type, data: parseData(workflowReviewOpenedActivityDataSchema, data) };
		case 'review.changes_requested':
		case 'review.approved':
			return { ...base, type, data: parseData(workflowReviewDecisionActivityDataSchema, data) };
		case 'review.version_updated':
			return {
				...base,
				type,
				data: parseData(workflowReviewVersionUpdatedActivityDataSchema, data),
			};
		case 'review.closed':
			return { ...base, type, data: parseData(workflowReviewClosedActivityDataSchema, data) };
		case 'workflow.archived':
		case 'workflow.deleted':
		case 'workflow.moved':
			return {
				...base,
				type,
				data: parseData(workflowReviewWorkflowCauseActivityDataSchema, data),
			};
		case 'workflow.published':
			return {
				...base,
				type,
				data: parseData(workflowReviewWorkflowPublishedActivityDataSchema, data),
			};
	}
}
