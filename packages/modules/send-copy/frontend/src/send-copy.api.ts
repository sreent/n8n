import type { CopyRecipient, SendWorkflowCopyResponse } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

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
): Promise<SendWorkflowCopyResponse> {
	return await makeRestApiRequest(
		context,
		'POST',
		`/send-copy/workflows/${encodeURIComponent(workflowId)}`,
		{ recipientIds },
	);
}
