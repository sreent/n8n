import { LicenseState, Logger } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import type { LdapConfig } from '@n8n/constants';
import { LDAP_FEATURE_NAME } from '@n8n/constants';
import type { AuthProviderSyncHistory, RunningMode } from '@n8n/db';
import { SettingsRepository, User } from '@n8n/db';
import type { IPasswordAuthHandler } from '@n8n/decorators';
import { AuthHandler } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';
import type { ClientOptions, Entry } from 'ldapts';
import { Client, ResultCodeError } from 'ldapts';
import { Cipher } from 'n8n-core';
import {
	CREDENTIAL_BLANKING_VALUE,
	jsonParse,
	randomString,
	UnexpectedError,
	UserError,
} from 'n8n-workflow';
import type { ConnectionOptions } from 'tls';

import { PasswordUtility } from '@/services/password.utility';
import {
	assertAuthenticationMethodCanBeEnabled,
	getCurrentAuthenticationMethod,
	setCurrentAuthenticationMethod,
} from '@/sso/sso-helpers';

import { BINARY_AD_ATTRIBUTES } from './constants';
import { LdapRepository } from './database/ldap.repository';
import {
	createFilter,
	escapeFilter,
	formatUrl,
	getMappingAttributes,
	isLdapConfig,
	mapLdapAttributesToUser,
	resolveBinaryAttributes,
	resolveEntryBinaryAttributes,
	toLdapUserData,
	validateLdapConfigurationSchema,
} from './helpers';
import { LdapConnectionError, LdapRejectionError } from './ldap.errors';
import type { LdapUserData, LdapUserEntry } from './types';

/** The length of the random password of a user that LDAP creates. Nobody knows it. */
const RANDOM_PASSWORD_LENGTH = 18;

/**
 * Fork code (not in upstream n8n): LDAP sign-in and the synchronization of LDAP users, in place
 * of the enterprise service of the same name. It is also the `ldap` password handler of the
 * sign-in route. See `README.md` in this folder.
 */
@AuthHandler()
export class LdapService implements IPasswordAuthHandler<User> {
	readonly metadata = { name: 'ldap', type: 'password' } as const;

	readonly userClass = User;

	private client: Client | undefined;

	private syncTimer: NodeJS.Timeout | undefined = undefined;

	/** The configuration in use, with the plain binding password. */
	private currentConfig: LdapConfig | undefined;

	constructor(
		private readonly logger: Logger,
		private readonly settingsRepository: SettingsRepository,
		private readonly cipher: Cipher,
		private readonly eventService: EventService,
		private readonly licenseState: LicenseState,
	) {}

	/** The configuration in use. `init` or `setConfig` sets it. */
	get config(): LdapConfig {
		if (!this.currentConfig) {
			throw new UnexpectedError('The LDAP service has no configuration. Call init() first.');
		}
		return this.currentConfig;
	}

	/**
	 * Loads the stored configuration, sets the login state and label of the sign-in page, and
	 * schedules the synchronization. Another SSO method keeps its sign-in: the login state and
	 * label stay, with a warning.
	 */
	async init() {
		const ldapConfig = await this.loadConfig();
		try {
			await this.setGlobalLdapConfigVariables(ldapConfig);
		} catch (error) {
			if (error instanceof Error) this.logger.warn(error.message, { error });
		}
		this.setConfig(ldapConfig);
	}

	/** The stored configuration, with the plain binding password. */
	async loadConfig(): Promise<LdapConfig> {
		const { value } = await this.settingsRepository.findOneByOrFail({ key: LDAP_FEATURE_NAME });
		const ldapConfig = jsonParse<LdapConfig>(value);
		ldapConfig.bindingAdminPassword = await this.cipher.decryptV2(ldapConfig.bindingAdminPassword);
		// Configurations from before the uniqueness check enforce it.
		ldapConfig.enforceEmailUniqueness ??= true;
		return ldapConfig;
	}

