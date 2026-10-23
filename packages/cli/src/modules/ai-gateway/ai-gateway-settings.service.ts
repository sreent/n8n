import { aiGatewaySettingsSchema, type AiGatewaySettings } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';

/** The key of the settings row. */
export const AI_GATEWAY_SETTINGS_KEY = 'fork.aiGateway';

/** Other processes read changed settings after this time. */
const REFRESH_INTERVAL_MS = 30_000;

export const DEFAULT_AI_GATEWAY_SETTINGS: AiGatewaySettings = {
	enabled: false,
	providers: {},
	monthlyBudget: 0,
	userMonthlyLimit: null,
	projectBudgets: {},
	prices: {},
	estimateUsage: true,
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
	) {
		this.logger = this.logger.scoped('ai-gateway');
	}

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
