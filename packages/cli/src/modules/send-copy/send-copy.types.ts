/** A user who can receive a copy of a workflow. */
export interface CopyRecipient {
	id: string;
	firstName: string | null;
	lastName: string | null;
	email: string;
}

/**
 * Why a copy for one recipient failed.
 * - `self`: the sender cannot send a copy to themselves.
 * - `not-found`: the recipient does not exist.
 * - `not-eligible`: the recipient is disabled, pending, or a chat user.
 * - `error`: the copy could not be created.
 */
export type SendCopyFailureReason = 'self' | 'not-found' | 'not-eligible' | 'error';

export type SendCopyResult =
	| { recipientId: string; status: 'sent'; workflowId: string; workflowName: string }
	| {
			recipientId: string;
			status: 'failed';
			reason: SendCopyFailureReason;
			message?: string;
	  };
