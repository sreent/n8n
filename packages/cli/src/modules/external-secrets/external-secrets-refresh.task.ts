import { instanceTarget, intervalFromSeconds, SystemTask } from '@n8n/decorators';
import type { SystemTaskSchedule } from '@n8n/decorators';

import { ExternalSecretsConfig } from './external-secrets.config';
import { ExternalSecretsSecretsCache } from './secrets-cache.service';

/**
 * Fork code (not in upstream n8n). Reads the secrets of the connected providers again at each
 * update interval (`N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL`).
 */
@SystemTask()
export class ExternalSecretsRefreshTask implements SystemTask {
	readonly name = 'external-secrets-refresh';

	readonly schedule: SystemTaskSchedule = intervalFromSeconds(this.config.updateInterval);

	/** Each process keeps the secrets of its own providers, so no other instance can read them. */
	readonly target = instanceTarget(['main', 'worker', 'webhook']);

	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly secretsCache: ExternalSecretsSecretsCache,
	) {}

	async run(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		await this.secretsCache.refreshAll();
	}
}
