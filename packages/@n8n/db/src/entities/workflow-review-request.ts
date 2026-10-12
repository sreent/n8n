import { Column, Entity } from '@n8n/typeorm';

import { DateTimeColumn, WithTimestampsAndStringId } from './abstract-entity';

/**
 * Fork code (not in upstream n8n): the entities of the workflow review tables replace the
 * enterprise entities of the same names. The columns follow the ordinary migrations of these
 * tables. See `./FORK.md`.
 */
export const WorkflowReviewRequestStateList = ['open', 'closed'] as const;

export type WorkflowReviewRequestState = (typeof WorkflowReviewRequestStateList)[number];

export const WorkflowReviewRequestDecisionList = [
	'pending',
	'changes_requested',
	'approved',
] as const;

export type WorkflowReviewRequestDecision = (typeof WorkflowReviewRequestDecisionList)[number];

/** A request to review a workflow version of a project. */
@Entity({ name: 'workflow_review_request' })
export class WorkflowReviewRequest extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 36 })
	projectId: string;

	/** Open requests take actions. Closed requests are done. */
	@Column({ type: 'varchar', length: 16, default: 'open' })
	state: WorkflowReviewRequestState;

	/** The latest outcome of the review while the request is open. */
	@Column({ type: 'varchar', length: 50, default: 'pending' })
	decision: WorkflowReviewRequestDecision;

	@Column({ type: 'varchar', length: 255 })
	title: string;

	@Column({ type: 'text', nullable: true })
	description: string | null;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;

	@Column({ type: 'uuid', nullable: true })
	updatedById: string | null;

	@Column({ type: 'uuid', nullable: true })
	closedById: string | null;

	@DateTimeColumn({ nullable: true })
	approvedAt: Date | null;
}
