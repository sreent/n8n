// Fork code (not in upstream n8n): the REST API of the page Settings > Gateway credits admin
// (`/rest/ai-gateway`), for the backend module and the editor module. See
// packages/cli/src/modules/ai-gateway/README.md.
import { z } from 'zod';

import type { AiGatewayUsageEntry } from '../ai/ai-gateway-usage-response.dto';
import {
	dateTimeQueryParamSchema,
	wholeNumberQueryParamSchema,
} from '../../schemas/fork-query-params.schema';
import { Z } from '../../zod-class';

/** The name of an Azure OpenAI deployment, which the calls send as the model. */
export const AI_GATEWAY_AZURE_DEPLOYMENT_NAME = /^[\w.-]{1,64}$/;

/** A location of Vertex AI, for example `global`, `us`, `eu` or `europe-west4`. */
export const AI_GATEWAY_VERTEX_LOCATION = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

/** A project of Google Cloud: its id, an id with a domain, or its number. */
export const AI_GATEWAY_GOOGLE_CLOUD_PROJECT = /^([a-z][a-z0-9.:-]{4,61}[a-z0-9]|\d{1,20})$/;

/**
 * An entry of the processors of Document AI that the gateway serves: a project, a location of a
 * project, or one processor (`projects/<project>/locations/<location>/processors/<ID>`).
 */
export const AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY =
	/^projects\/([a-z][a-z0-9.:-]{4,61}[a-z0-9]|\d{1,20})(\/locations\/[a-z][a-z0-9-]{0,30}[a-z0-9](\/processors\/[\w-]{1,64})?)?$/;

/** The default and the largest page size of the list of calls. */
export const AI_GATEWAY_USAGE_DEFAULT_PAGE_SIZE = 50;
export const AI_GATEWAY_USAGE_MAX_PAGE_SIZE = 250;

const amount = z.number().finite().min(0).max(1_000_000_000);

/** A price in US dollars for one million tokens, or for one thousand pages of the OCR. */
export const aiGatewayPriceSchema = z.object({
	input: amount,
	output: amount,
	cachedInput: amount.optional(),
});

/** The open models of Vertex AI behind the provider OpenAI: a service account and its target. */
export const aiGatewayOpenModelsSchema = z.object({
	credentialId: z.string().min(1).max(36),
	/** The type of the credential. The backend sets it when an admin saves the settings. */
	credentialType: z.string().max(128).optional(),
	projectId: z.string().regex(AI_GATEWAY_GOOGLE_CLOUD_PROJECT).optional(),
	location: z.string().regex(AI_GATEWAY_VERTEX_LOCATION).optional(),
});

export const aiGatewayProviderSettingsSchema = z.object({
	credentialId: z.string().min(1).max(36),
	/** The type of the credential. The backend sets it when an admin saves the settings. */
	credentialType: z.string().max(128).optional(),
	/** Vertex AI: the project of Google Cloud. The default comes from the e-mail of the service account. */
	projectId: z.string().regex(AI_GATEWAY_GOOGLE_CLOUD_PROJECT).optional(),
	/** Vertex AI: the location. The default is the region of the credential. */
	location: z.string().regex(AI_GATEWAY_VERTEX_LOCATION).optional(),
	/** Azure OpenAI: the names of the deployments, which the model list of the nodes shows. */
	deployments: z.array(z.string().regex(AI_GATEWAY_AZURE_DEPLOYMENT_NAME)).max(100).optional(),
	/**
	 * Google Cloud OCR with a service account: the projects, locations and processors of Document
	 * AI that the gateway serves. Without a list, it serves all processors of the service account.
	 */
	documentAiProcessors: z
		.array(z.string().regex(AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY))
		.max(100)
		.optional(),
	/** OpenAI with an OpenAI or Azure credential: a model of a publisher goes to Vertex AI. */
	openModels: aiGatewayOpenModelsSchema.optional(),
});

