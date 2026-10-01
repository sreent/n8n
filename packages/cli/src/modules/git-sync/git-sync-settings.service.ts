import { Logger } from '@n8n/backend-common';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';
import { Cipher } from 'n8n-core';
import { createHash } from 'node:crypto';

import { GIT_SYNC_CONNECTION_KEY, GIT_SYNC_STATE_KEY } from './git-sync.constants';
import {
	storedConnectionSchema,
	storedStateSchema,
	type GitSyncConnection,
	type StoredConnection,
	type StoredState,
} from './git-sync.types';

/** The connection fields that decide which content the sync state belongs to. */
type FingerprintFields = Pick<
	StoredConnection,
	'repositoryUrl' | 'branch' | 'directory' | 'projectId'
>;

export function connectionFingerprint(fields: FingerprintFields): string {
	return createHash('sha256')
		.update(
			JSON.stringify([fields.repositoryUrl, fields.branch, fields.directory, fields.projectId]),
		)
		.digest('hex');
}

export function emptyState(fingerprint: string): StoredState {
	return {
		version: 1,
		fingerprint,
		lastSyncedCommit: null,
		baseline: {},
		lastPush: null,
		lastPull: null,
	};
}

/**
 * Reads and writes the Git sync rows in the settings table. The rows are not
 * loaded at startup. The access token is encrypted with the instance key.
 */
@Service()
export class GitSyncSettingsService {
	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly cipher: Cipher,
		private readonly logger: Logger,
	) {
		this.logger = this.logger.scoped('git-sync');
	}

	async getConnection(): Promise<StoredConnection | null> {
		return await this.readRow(GIT_SYNC_CONNECTION_KEY, (value) =>
			storedConnectionSchema.parse(value),
		);
	}

	/** The connection with the token decrypted. Use it only to run Git. */
	async getDecryptedConnection(): Promise<GitSyncConnection | null> {
		const stored = await this.getConnection();
		if (!stored) return null;

		const { encryptedToken, version: _version, ...rest } = stored;
		const token = encryptedToken ? await this.cipher.decryptV2(encryptedToken) : null;
		return { ...rest, token };
	}

	async encryptToken(token: string): Promise<string> {
		return await this.cipher.encryptV2(token);
	}

	async saveConnection(connection: StoredConnection): Promise<void> {
		await this.settingsRepository.upsertByKey(
			GIT_SYNC_CONNECTION_KEY,
			JSON.stringify(storedConnectionSchema.parse(connection)),
			false,
			{},
		);
	}

	/** Returns the state for the connection, or an empty state when the stored one belongs to another connection. */
	async getState(fingerprint: string): Promise<StoredState> {
		const stored = await this.readRow(GIT_SYNC_STATE_KEY, (value) =>
			storedStateSchema.parse(value),
		);
		return stored?.fingerprint === fingerprint ? stored : emptyState(fingerprint);
	}

	async saveState(state: StoredState): Promise<void> {
		await this.settingsRepository.upsertByKey(
			GIT_SYNC_STATE_KEY,
			JSON.stringify(storedStateSchema.parse(state)),
			false,
			{},
		);
	}

	async deleteState(): Promise<void> {
		await this.settingsRepository.delete({ key: GIT_SYNC_STATE_KEY });
	}

	async deleteAll(): Promise<void> {
		await this.settingsRepository.delete({ key: GIT_SYNC_CONNECTION_KEY });
		await this.deleteState();
	}

	/** A row that cannot be read counts as absent, so a bad row cannot lock the feature. */
	private async readRow<T>(key: string, parse: (value: unknown) => T): Promise<T | null> {
		const row = await this.settingsRepository.findByKey(key);
		if (!row) return null;
		try {
			return parse(jsonParse<unknown>(row.value));
		} catch (error) {
			this.logger.warn(`Ignoring the settings row "${key}" because it is not valid`, { error });
			return null;
		}
	}
}
