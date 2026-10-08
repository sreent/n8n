// Fork module (not in upstream n8n): the sharing and transfer requests for credentials, in place
// of the enterprise `credentials.ee.api.ts`. packages/frontend/editor-ui/FORK.md describes it.
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import type { IShareCredentialsPayload } from './credentials.types';

/** Share a credential with exactly these projects. */
export async function setCredentialSharedWith(
	context: IRestApiContext,
	id: string,
	data: IShareCredentialsPayload,
) {
	return await makeRestApiRequest<unknown>(context, 'PUT', `/credentials/${id}/share`, data);
}

/** Move a credential to another project. */
export async function moveCredentialToProject(
	context: IRestApiContext,
	id: string,
	destinationProjectId: string,
) {
	return await makeRestApiRequest<unknown>(context, 'PUT', `/credentials/${id}/transfer`, {
		destinationProjectId,
	});
}