	/**
	 * Checks and stores a configuration. The blanking value keeps the stored password. With the
	 * login off, the LDAP users become email users and the synchronization turns off.
	 */
	async updateConfig(ldapConfig: unknown): Promise<void> {
		if (!isLdapConfig(ldapConfig)) {
			throw new BadRequestError(validateLdapConfigurationSchema(ldapConfig).message);
		}

		if (ldapConfig.loginEnabled) assertAuthenticationMethodCanBeEnabled('ldap');

		const config: LdapConfig = { ...ldapConfig };
		// The schedule follows the request, also when the login off turns the stored flag off.
		const scheduleSync = config.synchronizationEnabled;

		if (config.bindingAdminPassword === CREDENTIAL_BLANKING_VALUE) {
			config.bindingAdminPassword = (await this.loadConfig()).bindingAdminPassword;
		}
		const plainPassword = config.bindingAdminPassword;
		config.bindingAdminPassword = await this.cipher.encryptV2(plainPassword);

		if (!config.loginEnabled) {
			config.synchronizationEnabled = false;
			await Container.get(LdapRepository).deleteAllIdentities();
		}

		await this.settingsRepository.update(
			{ key: LDAP_FEATURE_NAME },
			{ value: JSON.stringify(config), loadOnStartup: true },
		);
		await this.setGlobalLdapConfigVariables(config);

		this.currentConfig = { ...config, bindingAdminPassword: plainPassword };
		this.client = undefined;
		this.stopSync();
		if (scheduleSync) this.scheduleSync();
	}

	/** Uses a configuration without a check, and schedules its synchronization. */
	setConfig(ldapConfig: LdapConfig) {
		this.currentConfig = ldapConfig;
		this.client = undefined;
		this.stopSync();
		if (this.config.synchronizationEnabled) this.scheduleSync();
	}

	/** Sets the login state and the label of LDAP on the sign-in page. */
	async setGlobalLdapConfigVariables(ldapConfig: LdapConfig): Promise<void> {
		await this.setLdapLoginEnabled(ldapConfig.loginEnabled);
		Container.get(GlobalConfig).sso.ldap.loginLabel = ldapConfig.loginLabel;
	}

	/**
	 * Turns the LDAP login on or off. On makes LDAP the sign-in method, which needs email or LDAP
	 * as the current method. Off makes email the sign-in method when LDAP was.
	 */
	async setLdapLoginEnabled(enabled: boolean): Promise<void> {
		const current = getCurrentAuthenticationMethod();
		if (enabled && current !== 'email' && current !== 'ldap') {
			throw new UserError(
				`Cannot set LDAP login enabled state when an authentication method other than email or ldap is active (current: ${current})`,
			);
		}
		Container.get(GlobalConfig).sso.ldap.loginEnabled = enabled;
		const target = !enabled && current === 'ldap' ? 'email' : current;
		await setCurrentAuthenticationMethod(enabled ? 'ldap' : target);
	}

	/**
	 * The client of the directory. A new configuration makes a new client. With STARTTLS, the
	 * client starts TLS once, when it is made.
	 */
	async getClient(): Promise<Client> {
		if (this.client === undefined) {
			const { connectionUrl, connectionPort, connectionSecurity, allowUnauthorizedCerts } =
				this.config;
			const options: ClientOptions = {
				url: formatUrl(connectionUrl, connectionPort, connectionSecurity),
			};
			const tlsOptions: ConnectionOptions = { rejectUnauthorized: !allowUnauthorizedCerts };
			if (connectionSecurity === 'tls') options.tlsOptions = tlsOptions;
			this.client = new Client(options);
			if (connectionSecurity === 'startTls') await this.client.startTLS(tlsOptions);
		}
		return this.client;
	}

	/** Binds with the binding DN and password of the configuration. Empty ones bind anonymously. */
	async bindAdmin(): Promise<void> {
		const client = await this.getClient();
		await client.bind(this.config.bindingAdminDn, this.config.bindingAdminPassword);
	}

	/** Searches the base DN as the binding user, and unbinds after the search. */
	async searchWithAdminBinding(filter: string): Promise<Entry[]> {
		await this.bindAdmin();
		const client = await this.getClient();
		const { searchEntries } = await client.search(this.config.baseDn, {
			attributes: getMappingAttributes(this.config),
			explicitBufferAttributes: BINARY_AD_ATTRIBUTES,
			filter,
			timeLimit: this.config.searchTimeout,
			paged: this.config.searchPageSize === 0 ? true : { pageSize: this.config.searchPageSize },
		});
		await client.unbind();
		return searchEntries;
	}

