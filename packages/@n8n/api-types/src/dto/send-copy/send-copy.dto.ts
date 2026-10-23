// Fork code (not in upstream n8n): the REST API of Send a copy (`/rest/send-copy`), for the
// backend module and the editor module. See packages/cli/src/modules/send-copy/README.md.
import { z } from 'zod';

import { Z } from '../../zod-class';

/** The largest number of recipients in one send request. */
export const SEND_COPY_MAX_RECIPIENTS = 20;

/** The number of recipient candidates that the recipients route gives by default. */
export const SEND_COPY_RECIPIENTS_DEFAULT_LIMIT = 20;

/** The largest number of recipient candidates that one recipients request can give. */
export const SEND_COPY_RECIPIENTS_MAX_LIMIT = 50;

/** The largest length of the search text for recipients. */
export const SEND_COPY_SEARCH_MAX_LENGTH = 100;

export class ListCopyRecipientsQueryDto extends Z.class({
	search: z.string().trim().max(SEND_COPY_SEARCH_MAX_LENGTH).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(SEND_COPY_RECIPIENTS_MAX_LIMIT)
		.default(SEND_COPY_RECIPIENTS_DEFAULT_LIMIT),
}) {}

export class SendWorkflowCopyDto extends Z.class({
	recipientIds: z.array(z.string().uuid()).min(1).max(SEND_COPY_MAX_RECIPIENTS),
}) {}

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

/** The answer of `POST /rest/send-copy/workflows/:workflowId`: one result for each recipient. */
export interface SendWorkflowCopyResponse {
	results: SendCopyResult[];
}
