// Fork code (not in upstream n8n): the requests of the REST API of source control that ordinary code
// still makes. The fork has no source control routes, so they fail. See `FORK.md`.
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import type {
	AutoPublishMode,
	RemoteWorkflowResponse,
	SourceControlledFile,
	SourceControlPreferences,
} from './sourceControl.types';

const BASE = '/source-control';

export const getPreferences = async (context: IRestApiContext) =>
	await makeRestApiRequest<SourceControlPreferences>(context, 'GET', `${BASE}/preferences`);

export const getRemoteWorkflow = async (context: IRestApiContext, workflowId: string) =>
	await makeRestApiRequest<RemoteWorkflowResponse>(
		context,
		'GET',
		`${BASE}/remote-content/workflow/${workflowId}`,
	);

export const pullWorkfolder = async (
	context: IRestApiContext,
	data: { force: boolean; autoPublish?: AutoPublishMode },
) =>
	await makeRestApiRequest<SourceControlledFile[]>(
		context,
		'POST',
		`${BASE}/pull-workfolder`,
		data,
	);
