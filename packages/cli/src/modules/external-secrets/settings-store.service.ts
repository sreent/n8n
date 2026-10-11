import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';

import type { ExternalSecretsSettings } from './types';

/** The key of the setting that holds the settings of the providers, encrypted. */
export const EXTERNAL_SECRETS_SETTINGS_KEY = 'feature.externalSecrets';

/**
 * Fork code (not in upstream n8n). The stored settings of the providers in the mode with one
 * setting for each provider type: one encrypted JSON object in the settings table.
 */
@Service()
export class ExternalSecretsSettingsStore {
	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly cipher: Cipher,
	) {}

	/** Read the stored settings again. `null` when there are none. */
	async reload(): Promise<ExternalSecretsSettings | null> {
		const row = await this.settingsRepository.findByKey(EXTERNAL_SECRETS_SETTINGS_KEY);
		if (!row) return null;
		return jsonParse<ExternalSecretsSettings>(await this.cipher.decryptV2(row.value));
	}

	async save(settings: ExternalSecretsSettings) {
		await this.settingsRepository.upsert(
			{
				key: EXTERNAL_SECRETS_SETTINGS_KEY,
				value: await this.cipher.encryptV2(settings),
				loadOnStartup: false,
			},
			['key'],
		);
	}
}
