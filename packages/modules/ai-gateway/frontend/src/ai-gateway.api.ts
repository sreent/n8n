import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** A price in US dollars for one million tokens. */
export interface AiGatewayPrice {
	input: number;
	output: number;
	cachedInput?: number;
}

/** The prices of the models of each provider, by provider slug and model. */
export type AiGatewayPrices = Record<string, Record<string, AiGatewayPrice>>;

/** The credential of a provider, and the options of its backend. */
export interface AiGatewayProviderSettings {
	credentialId: string;
	/** The type of the credential. The backend sets it on each save. */
	credentialType?: string;
	/** Vertex AI: the project of Google Cloud. Empty takes it from the service account. */
	projectId?: string;
	/** Vertex AI: the location. Empty takes the region of the credential. */
	location?: string;
	/** Azure OpenAI: the names of the deployments, which the model list of the nodes shows. */
	deployments?: string[];
	/**
	 * Google Cloud OCR with a service account: the projects, locations and processors of Document
	 * AI that the gateway serves. Empty serves all processors of the service account.
	 */
	documentAiProcessors?: string[];
	/** OpenAI with an OpenAI or Azure credential: a model of a publisher goes to Vertex AI. */
	openModels?: AiGatewayOpenModelsSettings;
}

/** The open models of Vertex AI behind the provider OpenAI: a service account and its target. */
export interface AiGatewayOpenModelsSettings {
	credentialId: string;
	credentialType?: string;
	projectId?: string;
	location?: string;
}

export interface AiGatewaySettings {
	enabled: boolean;
	/** The credential that the gateway uses for each provider, by provider slug. */
	providers: Record<string, AiGatewayProviderSettings>;
	/** In US dollars. It starts again on the first day of each month (UTC). */
	monthlyBudget: number;
	/** In US dollars, the same for each user. `null` is no limit. */
	userMonthlyLimit: number | null;
	/** In US dollars, by project id. */
	projectBudgets: Record<string, number>;
	/** The prices that an admin set. They replace the list prices. */
	prices: AiGatewayPrices;
	/** Whether the gateway records an estimate for an answer without usage or that stopped early. */
	estimateUsage: boolean;
}

export interface AiGatewayOption {
	id: string;
	name: string;
}

export interface AiGatewayCredentialOption extends AiGatewayOption {
	/** The credential type: the type of the provider, or the type of one of its backends. */
	type: string;
}

/** Another service that serves the API of a provider, with another credential type. */
export interface AiGatewayBackendInfo {
	/** `vertex-ai` serves the Gemini API, `vertex-openai` the open models of Vertex AI. */
	kind: 'azure-openai' | 'vertex-ai' | 'vertex-openai' | 'google-cloud';
	credentialType: string;
	displayName: string;
}

export interface AiGatewayProviderInfo {
	slug: string;
	displayName: string;
	credentialType: string;
	/** The backends of the provider. A credential of their type sends the calls there. */
	backends: AiGatewayBackendInfo[];
	/** The unit of the usage and the prices: tokens, or the pages and images of the OCR. */
	priceUnit: 'tokens' | 'pages';
	/** The credential that the settings name, or `null` when the provider has none. */
	credential: AiGatewayCredentialOption | null;
	/** The credentials of the type of the provider and of the types of its backends. */
	credentialOptions: AiGatewayCredentialOption[];
}

export interface AiGatewaySettingsResponse {
	settings: AiGatewaySettings;
	providers: AiGatewayProviderInfo[];
	/** The team projects of the instance. */
	projects: AiGatewayOption[];
	/** The URL that the nodes call, or `null` while the gateway is off. */
	baseUrl: string | null;
}

export interface AiGatewayProjectSpend {
	projectId: string;
	/** `null` when the project no longer exists. */
	name: string | null;
	monthlyBudget: number | null;
	spentThisMonth: number;
}

export interface AiGatewayOverview {
	/** The start of the month, in ISO 8601 (UTC). */
	periodStart: string;
	/** The start of the next month, in ISO 8601 (UTC). */
	periodEnd: string;
	monthlyBudget: number;
	spentThisMonth: number;
	/** The part of the spend of the month that the monthly budget paid. */
	spentFromBudget: number;
	budgetLeft: number;
	topUpBalance: number;
	/** What the calls can still spend: the rest of the monthly budget and the top-ups. */
	remaining: number;
	userMonthlyLimit: number | null;
	projects: AiGatewayProjectSpend[];
	spentWithoutProject: number;
}

export interface AiGatewayTopUp {
	id: string;
	/** In ISO 8601. */
	createdAt: string;
	amount: number;
	createdById: string | null;
	createdByEmail: string | null;
	note: string | null;
}

export interface AiGatewayPriceTable {
	/** The date when the fork read the list prices. */
	listPricesDate: string;
	listPrices: AiGatewayPrices;
	adminPrices: AiGatewayPrices;
}

export interface AiGatewayUsageRow {
	id: string;
	/** In milliseconds since 1970. */
	timestamp: number;
	provider: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens: number;
	cost: number;
	costFromTopUp: number;
	/** The gateway estimated the tokens, because the answer did not report them all. */
	estimated?: boolean;
	userId: string | null;
	userEmail: string | null;
	projectId: string | null;
	projectName: string | null;
	metadata?: { executionId?: string; workflowId?: string; projectId?: string; agentId?: string };
}

export interface AiGatewayUsagePage {
	/** The number of all calls that match the filters. */
	count: number;
	/** One page of the calls, newest first. */
	entries: AiGatewayUsageRow[];
}

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

export async function getAiGatewayTopUps(context: IRestApiContext): Promise<AiGatewayTopUp[]> {
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
): Promise<AiGatewayUsagePage> {
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
