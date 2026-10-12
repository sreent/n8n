import { Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * Fork code (not in upstream n8n): a user who reviews a review request. See `./FORK.md`.
 */
@Entity({ name: 'workflow_review_request_reviewers' })
export class WorkflowReviewRequestReviewer {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	workflowReviewRequestId: string;

	@PrimaryColumn('uuid')
	userId: string;
}