export const aiGatewaySettingsSchema = z.object({
	enabled: z.boolean(),
	/** The credential of the admin for each provider slug, and the options of its backend. */
	providers: z.record(z.string(), aiGatewayProviderSettingsSchema),
	/** Dollars for each month, for the whole instance. It starts again on the first day (UTC). */
	monthlyBudget: amount,
	/** Dollars for each month and user, or `null` for no limit. */
	userMonthlyLimit: amount.nullable(),
	/** Dollars for each month, by project id. */
	projectBudgets: z.record(z.string().max(36), amount),
	/** The prices of the admin: provider slug, then model. They replace the list prices. */
	prices: z.record(z.string(), z.record(z.string().min(1).max(255), aiGatewayPriceSchema)),
	/**
	 * Whether the gateway records an estimate for an answer without usage or that stopped early.
	 * Off, such an answer costs nothing. Settings from before this switch have it on.
	 */
	estimateUsage: z.boolean().default(true),
});

export type AiGatewayPrice = z.infer<typeof aiGatewayPriceSchema>;
export type AiGatewayOpenModelsSettings = z.infer<typeof aiGatewayOpenModelsSchema>;
export type AiGatewayProviderSettings = z.infer<typeof aiGatewayProviderSettingsSchema>;
export type AiGatewaySettings = z.infer<typeof aiGatewaySettingsSchema>;
/** The prices of the models of each provider, by provider slug and model. */
export type AiGatewayPrices = AiGatewaySettings['prices'];

export class AiGatewaySettingsDto extends Z.class(aiGatewaySettingsSchema.shape) {}

export class AiGatewayTopUpDto extends Z.class({
	amount: z.number().finite().positive().max(1_000_000),
	note: z.string().trim().max(255).optional(),
}) {}

export class AiGatewayAdminUsageQueryDto extends Z.class({
	from: dateTimeQueryParamSchema.optional(),
	to: dateTimeQueryParamSchema.optional(),
	userId: z.string().trim().min(1).max(36).optional(),
	projectId: z.string().trim().min(1).max(36).optional(),
	provider: z.string().trim().min(1).max(64).optional(),
	model: z.string().trim().min(1).max(255).optional(),
	skip: wholeNumberQueryParamSchema(0, 0),
	take: wholeNumberQueryParamSchema(
		AI_GATEWAY_USAGE_DEFAULT_PAGE_SIZE,
		1,
		AI_GATEWAY_USAGE_MAX_PAGE_SIZE,
	),
}) {}

export interface AiGatewayOption {
	id: string;
	name: string;
}

export interface AiGatewayCredentialOption extends AiGatewayOption {
	/** The credential type: the type of the provider, or the type of one of its backends. */
	type: string;
}

/** `vertex-ai` serves the Gemini API, `vertex-openai` the open models of Vertex AI. */
export type AiGatewayBackendKind = 'azure-openai' | 'vertex-ai' | 'vertex-openai' | 'google-cloud';

/** Another service that serves the API of a provider, with another credential type. */
export interface AiGatewayBackendInfo {
	kind: AiGatewayBackendKind;
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

/** The answer of `GET` and `PUT /rest/ai-gateway/settings`. */
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

/** The answer of `GET /rest/ai-gateway/overview` and `POST /rest/ai-gateway/top-ups`. */
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

/** A top-up of the wallet, in the answer of `GET /rest/ai-gateway/top-ups`. */
export interface AiGatewayTopUpEntry {
	id: string;
	/** In ISO 8601. */
	createdAt: string;
	amount: number;
	createdById: string | null;
	createdByEmail: string | null;
	note: string | null;
}

/** The answer of `GET /rest/ai-gateway/prices`. */
export interface AiGatewayPriceTable {
	/** The date when the fork read the list prices. */
	listPricesDate: string;
	listPrices: AiGatewayPrices;
	adminPrices: AiGatewayPrices;
}

/** One call in the answer of `GET /rest/ai-gateway/usage`. */
export interface AiGatewayAdminUsageEntry extends AiGatewayUsageEntry {
	id: string;
	cachedInputTokens: number;
	costFromTopUp: number;
	/** The gateway estimated the tokens, because the answer did not report them all. */
	estimated?: boolean;
	userId: string | null;
	userEmail: string | null;
	projectId: string | null;
	projectName: string | null;
}

/** The answer of `GET /rest/ai-gateway/usage`. */
export interface AiGatewayAdminUsagePage {
	/** The number of all calls that match the filters. */
	count: number;
	/** One page of the calls, newest first. */
	entries: AiGatewayAdminUsageEntry[];
}
