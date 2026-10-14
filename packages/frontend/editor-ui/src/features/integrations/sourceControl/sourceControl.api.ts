// Fork code (not in upstream n8n): the requests of the REST API of source control
// (`/rest/source-control`, the module `packages/cli/src/modules/source-control`). See `FORK.md`.
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import type {
	PullWorkfolderData,
	PushWorkfolderData,
	PushWorkfolderResult,
	RemoteWorkflowResponse,
	SourceControlBranches,
	SourceControlledFile,
	SourceControlPreferences,
	SourceControlPreferencesUpdate,
	SourceControlStatusOptions,
	SshKeyTypes,
} from './sourceControl.types';

const BASE = '/source-control';

const DEFAULT_STATUS_OPTIONS: SourceControlStatusOptions = {
	direction: 'push',
	preferLocalVersion: true,
	verbose: false,
};

export const pushWorkfolder = async (context: IRestApiContext, data: PushWorkfolderData) =>
	await makeRestApiRequest<PushWorkfolderResult>(context, 'POST', `${BASE}/push-workfolder`, data);

export const pullWorkfolder = async (context: IRestApiContext, data: PullWorkfolderData) =>
	await makeRestApiRequest<SourceControlledFile[]>(
		context,
		'POST',
		`${BASE}/pull-workfolder`,
		data,
	);

export const getBranches = async (context: IRestApiContext) =>
	await makeRestApiRequest<SourceControlBranches>(context, 'GET', `${BASE}/get-branches`);

export const savePreferences = async (
	context: IRestApiContext,
	preferences: SourceControlPreferencesUpdate,
) =>
	await makeRestApiRequest<SourceControlPreferences>(
		context,
		'POST',
		`${BASE}/preferences`,
		preferences,
	);

export const updatePreferences = async (
	context: IRestApiContext,
	preferences: SourceControlPreferencesUpdate,
) =>
	await makeRestApiRequest<SourceControlPreferences>(
		context,
		'PATCH',
		`${BASE}/preferences`,
		preferences,
	);

export const getPreferences = async (context: IRestApiContext) =>
	await makeRestApiRequest<SourceControlPreferences>(context, 'GET', `${BASE}/preferences`);

/** The status for a push, with the defaults of the server. */
export const getStatus = async (context: IRestApiContext) =>
	await makeRestApiRequest<SourceControlledFile[]>(context, 'GET', `${BASE}/status`);

export const getAggregatedStatus = async (
	context: IRestApiContext,
	options: SourceControlStatusOptions = DEFAULT_STATUS_OPTIONS,
) =>
	await makeRestApiRequest<SourceControlledFile[]>(context, 'GET', `${BASE}/get-status`, {
		...options,
	});

export const getRemoteWorkflow = async (context: IRestApiContext, workflowId: string) =>
	await makeRestApiRequest<RemoteWorkflowResponse>(
		context,
		'GET',
		`${BASE}/remote-content/workflow/${workflowId}`,
	);

export const disconnect = async (context: IRestApiContext, keepKeyPair: boolean) =>
	await makeRestApiRequest<SourceControlPreferences>(context, 'POST', `${BASE}/disconnect`, {
		keepKeyPair,
	});

export const generateKeyPair = async (context: IRestApiContext, keyGeneratorType?: SshKeyTypes) =>
	await makeRestApiRequest<SourceControlPreferences>(context, 'POST', `${BASE}/generate-key-pair`, {
		keyGeneratorType,
	});