	/** True when more than one entry of the directory has the email, or when the check fails. */
	async hasEmailDuplicatesInLdap(email: unknown): Promise<boolean> {
		try {
			if (typeof email !== 'string') {
				throw new UnexpectedError('The email of the LDAP account is not one text value');
			}
			const filter = createFilter(
				`(${this.config.emailAttribute}=${escapeFilter(email)})`,
				this.config.userFilter,
			);
			const entries = await this.searchWithAdminBinding(filter);
			return entries.length > 1;
		} catch (error) {
			this.logger.error('LDAP - Error checking for duplicate emails', { error });
			return true;
		}
	}

	/** Binds as the user, and unbinds. It throws when the directory refuses the password. */
	async validUser(dn: string, password: string): Promise<void> {
		const client = await this.getClient();
		await client.bind(dn, password);
		await client.unbind();
	}

	/**
	 * The entry of the login ID when its password is right. With more entries, the last one
	 * counts.
	 */
	async findAndAuthenticateLdapUser(
		loginId: string,
		password: string,
		loginIdAttribute: string,
		userFilter: string,
	): Promise<Entry | undefined> {
		let entries: Entry[];
		try {
			entries = await this.searchWithAdminBinding(
				createFilter(`(${loginIdAttribute}=${escapeFilter(loginId)})`, userFilter),
			);
		} catch (error) {
			if (error instanceof Error) {
				this.eventService.emit('ldap-login-sync-failed', { error: error.message });
				this.logger.error('LDAP - Error during search', { message: error.message });
			}
			return undefined;
		}

		const entry = entries.at(-1);
		if (!entry) return undefined;

		try {
			await this.validUser(entry.dn, password);
		} catch (error) {
			if (error instanceof Error) {
				this.logger.error('LDAP - Error validating user against LDAP server', {
					message: error.message,
				});
			}
			return undefined;
		}

		return resolveEntryBinaryAttributes(entry);
	}

	/** Binds with the configuration, to check it. */
	async testConnection(): Promise<void> {
		await this.bindAdmin();
	}

	/** Runs the synchronization each interval of the configuration, in live mode. */
	scheduleSync() {
		const minutes = this.config.synchronizationInterval;
		// An interval of zero minutes or less would run the synchronization without a pause.
		if (!(minutes > 0)) {
			this.logger.warn('LDAP - The synchronization interval must be more than zero minutes');
			return;
		}
		this.syncTimer = setInterval(async () => {
			await this.runSync('live');
		}, minutes * 60_000);
	}

	stopSync() {
		clearInterval(this.syncTimer);
		this.syncTimer = undefined;
	}

	/**
	 * Reads the users of the directory and compares them with the LDAP users of n8n. A dry run
	 * counts the changes. A live run also creates, updates and disables the users. Each run goes
	 * into the history.
	 */
	async runSync(mode: RunningMode): Promise<AuthProviderSyncHistory> {
		this.logger.debug(`LDAP - Starting a synchronization run in ${mode} mode`);

		let entries: Entry[];
		try {
			entries = await this.searchWithAdminBinding(
				createFilter(`(${this.config.loginIdAttribute}=*)`, this.config.userFilter),
			);
		} catch (error) {
			if (error instanceof ResultCodeError) {
				this.logger.error(`LDAP - ${error.message}`);
				throw new LdapRejectionError(error.message);
			}
			const message = error instanceof Error ? error.message : String(error);
			this.logger.error(`LDAP - ${message}`);
			throw new LdapConnectionError(message);
		}
		resolveBinaryAttributes(entries);

		const startedAt = new Date();
		const repository = Container.get(LdapRepository);
		const localLdapIds = await repository.findLdapIds();
		const { usersToCreate, usersToUpdate, usersToDisable } = this.getUsersToProcess(
			entries,
			localLdapIds,
		);

		let status: 'success' | 'error' = 'success';
		let errorMessage = '';
		if (mode === 'live') {
			errorMessage = await this.processUsers(usersToCreate, usersToUpdate, usersToDisable);
			if (errorMessage) {
				status = 'error';
				this.logger.error('LDAP - Synchronization finished with errors');
			}
		}

		const history = await repository.saveSynchronization({
			startedAt,
			endedAt: new Date(),
			created: usersToCreate.length,
			updated: usersToUpdate.length,
			disabled: usersToDisable.length,
			scanned: entries.length,
			runMode: mode,
			status,
			error: errorMessage,
		});

		this.eventService.emit('ldap-general-sync-finished', {
			type: this.syncTimer ? `manual_${mode}` : 'scheduled',
			succeeded: status === 'success',
			usersSynced: usersToCreate.length + usersToUpdate.length + usersToDisable.length,
			error: errorMessage,
		});

		return history;
	}

