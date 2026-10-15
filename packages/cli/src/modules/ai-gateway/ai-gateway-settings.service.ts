import { Logger } from '@n8n/backend-common';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';
import { z } from 'zod';

import { AZURE_DEPLOYMENT_NAME, GOOGLE_CLOUD_PROJECT, VERTEX_LOCATION } from './backends';

/** The key of the settings row. */
export const AI_GATEWAY_SETTINGS_KEY = 'fork.aiGateway';

/** Other processes read changed settings after this time. */
const REFRESH_INTERVAL_MS = 30_000;

const amount = z.number().finite().min(0).max(1_000_000_000);

export const aiGatewayPriceSchema = z.object({
	input: amount,
	output: amount,
	cachedInput: amount.optional(),
});

export const aiGatewayProviderSettingsSchema = z.object({
	credentialId: z.string().min(1).max(36),
	/** The type of the credential. The backend sets it when an admin saves the settings. */
	credentialType: z.string().max(128).optional(),
	/** Vertex AI: the project of Google Cloud. The default comes from the e-mail of the service account. */
	projectId: z.string().regex(GOOGLE_CLOUD_PROJECT).optional(),
	/** Vertex AI: the location. The default is the region of the credential. */
	location: z.string().regex(VERTEX_LOCATION).optional(),
	/** Azure OpenAI: the names of the deployments, which the model list of the nodes shows. */
	deployments: z.array(z.string().regex(AZURE_DEPLOYMENT_NAME)).max(100).optional(),
});

export type AiGatewayProviderSettings = z.infer<typeof aiGatewayProviderSettingsSchema>;

export const aiGatewaySettingsSchema = z.object({
	enabled: z.boolean(),
	/** The credential of the admin for each provider slug, and the options of its backend. */
	providers: z.record(z.string(), aiGatewayProviderSettingsSchema),
	/** Dollars for each month, for the whole instance. */
	monthlyBudget: amount,
	/** Dollars for each month and user, or `null` for no limit. */
	userMonthlyLimit: amount.nullable(),
	/** Dollars for each month, by project id. */
	projectBudgets: z.record(z.string().max(36), amount),
	/** The prices of the admin: provider slug, then model. */
	prices: z.record(z.string(), z.record(z.string().min(1).max(255), aiGatewayPriceSchema)),
});

export type AiGatewaySettings = z.infer<typeof aiGatewaySettingsSchema>;

export const DEFAULT_AI_GATEWAY_SETTINGS: AiGatewaySettings = {
	enabled: false,
	providers: {},
	monthlyBudget: 0,
	userMonthlyLimit: null,
	projectBudgets: {},
	prices: {},
};

/**
 * The settings of the AI gateway, kept in the table `settings`. Each process keeps a copy and reads
 * it again every 30 seconds, so that a worker sees the changes of an admin.
 */
@Service()
export class AiGatewaySettingsService {
	private settings: AiGatewaySettings = DEFAULT_AI_GATEWAY_SETTINGS;

	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly logger: Logger,
	) {}

	/** Reads the settings, and reads them again every 30 seconds. */
	async init() {
		await this.reload();
		this.refreshTimer = setInterval(() => {
			void this.reload().catch((error: unknown) => {
				this.logger.warn('Failed to read the settings of the AI gateway', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, REFRESH_INTERVAL_MS);
		this.refreshTimer.unref();
	}

	shutdown() {
		clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	/** The settings that this process knows. */
	current(): AiGatewaySettings {
		return this.settings;
	}

	async reload() {
		const row = await this.settingsRepository.findByKey(AI_GATEWAY_SETTINGS_KEY);
		this.settings = this.parse(row?.value);
		return this.settings;
	}

	async save(settings: AiGatewaySettings) {
		const valid = aiGatewaySettingsSchema.parse(settings);
		await this.settingsRepository.upsertByKey(
			AI_GATEWAY_SETTINGS_KEY,
			JSON.stringify(valid),
			false,
			{},
		);
		this.settings = valid;
		return valid;
	}

	private parse(value: string | undefined): AiGatewaySettings {
		if (!value) return DEFAULT_AI_GATEWAY_SETTINGS;
		const parsed = aiGatewaySettingsSchema.safeParse(
			jsonParse(value, { fallbackValue: undefined }),
		);
		if (parsed.success) return parsed.data;
		this.logger.warn('The settings of the AI gateway are not valid. The gateway stays off.');
		return DEFAULT_AI_GATEWAY_SETTINGS;
	}
}
