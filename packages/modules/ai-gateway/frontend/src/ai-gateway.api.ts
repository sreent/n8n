import type {
	AiGatewayAdminUsagePage,
	AiGatewayOverview,
	AiGatewayPriceTable,
	AiGatewaySettings,
	AiGatewaySettingsResponse,
	AiGatewayTopUpEntry,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The filters of the list of calls. The backend uses each filter that is set. */
export interface AiGatewayUsageFilters {
	provider?: string;
	projectId?: string;
	model?: string;
}

export async function getAiGatewaySettings(
	context: IRestApiContext,
): Promise<AiGatewaySettingsResponse> {
	return await makeRestApiRequest(context, 'GET', '/ai-gateway/settings');
}

export async function updateAiGatewaySettings(
	context: IRestApiContext,
	settings: AiGatewaySettings,
): Promise<AiGatewaySettingsResponse> {
	return await makeRestApiRequest(context, 'PUT', '/ai-gateway/settings', { ...settings });
}

export async function getAiGatewayOverview(context: IRestApiContext): Promise<AiGatewayOverview> {
	return await makeRestApiRequest(context, 'GET', '/ai-gateway/overview');
}

export async function getAiGatewayTopUps(context: IRestApiContext): Promise<AiGatewayTopUpEntry[]> {
	return await makeRestApiRequest(context, 'GET', '/ai-gateway/top-ups');
}

export async function addAiGatewayTopUp(
	context: IRestApiContext,
	topUp: { amount: number; note?: string },
): Promise<AiGatewayOverview> {
	return await makeRestApiRequest(context, 'POST', '/ai-gateway/top-ups', topUp);
}

export async function getAiGatewayPrices(context: IRestApiContext): Promise<AiGatewayPriceTable> {
	return await makeRestApiRequest(context, 'GET', '/ai-gateway/prices');
}

export async function getAiGatewayUsage(
	context: IRestApiContext,
	filters: AiGatewayUsageFilters,
	skip: number,
	take: number,
): Promise<AiGatewayAdminUsagePage> {
	const defined: Record<string, string> = {};
	for (const [key, value] of Object.entries(filters)) {
		if (typeof value === 'string' && value.trim()) defined[key] = value.trim();
	}
	return await makeRestApiRequest(context, 'GET', '/ai-gateway/usage', {
		...defined,
		skip,
		take,
	});
}
