import type {
	ExternalSecretsProvider,
	ExternalSecretsProviderData,
	ExternalSecretsProviderState,
	SecretCompletionsResponse,
} from '@n8n/api-types';
import type { IDataObject } from 'n8n-workflow';

import type { IRestApiContext } from '../types';
import { makeRestApiRequest } from '../utils';

/**
 * Fork code (not in upstream n8n): the client of the settings API of external secrets
 * (`/external-secrets`) and of the completions of the secrets. It replaces the enterprise
 * `externalSecrets.ee.ts`.
 * packages/frontend/editor-ui/src/features/integrations/externalSecrets/FORK.md describes it.
 */

/** The settings of a provider type, as the form gives them. */
type ProviderSettings = ExternalSecretsProviderData | IDataObject;

/** The names of the secrets of each provider, by provider name. */
export const getExternalSecrets = async (
	context: IRestApiContext,
): Promise<Record<string, string[]>> => {
	return await makeRestApiRequest(context, 'GET', '/external-secrets/secrets');
};

/** The names of the secrets of each global connection, by provider key. */
export const getGlobalExternalSecrets = async (
	context: IRestApiContext,
): Promise<SecretCompletionsResponse> => {
	return await makeRestApiRequest(context, 'GET', '/secret-providers/completions/secrets/global');
};

/** The names of the secrets of each global connection, for a user of the project. */
export const getGlobalExternalSecretsForProject = async (
	context: IRestApiContext,
	projectId: string,
): Promise<SecretCompletionsResponse> => {
	return await makeRestApiRequest(
		context,
		'GET',
		`/secret-providers/completions/secrets/global/${projectId}`,
	);
};

/** The names of the secrets of each connection of the project, by provider key. */
export const getProjectExternalSecrets = async (
	context: IRestApiContext,
	projectId: string,
): Promise<SecretCompletionsResponse> => {
	return await makeRestApiRequest(
		context,
		'GET',
		`/secret-providers/completions/secrets/project/${projectId}`,
	);
};

export const getExternalSecretsProviders = async (
	context: IRestApiContext,
): Promise<ExternalSecretsProvider[]> => {
	return await makeRestApiRequest(context, 'GET', '/external-secrets/providers');
};

/** One provider type, with the fields of its form. */
export const getExternalSecretsProvider = async (
	context: IRestApiContext,
	id: string,
): Promise<ExternalSecretsProvider> => {
	return await makeRestApiRequest(context, 'GET', `/external-secrets/providers/${id}`);
};

/**
 * Test settings of a provider type. A failed test is an error with status 400. Without settings,
 * the request has no body.
 */
export const testExternalSecretsProviderConnection = async (
	context: IRestApiContext,
	id: string,
	data?: ProviderSettings,
): Promise<{ success: boolean; testState: ExternalSecretsProviderState; error?: string }> => {
	return await makeRestApiRequest(context, 'POST', `/external-secrets/providers/${id}/test`, data);
};

/** Store the settings of a provider type. Without settings, the request has no body. */
export const updateProvider = async (
	context: IRestApiContext,
	id: string,
	data?: ProviderSettings,
): Promise<boolean> => {
	return await makeRestApiRequest(context, 'POST', `/external-secrets/providers/${id}`, data);
};

/** Read the secrets of a connected provider again. */
export const reloadProvider = async (
	context: IRestApiContext,
	id: string,
): Promise<{ updated: boolean }> => {
	return await makeRestApiRequest(context, 'POST', `/external-secrets/providers/${id}/update`);
};

/** Connect or disconnect a provider. */
export const connectProvider = async (
	context: IRestApiContext,
	id: string,
	connected: boolean,
): Promise<boolean> => {
	return await makeRestApiRequest(context, 'POST', `/external-secrets/providers/${id}/connect`, {
		connected,
	});
};

/** Give the project admin and editor roles the scopes of external secrets, or take them away. */
export const updateExternalSecretsSettings = async (
	context: IRestApiContext,
	settings: { systemRolesEnabled: boolean },
): Promise<{ systemRolesEnabled: boolean }> => {
	return await makeRestApiRequest(context, 'POST', '/external-secrets/settings', settings);
};