	/** The users to create, to update and to disable. */
	getUsersToProcess(
		entries: Entry[],
		localLdapIds: string[],
	): { usersToCreate: LdapUserEntry[]; usersToUpdate: LdapUserEntry[]; usersToDisable: string[] } {
		const unique = this.config.enforceEmailUniqueness
			? this.filterEmailDuplicates(entries)
			: entries;
		return {
			usersToCreate: this.getUsersToCreate(unique, localLdapIds),
			usersToUpdate: this.getUsersToUpdate(unique, localLdapIds),
			usersToDisable: this.getUsersToDisable(unique, localLdapIds),
		};
	}

	/** The entries without the entries that share their email with another entry. */
	filterEmailDuplicates(entries: Entry[]): Entry[] {
		const { emailAttribute } = this.config;
		const counts = new Map<unknown, number>();
		for (const entry of entries) {
			const email: unknown = entry[emailAttribute];
			counts.set(email, (counts.get(email) ?? 0) + 1);
		}
		return entries.filter((entry) => {
			if ((counts.get(entry[emailAttribute]) ?? 0) < 2) return true;
			this.logger.warn('LDAP sync skipped entry: multiple LDAP accounts share the same email', {
				dn: entry.dn,
			});
			return false;
		});
	}

	/** The entries without an LDAP user in n8n, with a valid email. */
	getUsersToCreate(entries: Entry[], localLdapIds: string[]): LdapUserEntry[] {
		return this.toUserEntries(entries.filter((entry) => !this.hasLocalLdapId(entry, localLdapIds)));
	}

	/** The entries with an LDAP user in n8n, with a valid email. */
	getUsersToUpdate(entries: Entry[], localLdapIds: string[]): LdapUserEntry[] {
		return this.toUserEntries(entries.filter((entry) => this.hasLocalLdapId(entry, localLdapIds)));
	}

	/**
	 * The LDAP IDs of n8n that the entries do not have. An entry that shares its email with
	 * another entry does not count, so its user is disabled.
	 */
	getUsersToDisable(entries: Entry[], localLdapIds: string[]): string[] {
		const { ldapIdAttribute } = this.config;
		const ldapIds = new Set(entries.map((entry): unknown => entry[ldapIdAttribute]));
		return localLdapIds.filter((ldapId) => !ldapIds.has(ldapId));
	}

	private hasLocalLdapId(entry: Entry, localLdapIds: string[]): boolean {
		const ldapId: unknown = entry[this.config.ldapIdAttribute];
		return typeof ldapId === 'string' && localLdapIds.includes(ldapId);
	}

	/** The LDAP ID and user fields of each entry. An entry with an invalid email stays out. */
	private toUserEntries(entries: Entry[]): LdapUserEntry[] {
		const result: LdapUserEntry[] = [];
		for (const entry of entries) {
			const [ldapId, fields] = mapLdapAttributesToUser(entry, this.config);
			const data = toLdapUserData(fields);
			if (!data) {
				this.logger.warn(`LDAP - Invalid email format for user ${String(ldapId)}`);
				continue;
			}
			// The fork skips an entry without an LDAP ID. See README.md.
			if (typeof ldapId !== 'string' || !ldapId) {
				this.logger.warn(`LDAP - Missing LDAP ID for user ${data.email}`);
				continue;
			}
			result.push([ldapId, data]);
		}
		return result;
	}

