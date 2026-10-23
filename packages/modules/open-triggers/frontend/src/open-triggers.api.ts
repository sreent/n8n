import type { OpenTriggerItem, PolicyViolation } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The open triggers of the published workflows, with their approvals. */
export async function getOpenTriggers(context: IRestApiContext): Promise<OpenTriggerItem[]> {
	return await makeRestApiRequest(context, 'GET', '/open-triggers');
}

/**
 * The open triggers that would stop a publish of the saved workflow, as the publish check gives
 * them. The editor asks before it opens the dialogs of a publish.
 */
export async function getPublishViolations(
	context: IRestApiContext,
	workflowId: string,
): Promise<PolicyViolation[]> {
	return await makeRestApiRequest(
		context,
		'GET',
		`/open-triggers/workflows/${encodeURIComponent(workflowId)}/violations`,
	);
}
