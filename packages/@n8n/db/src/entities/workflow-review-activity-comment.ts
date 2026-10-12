import { Column, Entity, PrimaryGeneratedColumn } from '@n8n/typeorm';

import { DateTimeColumn, JsonColumn, WithCreatedAt } from './abstract-entity';

/**
 * Fork code (not in upstream n8n): a message in the thread of an activity entry of a review
 * request. See `./FORK.md`.
 */
@Entity({ name: 'workflow_review_activity_comment' })
export class WorkflowReviewActivityComment extends WithCreatedAt {
	@PrimaryGeneratedColumn()
	id: number;

	/** The activity entry that is the header of the thread. */
	@Column({ type: 'int' })
	activityId: number;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;

	/** `null` after the comment is deleted. */
	@Column({ type: 'text', nullable: true })
	body: string | null;

	/** The earlier versions of the comment. */
	@JsonColumn({ nullable: true })
	history: Array<Record<string, unknown>> | null;

	/** Set when the body is edited. */
	@DateTimeColumn({ nullable: true })
	updatedAt: Date | null;

	/** Set when the comment is deleted. */
	@DateTimeColumn({ nullable: true })
	deletedAt: Date | null;
}
