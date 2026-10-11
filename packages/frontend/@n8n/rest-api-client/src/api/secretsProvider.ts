import type {
	CreateSecretsProviderConnectionDto,
	ReloadSecretProviderConnectionResponse,
	SecretProviderConnection,
	SecretProviderTypeResponse,
	TestSecretProviderConnectionResponse,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';
import type { IDataObject } from 'n8n-workflow';

import type { IRestApiContext } from '../types';
import { makeRestApiRequest } from '../utils';

/**
 * Fork code (not in upstream n8n): the client of the connections API of external secrets
 * (`/secret-providers`). It replaces the enterprise `secretsProvider.ee.ts`.
 * packages/frontend/editor-ui/src/features/integrations/externalSecrets/FORK.md describes it.
 */

/** The body of a create. The server ignores the keys that the schema does not know. */
type CreateConnection = CreateSecretsProviderConnectionDto & IDataObject;

/** The body of an update. The server ignores the keys that the schema does not know. */
type UpdateConnection = UpdateSecretsProviderConnectionDto & IDataObject;

// #region The provider types

export const getSecretProviderTypes = async (
	context: IRestApiContext,
): Promise<SecretProviderTypeResponse[]> => {
	return await makeRestApiRequest(context, 'GET', '/secret-providers/types');
};

// #endregion

// #region The connections of the instance

export const getSecretProviderConnections = async (
	context: IRestApiContext,
): Promise<SecretProviderConnection[]> => {
	return await makeRestApiRequest(context, 'GET', '/secret-providers/connections');
};

export const getSecretProviderConnectionByKey = async (
	context: IRestApiContext,
	providerKey: string,
): Promise<SecretProviderConnection> => {
	return await makeRestApiRequest(context, 'GET', `/secret-providers/connections/${providerKey}`);
};

export const createSecretProviderConnection = async (
	context: IRestApiContext,
	data: CreateConnection,
): Promise<SecretProviderConnection> => {
	return await makeRestApiRequest(context, 'POST', '/secret-providers/connections', data);
};

export const updateSecretProviderConnection = async (
	context: IRestApiContext,
	providerKey: string,
	data: UpdateConnection,
): Promise<SecretProviderConnection> => {
	return await makeRestApiRequest(
		context,
		'PATCH',
		`/secret-providers/connections/${providerKey}`,
		data,
	);
};

/** Enable the connection. */
export const enableSecretProviderConnection = async (
	context: IRestApiContext,
	providerKey: string,
): Promise<SecretProviderConnection> => {
	return await makeRestApiRequest(
		context,
		'PATCH',
		`/secret-providers/connections/${providerKey}`,
		{
			isEnabled: true,
		},
	);
};

export const deleteSecretProviderConnection = async (
	context: IRestApiContext,
	providerKey: string,
): Promise<void> => {
	return await makeRestApiRequest(
		context,
		'DELETE',
		`/secret-providers/connections/${providerKey}`,
	);
};

export const testSecretProviderConnection = async (
	context: IRestApiContext,
	providerKey: string,
): Promise<TestSecretProviderConnectionResponse> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`/secret-providers/connections/${providerKey}/test`,
	);
};

/** Read the secrets of the connection again. */
export const reloadSecretProviderConnection = async (
	context: IRestApiContext,
	providerKey: string,
): Promise<ReloadSecretProviderConnectionResponse> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`/secret-providers/connections/${providerKey}/reload`,
	);
};

// #endregion

// #region The connections of a project

export const getProjectSecretProviderConnectionsByProjectId = async (
	context: IRestApiContext,
	projectId: string,
): Promise<SecretProviderConnection[]> => {
	return await makeRestApiRequest(
		context,
		'GET',
		`/secret-providers/projects/${projectId}/connections`,
	);
};

export const getProjectSecretProviderConnectionByKey = async (
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
): Promise<SecretProviderConnection> => {
	return await makeRestApiRequest(
		context,
		'GET',
		`/secret-providers/projects/${projectId}/connections/${providerKey}`,
	);
};

/** Create a connection that the project owns. */
export const createProjectSecretProviderConnection = async (
	context: IRestApiContext,
	projectId: string,
	data: CreateConnection,
): Promise<SecretProviderConnection> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`/secret-providers/projects/${projectId}/connections`,
		data,
	);
};

export const updateProjectSecretProviderConnection = async (
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
	data: UpdateConnection,
): Promise<SecretProviderConnection> => {
	return await makeRestApiRequest(
		context,
		'PATCH',
		`/secret-providers/projects/${projectId}/connections/${providerKey}`,
		data,
	);
};

export const deleteProjectSecretProviderConnection = async (
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
): Promise<void> => {
	return await makeRestApiRequest(
		context,
		'DELETE',
		`/secret-providers/projects/${projectId}/connections/${providerKey}`,
	);
};

export const testProjectSecretProviderConnection = async (
	context: IRestApiContext,
	projectId: string,
	providerKey: string,
): Promise<TestSecretProviderConnectionResponse> => {
	return await makeRestApiRequest(
		context,
		'POST',
		`/secret-providers/projects/${projectId}/connections/${providerKey}/test`,
	);
};

// #endregion