	/**
	 * Writes the changes of a live run, one user after the other. A failure does not stop the
	 * other users. It returns the message of the first failure, or an empty text.
	 */
	private async processUsers(
		usersToCreate: LdapUserEntry[],
		usersToUpdate: LdapUserEntry[],
		usersToDisable: string[],
	): Promise<string> {
		const repository = Container.get(LdapRepository);
		const failures: string[] = [];
		const attempt = async (write: () => Promise<unknown>) => {
			try {
				await write();
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		};

		for (const [ldapId, data] of usersToCreate) {
			await attempt(async () => {
				const user = await repository.findUserByEmail(data.email);
				if (user) {
					await repository.createIdentity(user, ldapId);
					await repository.updateUser(user.id, data);
				} else {
					await repository.createUser({ ...data, password: await this.randomPassword() }, ldapId);
				}
			});
		}
		for (const [ldapId, data] of usersToUpdate) {
			await attempt(async () => {
				const identity = await repository.findIdentityByLdapId(ldapId);
				if (identity) await repository.updateUser(identity.userId, data);
			});
		}
		for (const ldapId of usersToDisable) {
			await attempt(async () => await repository.disableUser(ldapId));
		}

		return failures[0] ?? '';
	}

	/**
	 * The password handler of the sign-in route. It finds the user in the directory and checks the
	 * password there. A new user gets an n8n user, and an email user with the same email gets an
	 * LDAP identity. A disabled LDAP user cannot sign in.
	 */
	async handleLogin(loginId: string, password: string): Promise<User | undefined> {
		if (!this.licenseState.isLdapLicensed()) return undefined;
		if (!this.currentConfig?.loginEnabled) return undefined;

		const { loginIdAttribute, userFilter } = this.config;
		const entry = await this.findAndAuthenticateLdapUser(
			loginId,
			password,
			loginIdAttribute,
			userFilter,
		);
		if (!entry) return undefined;

		const [ldapId, fields] = mapLdapAttributesToUser(entry, this.config);
		if (!ldapId || !fields.email || typeof ldapId !== 'string') return undefined;

		const repository = Container.get(LdapRepository);
		const identity = await repository.findIdentityByLdapId(ldapId);

		if (!identity) {
			if (
				this.config.enforceEmailUniqueness &&
				(await this.hasEmailDuplicatesInLdap(fields.email))
			) {
				this.logger.warn('LDAP login blocked: Multiple LDAP accounts share the same email', {
					ldapId,
				});
				return undefined;
			}
			// The fork refuses an email with more values here. See README.md.
			if (typeof fields.email !== 'string') {
				this.logger.warn('LDAP login blocked: The email of the LDAP account has more values', {
					ldapId,
				});
				return undefined;
			}

			const data = this.toLoginUserData(fields.email, fields);
			// Only an email in the same case links the email user.
			const emailUser = await repository.findUserByEmail(data.email);
			if (emailUser?.email === data.email) {
				await repository.createIdentity(emailUser, ldapId);
				await repository.updateUser(emailUser.id, data);
			} else {
				const user = await repository.createUser(
					{ ...data, password: await this.randomPassword() },
					ldapId,
				);
				this.eventService.emit('user-signed-up', {
					user,
					userType: 'ldap',
					wasDisabledLdapUser: false,
				});
				return user;
			}
		} else {
			if (identity.user.disabled) return undefined;
			if (typeof fields.email === 'string') {
				await repository.updateUser(identity.userId, this.toLoginUserData(fields.email, fields));
			}
		}

		return (await repository.findIdentityByLdapId(ldapId))?.user;
	}

	/** The user fields of a sign-in. The sign-in does not check the email: the save does. */
	private toLoginUserData(
		email: string,
		fields: { firstName: unknown; lastName: unknown },
	): LdapUserData {
		const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
		return { email, firstName: text(fields.firstName), lastName: text(fields.lastName) };
	}

	private async randomPassword(): Promise<string> {
		return await Container.get(PasswordUtility).hash(randomString(RANDOM_PASSWORD_LENGTH));
	}
}
