import { Logger } from '@n8n/backend-common';
import { SettingsRepository } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cipher, InstanceSettings } from 'n8n-core';
import { jsonParse, UserError } from 'n8n-workflow';
import sshpk from 'sshpk';
import { z } from 'zod';

import { InstanceWriteAccessService } from '@n8n/backend-services';

import {
	SOURCE_CONTROL_DEFAULT_BRANCH,
	SOURCE_CONTROL_GIT_FOLDER,
	SOURCE_CONTROL_HTTPS_CREDENTIALS_DB_KEY,
	SOURCE_CONTROL_KEY_COMMENT,
	SOURCE_CONTROL_KNOWN_HOSTS_FILE,
	SOURCE_CONTROL_PREFERENCES_DB_KEY,
	SOURCE_CONTROL_SSH_FOLDER,
	SOURCE_CONTROL_SSH_KEY_NAME,
	SOURCE_CONTROL_SSH_KEYS_DB_KEY,
	SOURCE_CONTROL_SSH_PRIVATE_KEY_TEMP_FILE,
} from './constants';
import { SourceControlConfig } from './source-control.config';
import type { KeyPairType, SourceControlPreferences } from './types/source-control-preferences';
import { STORED_PREFERENCE_KEYS } from './types/source-control-preferences';

interface StoredKeyPair {
	encryptedPrivateKey: string;
	publicKey: string;
}

interface StoredHttpsCredentials {
	encryptedUsername: string;
	encryptedPassword: string;
}

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The preferences that a request may send. A client may send other keys too: they go. */
const preferencesSchema = z.object({
	connected: z.boolean().optional(),
	// A repository URL does not start with `-`.
	repositoryUrl: z
		.string()
		.refine((url) => !url.startsWith('-'))
		.optional(),
	branchName: z.string().optional(),
	branchReadOnly: z.boolean().optional(),
	branchColor: z.string().regex(HEX_COLOR).optional(),
	publicKey: z.string().optional(),
	initRepo: z.boolean().optional(),
	keyGeneratorType: z.string().optional(),
	connectionType: z.enum(['ssh', 'https']).optional(),
	httpsUsername: z.string().optional(),
	httpsPassword: z.string().optional(),
});

/**
 * Fork code (not in upstream n8n): the preferences of source control, the SSH key pair and the
 * HTTPS credentials. Each has a row in the settings table. See `README.md` in this folder.
 */
@Service()
export class SourceControlPreferencesService {
	private preferences: SourceControlPreferences = {
		branchName: SOURCE_CONTROL_DEFAULT_BRANCH,
		connectionType: 'ssh',
	};

	/** The work folder: a clone of the connected branch. */
	readonly gitFolder: string;

	readonly sshFolder: string;

	readonly sshKeyName: string;

	constructor(
		private readonly instanceSettings: InstanceSettings,
		private readonly logger: Logger,
		private readonly cipher: Cipher,
		private readonly settingsRepository: SettingsRepository,
		private readonly config: SourceControlConfig,
		private readonly instanceWriteAccess: InstanceWriteAccessService,
	) {
		this.gitFolder = path.join(instanceSettings.n8nFolder, SOURCE_CONTROL_GIT_FOLDER);
		this.sshFolder = path.join(instanceSettings.n8nFolder, SOURCE_CONTROL_SSH_FOLDER);
		this.sshKeyName = path.join(this.sshFolder, SOURCE_CONTROL_SSH_KEY_NAME);
		this.logger = logger.scoped('source-control');
	}

	/** The preferences. `connected` is `false` until a connection sets it. */
	getPreferences(): SourceControlPreferences {
		return { ...this.preferences, connected: this.preferences.connected ?? false };
	}

	isSourceControlConnected() {
		return this.preferences.connected ?? false;
	}

	/**
	 * Whether the instance has a connection with a repository and a branch. As in the original,
	 * the value is the branch name when it is true: the telemetry of n8n sends it.
	 */
	isSourceControlSetup() {
		return (
			this.isSourceControlConnected() &&
			this.preferences.repositoryUrl &&
			this.preferences.branchName
		);
	}

