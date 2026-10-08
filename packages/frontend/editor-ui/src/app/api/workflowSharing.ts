// Fork module (not in upstream n8n): the sharing and transfer requests for workflows and folders,
// in place of the enterprise `workflows.ee.ts`. packages/frontend/editor-ui/FORK.md describes it.
import type { TransferWorkflowBodyDto } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';
import { PROJECT_ROOT } from 'n8n-workflow';

import type { IShareWorkflowsPayload } from '@/Interface';

/** Share a workflow with exactly these projects. */
export async function setWorkflowSharedWith(
	context: IRestApiContext,
	id: string,
	data: IShareWorkflowsPayload,
) {
	return await makeRestApiRequest<unknown>(context, 'PUT', `/workflows/${id}/share`, data);
}

/** Move a workflow to another project. An activation error after the move is the result. */
export async function moveWorkflowToProject(
	context: IRestApiContext,
	id: string,
	body: TransferWorkflowBodyDto,
) {
	return await makeRestApiRequest<unknown>(context, 'PUT', `/workflows/${id}/transfer`, body);
}

/** Move a folder to another project, into a folder there or into its root. */
export async function moveFolderToProject(
	context: IRestApiContext,
	projectId: string,
	folderId: string,
	destinationProjectId: string,
	destinationParentFolderId?: string,
	shareCredentials?: string[],
) {
	return await makeRestApiRequest<unknown>(
		context,
		'PUT',
		`/projects/${projectId}/folders/${folderId}/transfer`,
		{
			destinationProjectId,
			destinationParentFolderId: destinationParentFolderId ?? PROJECT_ROOT,
			shareCredentials,
		},
	);
}
