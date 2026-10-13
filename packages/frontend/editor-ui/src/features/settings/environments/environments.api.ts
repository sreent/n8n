/**
 * Fork code (not in upstream n8n): the REST client of the variables (`/rest/variables`). See
 * `FORK.md` in this folder.
 */
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import type {
	CreateVariablePayload,
	EnvironmentVariable,
	UpdateVariablePayload,
} from './environments.types';

export async function getVariables(context: IRestApiContext): Promise<EnvironmentVariable[]> {
	return await makeRestApiRequest(context, 'GET', '/variables');
}

export async function createVariable(
	context: IRestApiContext,
	payload: CreateVariablePayload,
): Promise<EnvironmentVariable> {
	return await makeRestApiRequest(context, 'POST', '/variables', { ...payload });
}

export async function updateVariable(
	context: IRestApiContext,
	{ id, ...payload }: UpdateVariablePayload,
): Promise<EnvironmentVariable> {
	return await makeRestApiRequest(context, 'PATCH', `/variables/${id}`, payload);
}

export async function deleteVariable(context: IRestApiContext, id: string): Promise<boolean> {
	return await makeRestApiRequest(context, 'DELETE', `/variables/${id}`);
}
