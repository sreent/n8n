import { mock } from 'vitest-mock-extended';

import type { ReviewViewer } from '../workflow-review-access.service';
import { WorkflowReviewAccessService } from '../workflow-review-access.service';
import {
	decodeActivityCursor,
	decodeInboxCursor,
	encodeActivityCursor,
	encodeInboxCursor,
} from '../workflow-review-cursor';

const service = new WorkflowReviewAccessService(mock(), mock(), mock(), mock(), mock(), mock());

const viewer = (overrides: Partial<ReviewViewer> = {}): ReviewViewer => ({
	isInstanceAdmin: false,
	isProjectAdmin: false,
	isAuthor: false,
	isReviewer: false,
	linkedWorkflowIds: ['workflow-1'],
	readableWorkflowIds: ['workflow-1'],
	...overrides,
});

describe('WorkflowReviewAccessService', () => {
	describe('canOpen', () => {
		it('lets the instance admins open each review', () => {
			expect(service.canOpen(viewer({ isInstanceAdmin: true, readableWorkflowIds: [] }))).toBe(
				true,
			);
		});

		it('needs a project admin, an author or a reviewer who can read a linked workflow', () => {
			expect(service.canOpen(viewer())).toBe(false);
			expect(service.canOpen(viewer({ isAuthor: true }))).toBe(true);
			expect(service.canOpen(viewer({ isReviewer: true, readableWorkflowIds: [] }))).toBe(false);
			expect(
				service.canOpen(
					viewer({ isProjectAdmin: true, linkedWorkflowIds: [], readableWorkflowIds: [] }),
				),
			).toBe(true);
		});
	});

	describe('decisionEligibility', () => {
		it('lets an assigned reviewer decide, also when the reviewer is an author', () => {
			expect(service.decisionEligibility(viewer({ isReviewer: true, isAuthor: true }))).toEqual({
				canDecide: true,
				via: 'assigned-reviewer',
			});
		});

		it('lets the admins decide as an override, also on their own review', () => {
			expect(service.decisionEligibility(viewer({ isProjectAdmin: true, isAuthor: true }))).toEqual(
				{ canDecide: true, via: 'admin-override' },
			);
			expect(service.decisionEligibility(viewer({ isInstanceAdmin: true }))).toEqual({
				canDecide: true,
				via: 'admin-override',
			});
		});

		it('gives the reason why a user may not decide', () => {
			expect(service.decisionEligibility(viewer({ isAuthor: true }))).toEqual({
				canDecide: false,
				reason: 'author',
			});
			expect(service.decisionEligibility(viewer())).toEqual({
				canDecide: false,
				reason: 'missing_permission',
			});
			expect(
				service.decisionEligibility(viewer({ isReviewer: true, readableWorkflowIds: [] })),
			).toEqual({ canDecide: false, reason: 'missing_reviewer_permission' });
		});

		it('lets nobody decide when no workflow is left', () => {
			const noWorkflow = { linkedWorkflowIds: [], readableWorkflowIds: [] };
			expect(
				service.decisionEligibility(
					viewer({ ...noWorkflow, isInstanceAdmin: true, isReviewer: true }),
				),
			).toEqual({ canDecide: false, reason: 'missing_permission' });
		});
	});

	describe('canComment', () => {
		it('needs a linked workflow that the viewer can read', () => {
			expect(service.canComment(viewer({ isAuthor: true }))).toBe(true);
			expect(
				service.canComment(
					viewer({ isInstanceAdmin: true, linkedWorkflowIds: [], readableWorkflowIds: [] }),
				),
			).toBe(false);
		});
	});
});

describe('the review cursors', () => {
	it('give back what they hold', () => {
		const createdAt = new Date('2026-10-14T10:00:00.123Z');
		expect(decodeInboxCursor(encodeInboxCursor(createdAt, 'request-1'))).toEqual({
			createdAt,
			id: 'request-1',
		});
		expect(decodeActivityCursor(encodeActivityCursor(42))).toBe(42);
	});

	it('reject a cursor that is not theirs', () => {
		for (const cursor of ['notACursor', encodeActivityCursor(42), '']) {
			expect(() => decodeInboxCursor(cursor)).toThrow('Invalid pagination cursor');
		}
		for (const cursor of ['notACursor', encodeInboxCursor(new Date(), 'request-1')]) {
			expect(() => decodeActivityCursor(cursor)).toThrow('Invalid pagination cursor');
		}
	});
});
