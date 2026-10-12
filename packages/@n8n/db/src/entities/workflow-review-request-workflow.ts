import { Column, Entity } from '@n8n/typeorm';

import { WithStringId } from './abstract-entity';

/**
 * Fork code (not in upstream n8n): a workflow of a review request, with the pinned version.
 * See `./FORK.md`.
 */
@Entity({ name: 'workflow_review_request_workflow' })
export class WorkflowReviewRequestWorkflow extends WithStringId {
	@Column({ type: 'varchar', length: 36 })
	workflowReviewRequestId: string;

	@Column({ type: 'varchar', length: 36 })
	workflowId: string;

	/** The `workflow_history` version that the review pins. `null` after the history is pruned. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	workflowVersionId: string | null;

	/** The published `workflow_history` version at the time of the approval. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	baselineVersionId: string | null;
}
