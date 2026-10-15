// Fork code (not in upstream n8n): the requests of the editor of Git connections. The editor uses
// the public API of the fork module with the session of the user (`/api/v1/promotions`), and one
// REST route for the change list of a project. See `FORK.md` in this folder.
import type { IRestApiContext, PublicApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest, request } from '@n8n/rest-api-client';

import type {
	ApplyResult,
	PromoteResult,
	PromotionApplySource,
	PromotionChangeList,
	PromotionCheckout,
	PromotionConnection,
	PromotionConnectionSummary,
	PromotionDirection,
	PromotionPage,
	PromotionProvider,
	PromotionProviderCreated,
	PromotionProviderSummary,
	PromotionSshKeyType,
} from './promotions.types';

type QueryValue = string | undefined;

/** All pages of a list of the public API. */
async function listAll<T>(
	context: PublicApiContext,
	endpoint: string,
	query: Record<string, QueryValue> = {},
): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const page: PromotionPage<T> = await request({
			method: 'GET',
			baseURL: context.baseUrl,
			endpoint,
			data: { cursor, ...query },
		});
		items.push(...page.data);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return items;
}

const call = async <T>(
	context: PublicApiContext,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	endpoint: string,
	data?: Record<string, unknown>,
): Promise<T> => await request({ method, baseURL: context.baseUrl, endpoint, data });

// #region Providers

export const getProviders = async (context: PublicApiContext) =>
	await listAll<PromotionProviderSummary>(context, '/promotions/providers');

export const getProvider = async (context: PublicApiContext, id: string) =>
	await call<PromotionProvider>(context, 'GET', `/promotions/providers/${id}`);

export type ProviderAuthInput =
	| { authType: 'ssh-key'; keyType?: PromotionSshKeyType }
	| { authType: 'token'; username: string; password: string };

export const createProvider = async (
	context: PublicApiContext,
	input: { name: string; type: 'git'; auth: ProviderAuthInput },
) => await call<PromotionProviderCreated>(context, 'POST', '/promotions/providers', input);

export const updateProvider = async (
	context: PublicApiContext,
	id: string,
	input: { name?: string; auth?: ProviderAuthInput },
) => await call<PromotionProvider>(context, 'PUT', `/promotions/providers/${id}`, input);

export const deleteProvider = async (context: PublicApiContext, id: string) => {
	await call<unknown>(context, 'DELETE', `/promotions/providers/${id}`);
};

// #endregion

// #region Connections

export const getInstanceConnections = async (context: PublicApiContext) =>
	await listAll<PromotionConnectionSummary>(context, '/promotions/connections', {
		scope: 'instance',
	});

export const getProviderConnections = async (context: PublicApiContext, providerId: string) =>
	await listAll<PromotionConnectionSummary>(context, '/promotions/connections', { providerId });

export const getConnection = async (context: PublicApiContext, id: string) =>
	await call<PromotionConnection>(context, 'GET', `/promotions/connections/${id}`);

type ConfigInput = { name?: string; settings: Record<string, unknown> };

export const createConnection = async (
	context: PublicApiContext,
	input: {
		name: string;
		scope: 'instance';
		providerId: string;
		target: { schemaVersion: 1; remoteUrl: string };
		configs: { apply?: ConfigInput; promote?: ConfigInput };
	},
) => await call<PromotionConnection>(context, 'POST', '/promotions/connections', input);

export const updateConnection = async (
	context: PublicApiContext,
	id: string,
	input: { name?: string; providerId?: string; target?: { schemaVersion: 1; remoteUrl: string } },
) => await call<PromotionConnection>(context, 'PUT', `/promotions/connections/${id}`, input);

export const saveConfig = async (
	context: PublicApiContext,
	connectionId: string,
	direction: PromotionDirection,
	input: ConfigInput,
) =>
	await call<NonNullable<PromotionConnection['configs'][PromotionDirection]>>(
		context,
		'PUT',
		`/promotions/connections/${connectionId}/configs/${direction}`,
		input,
	);

export const deleteConfig = async (
	context: PublicApiContext,
	connectionId: string,
	direction: PromotionDirection,
) => {
	await call<unknown>(
		context,
		'DELETE',
		`/promotions/connections/${connectionId}/configs/${direction}`,
	);
};

export const cloneCheckout = async (
	context: PublicApiContext,
	connectionId: string,
	direction: PromotionDirection,
) =>
	await call<PromotionCheckout>(
		context,
		'POST',
		`/promotions/connections/${connectionId}/${direction}/clone`,
	);

export const disconnectCheckout = async (
	context: PublicApiContext,
	connectionId: string,
	direction: PromotionDirection,
) =>
	await call<PromotionCheckout>(
		context,
		'POST',
		`/promotions/connections/${connectionId}/${direction}/disconnect`,
	);

// #endregion

// #region Operations

export const promoteInstance = async (
	context: PublicApiContext,
	connectionId: string,
	commitMessage: string,
) =>
	await call<PromoteResult>(context, 'POST', `/promotions/connections/${connectionId}/promote`, {
		commitMessage,
	});

type ExpectedSource = Pick<PromotionApplySource, 'configId' | 'branchName'> & {
	commitSha: string | null;
};

export const applyPackage = async (
	context: PublicApiContext,
	connectionId: string,
	expectedSource: ExpectedSource,
) =>
	await call<ApplyResult>(context, 'POST', `/promotions/connections/${connectionId}/apply`, {
		expectedSource,
	});

export const continueApplyPackage = async (
	context: PublicApiContext,
	connectionId: string,
	expectedSource: ExpectedSource,
) =>
	await call<ApplyResult>(
		context,
		'POST',
		`/promotions/connections/${connectionId}/apply/continue`,
		{ expectedSource },
	);

/** The changes of a project in one direction. A REST route of the fork module. */
export const getProjectChanges = async (
	context: IRestApiContext,
	projectId: string,
	direction: PromotionDirection,
) =>
	await makeRestApiRequest<PromotionChangeList>(
		context,
		'GET',
		`/promotions/${projectId}/changes/${direction}`,
	);

// #endregion