	isBranchReadOnly() {
		return this.preferences.branchReadOnly ?? false;
	}

	getBranchName() {
		return this.preferences.branchName ?? '';
	}

	get knownHostsFile() {
		return path.join(this.sshFolder, SOURCE_CONTROL_KNOWN_HOSTS_FILE);
	}

	get privateKeyTempFile() {
		return path.join(this.instanceSettings.n8nFolder, SOURCE_CONTROL_SSH_PRIVATE_KEY_TEMP_FILE);
	}

	/**
	 * Merges `preferences` into the current ones and saves them. The settings row gets only the
	 * stored keys, in a fixed order. The read-only flag of the instance follows `branchReadOnly`.
	 */
	async setPreferences(
		preferences: Partial<SourceControlPreferences>,
		saveToDb = true,
	): Promise<SourceControlPreferences> {
		const { httpsUsername, httpsPassword } = preferences;
		const merged: SourceControlPreferences = { ...this.preferences };
		for (const key of STORED_PREFERENCE_KEYS) {
			if (preferences[key] !== undefined) Object.assign(merged, { [key]: preferences[key] });
		}
		this.preferences = merged;
		this.instanceWriteAccess.setReadOnly(this.isBranchReadOnly());

		if (saveToDb) {
			await this.saveSetting(SOURCE_CONTROL_PREFERENCES_DB_KEY, this.storedPreferences());
			if (httpsUsername && httpsPassword) {
				await this.saveHttpsCredentials(httpsUsername, httpsPassword);
			}
		}
		return this.getPreferences();
	}

	/** Reads the preferences from the settings table. The read-only flag of the instance follows. */
	async loadPreferences() {
		const row = await this.settingsRepository.findByKey(SOURCE_CONTROL_PREFERENCES_DB_KEY);
		if (row) {
			const stored = jsonParse<SourceControlPreferences>(row.value, { fallbackValue: {} });
			this.preferences = { ...this.preferences, ...stored };
		}
		this.instanceWriteAccess.setReadOnly(this.isBranchReadOnly());
		return this.getPreferences();
	}

	/** Reads the preferences, and makes a key pair when there is none. */
	async loadFromDbAndApplySourceControlPreferences() {
		await this.loadPreferences();
		const keyPair = await this.settingsRepository.findByKey(SOURCE_CONTROL_SSH_KEYS_DB_KEY);
		if (!keyPair) await this.generateAndSaveKeyPair();
		return this.getPreferences();
	}

	/** Another instance changed the preferences. */
	@OnPubSubEvent('reload-source-control-config')
	async reloadPreferences() {
		await this.loadPreferences();
	}

