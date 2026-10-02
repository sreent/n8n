import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** A colleague who can receive a copy. */
export interface CopyRecipient {
	id: string;
	firstName: string | null;
	lastName: string | null;
	email: string;
}

export type SendCopyFailureReason = 'self' | 'not-found' | 'not-eligible' | 'error';

export type SendCopyResult =
	| { recipientId: string; status: 'sent'; workflowId: string; workflowName: string }
	| { recipientId: string; status: 'failed'; reason: SendCopyFailureReason; message?: string };

export async function getCopyRecipients(
	context: IRestApiContext,
	params: { search?: string; limit?: number },
): Promise<CopyRecipient[]> {
	return await makeRestApiRequest(context, 'GET', '/send-copy/recipients', params);
}

export async function sendWorkflowCopy(
	context: IRestApiContext,
	workflowId: string,
	recipientIds: string[],
): Promise<{ results: SendCopyResult[] }> {
	return await makeRestApiRequest(
		context,
		'POST',
		`/send-copy/workflows/${encodeURIComponent(workflowId)}`,
		{ recipientIds },
	);
}
