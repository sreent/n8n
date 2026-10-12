import { Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * Fork code (not in upstream n8n): a user who authored a review request. See `./FORK.md`.
 */
@Entity({ name: 'workflow_review_request_authors' })
export class WorkflowReviewRequestAuthor {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	workflowReviewRequestId: string;

	@PrimaryColumn('uuid')
	userId: string;
}
