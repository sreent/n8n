import type { WorkflowReviewActivityType } from '@n8n/api-types';
import { Column, Entity, PrimaryGeneratedColumn } from '@n8n/typeorm';

import { JsonColumn, WithCreatedAt } from './abstract-entity';

/**
 * Fork code (not in upstream n8n): an entry of the activity feed of a review request.
 * See `./FORK.md`.
 */
@Entity({ name: 'workflow_review_activity' })
export class WorkflowReviewActivity extends WithCreatedAt {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: 'varchar', length: 36 })
	workflowReviewRequestId: string;

	/** The database has no CHECK on this column. The write sites keep it to the known types. */
	@Column({ type: 'varchar', length: 64 })
	type: WorkflowReviewActivityType;

	/** The schema version of `data` for this `type`. */
	@Column({ type: 'int', default: 1 })
	typeVersion: number;

	/** The details of the entry. Readers parse it for its `type` and `typeVersion`. */
	@JsonColumn({ nullable: true })
	data: unknown;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;
}