	/**
	 * Reads the preferences of a request. A value of a wrong type, a connection type other than
	 * `ssh` or `https` and a color that is not hexadecimal are errors.
	 */
	parseSourceControlPreferences(body: unknown): Partial<SourceControlPreferences> {
		// A key with `null` counts as a key without a value.
		const input =
			typeof body === 'object' && body !== null
				? Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null))
				: {};
		const result = preferencesSchema.safeParse(input);
		if (!result.success) throw new UserError('Invalid source control preferences');
		return result.data;
	}

	// #region Key pair

	/**
	 * Makes a new key pair and saves it. Without a type, the type of the preferences is used, then
	 * `N8N_SOURCECONTROL_DEFAULT_SSH_KEY_TYPE`. The preferences keep the given type, also a type
	 * that is not `ed25519` or `rsa`; such a type makes an RSA key, as in the original.
	 */
	async generateAndSaveKeyPair(keyPairType?: string): Promise<SourceControlPreferences> {
		const type = keyPairType ?? this.preferences.keyGeneratorType ?? this.config.defaultKeyPairType;
		const { privateKey, publicKey } = this.generateKeyPair(type === 'ed25519' ? 'ed25519' : 'rsa');
		await this.saveSetting(SOURCE_CONTROL_SSH_KEYS_DB_KEY, {
			encryptedPrivateKey: await this.cipher.encryptV2(privateKey),
			publicKey,
		} satisfies StoredKeyPair);
		return await this.setPreferences({ keyGeneratorType: type });
	}

	async getPublicKey(): Promise<string> {
		const keyPair = await this.getKeyPair();
		return keyPair?.publicKey ?? '';
	}

	/** Writes the private key to a file that only n8n can read, for the ssh program of Git. */
	async getPrivateKeyPath(): Promise<string> {
		const keyPair = await this.getKeyPair();
		if (!keyPair) throw new UserError('No SSH key pair found');
		const privateKey = await this.cipher.decryptV2(keyPair.encryptedPrivateKey);
		const file = this.privateKeyTempFile;
		await rm(file, { force: true });
		await writeFile(file, privateKey, { encoding: 'utf8', mode: 0o600 });
		return file;
	}

	/** Makes the folder of `known_hosts`. */
	async ensureSshFolder() {
		await mkdir(this.sshFolder, { recursive: true });
	}

	private async getKeyPair(): Promise<StoredKeyPair | null> {
		const row = await this.settingsRepository.findByKey(SOURCE_CONTROL_SSH_KEYS_DB_KEY);
		if (!row) return null;
		return jsonParse<StoredKeyPair | null>(row.value, { fallbackValue: null });
	}

	/** An OpenSSH key pair: an ed25519 key, or an RSA key of 4096 bits. */
	private generateKeyPair(type: KeyPairType) {
		const pair =
			type === 'ed25519'
				? generateKeyPairSync('ed25519')
				: generateKeyPairSync('rsa', { modulusLength: 4096 });
		const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
		const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
		const parsedPrivateKey = sshpk.parsePrivateKey(privatePem, 'pem');
		parsedPrivateKey.comment = SOURCE_CONTROL_KEY_COMMENT;
		const privateKey = parsedPrivateKey.toString('ssh');
		const parsedPublicKey = sshpk.parseKey(publicPem, 'pem');
		parsedPublicKey.comment = SOURCE_CONTROL_KEY_COMMENT;
		return { privateKey, publicKey: parsedPublicKey.toString('ssh') };
	}

	// #endregion

	// #region HTTPS credentials

	async saveHttpsCredentials(username: string, password: string) {
		await this.saveSetting(SOURCE_CONTROL_HTTPS_CREDENTIALS_DB_KEY, {
			encryptedUsername: await this.cipher.encryptV2(username),
			encryptedPassword: await this.cipher.encryptV2(password),
		} satisfies StoredHttpsCredentials);
	}

	/** The HTTPS user name and password. A missing row is an error. */
	async getDecryptedHttpsCredentials(): Promise<{ username: string; password: string }> {
		const row = await this.settingsRepository.findByKey(SOURCE_CONTROL_HTTPS_CREDENTIALS_DB_KEY);
		const stored = row
			? jsonParse<StoredHttpsCredentials | null>(row.value, { fallbackValue: null })
			: null;
		if (!stored) throw new UserError('No credentials found for https connection');
		return {
			username: await this.cipher.decryptV2(stored.encryptedUsername),
			password: await this.cipher.decryptV2(stored.encryptedPassword),
		};
	}

	async deleteHttpsCredentials() {
		await this.settingsRepository.delete({ key: SOURCE_CONTROL_HTTPS_CREDENTIALS_DB_KEY });
	}

	// #endregion

	private storedPreferences() {
		const stored: Record<string, unknown> = {};
		for (const key of STORED_PREFERENCE_KEYS) {
			if (this.preferences[key] !== undefined) stored[key] = this.preferences[key];
		}
		return stored;
	}

	private async saveSetting(key: string, value: object) {
		await this.settingsRepository.save(
			{ key, value: JSON.stringify(value), loadOnStartup: true },
			{ transaction: false },
		);
		this.logger.debug('Saved source control setting', { key });
	}
}
