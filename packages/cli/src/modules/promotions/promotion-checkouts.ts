import { Service } from '@n8n/di';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InstanceSettings } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';
import { z } from 'zod';

import type { PromotionConfig } from './database/entities/promotion-config.entity';
import type { PromotionConnection } from './database/entities/promotion-connection.entity';
import { PROMOTION_CONFIGS_FOLDER } from './promotions.constants';

/** What a clone wrote: the remote and the branch of the checkout. */
const cacheSchema = z.object({
	schemaVersion: z.literal(1),
	connectionId: z.string(),
	configId: z.string(),
	remoteUrl: z.string(),
	checkoutBranchName: z.string(),
});

type CheckoutCache = z.infer<typeof cacheSchema>;

/** The branch of a configuration: the apply branch, or the base branch of a promotion. */
export function checkoutBranchOf(config: PromotionConfig) {
	return 'branchName' in config.settings
		? config.settings.branchName
		: config.settings.baseBranchName;
}

/**
 * Fork code (not in upstream n8n): the local checkouts of the configurations of Git connections.
 * Each configuration has the folder `<n8n folder>/promotions/configs/<configuration id>/` with the
 * Git checkout in `repository/`, the remote and the branch of the clone in `cache.json`, and the
 * known SSH hosts in `.ssh/known_hosts`.
 */
@Service()
export class PromotionCheckouts {
	constructor(private readonly instanceSettings: InstanceSettings) {}

	folder(configId: string) {
		return path.join(this.instanceSettings.n8nFolder, ...PROMOTION_CONFIGS_FOLDER, configId);
	}

	repository(configId: string) {
		return path.join(this.folder(configId), 'repository');
	}

	knownHostsFile(configId: string) {
		return path.join(this.folder(configId), '.ssh', 'known_hosts');
	}

	private cacheFile(configId: string) {
		return path.join(this.folder(configId), 'cache.json');
	}

	private async readCache(configId: string): Promise<CheckoutCache | undefined> {
		try {
			const parsed = cacheSchema.safeParse(
				jsonParse(await readFile(this.cacheFile(configId), 'utf-8')),
			);
			return parsed.success ? parsed.data : undefined;
		} catch {
			return undefined;
		}
	}

	/** Whether this instance has a checkout, and whether it has the remote and the branch of the configuration. */
	async state(connection: PromotionConnection, config: PromotionConfig) {
		const cache = await this.readCache(config.id);
		const hasCheckout = cache !== undefined && existsSync(this.repository(config.id));
		return {
			hasCheckout,
			matchesConfig:
				hasCheckout &&
				cache.connectionId === connection.id &&
				cache.remoteUrl === connection.target.remoteUrl &&
				cache.checkoutBranchName === checkoutBranchOf(config),
		};
	}

	/** Removes the checkout before a new clone. */
	async clear(configId: string) {
		await rm(this.cacheFile(configId), { force: true });
		await rm(this.repository(configId), { recursive: true, force: true });
	}

	async writeCache(connection: PromotionConnection, config: PromotionConfig) {
		const cache: CheckoutCache = {
			schemaVersion: 1,
			connectionId: connection.id,
			configId: config.id,
			remoteUrl: connection.target.remoteUrl,
			checkoutBranchName: checkoutBranchOf(config),
		};
		await writeFile(this.cacheFile(config.id), JSON.stringify(cache));
	}

	/** Removes the folder of a configuration, with its known hosts. */
	async remove(configId: string) {
		await rm(this.folder(configId), { recursive: true, force: true });
	}
}
