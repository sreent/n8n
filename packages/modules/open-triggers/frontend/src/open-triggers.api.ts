import type { OpenTriggerItem } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The open triggers of the published workflows, with their approvals. */
export async function getOpenTriggers(context: IRestApiContext): Promise<OpenTriggerItem[]> {
	return await makeRestApiRequest(context, 'GET', '/open-triggers');
}
