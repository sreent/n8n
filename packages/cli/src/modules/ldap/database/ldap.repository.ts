import type { AuthProviderSyncHistory, User } from '@n8n/db';
import {
	AuthIdentity,
	AuthIdentityRepository,
	AuthProviderSyncHistoryRepository,
	UserRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

import type { LdapSynchronizationData, LdapUserData } from '../types';

/**
 * Fork code (not in upstream n8n): the queries of the LDAP module, for the users with an LDAP
 * identity and for the synchronization history. See `../README.md`.
 */
@Service()
export class LdapRepository {
	constructor(
		private readonly dataSource: DataSource,
		private readonly userRepository: UserRepository,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly syncHistoryRepository: AuthProviderSyncHistoryRepository,
	) {}

	/** The LDAP identity with the LDAP ID, with its user and the role of the user. */
	async findIdentityByLdapId(ldapId: string): Promise<AuthIdentity | null> {
		return await this.authIdentityRepository.findOne({
			relations: { user: { role: true } },
			where: { providerId: ldapId, providerType: 'ldap' },
		});
	}

	async findUserByEmail(email: string): Promise<User | null> {
		return await this.userRepository.findOne({ where: { email } });
	}

	/** The LDAP IDs of all LDAP identities. */
	async findLdapIds(): Promise<string[]> {
		const identities = await this.authIdentityRepository.find({
			select: ['providerId'],
			where: { providerType: 'ldap' },
		});
		return identities.map((identity) => identity.providerId);
	}

	/** The users with an LDAP identity. */
	async findLdapUsers(): Promise<User[]> {
		return await this.userRepository.find({
			relations: ['authIdentities'],
			where: { authIdentities: { providerType: 'ldap' } },
		});
	}

	/** Creates a member with a personal project and an LDAP identity, in one transaction. */
	async createUser(data: LdapUserData & { password: string }, ldapId: string): Promise<User> {
		return await this.dataSource.manager.transaction(async (transaction) => {
			const { user } = await this.userRepository.createUserWithProject(
				{ ...data, role: { slug: 'global:member' } },
				transaction,
			);
			await transaction.save(AuthIdentity.create(user, ldapId, 'ldap'));
			return user;
		});
	}

	/** Gives an existing user an LDAP identity. */
	async createIdentity(user: User, ldapId: string): Promise<AuthIdentity> {
		return await this.authIdentityRepository.save(AuthIdentity.create(user, ldapId, 'ldap'), {
			transaction: false,
		});
	}

	/**
	 * Writes the fields from the directory to the user. A save, not an update, so that the user
	 * subscriber renames the personal project. A save of plain fields skips the checks of the
	 * entity, as the original does.
	 */
	async updateUser(userId: string, data: LdapUserData): Promise<void> {
		await this.userRepository.save({ id: userId, ...data }, { transaction: false });
	}

	/** Disables the user of the LDAP identity, and deletes the identity. */
	async disableUser(ldapId: string): Promise<void> {
		const identity = await this.authIdentityRepository.findOne({
			where: { providerId: ldapId, providerType: 'ldap' },
		});
		if (!identity) return;
		await this.userRepository.save({ id: identity.userId, disabled: true }, { transaction: false });
		await this.authIdentityRepository.delete({ providerId: ldapId, providerType: 'ldap' });
	}

	async deleteAllIdentities(): Promise<void> {
		await this.authIdentityRepository.delete({ providerType: 'ldap' });
	}

	async saveSynchronization(data: LdapSynchronizationData): Promise<AuthProviderSyncHistory> {
		return await this.syncHistoryRepository.save({ ...data, providerType: 'ldap' });
	}

	/**
	 * A page of the history, newest first. A negative page counts as positive. A number that is
	 * not one reaches the query and fails there.
	 */
	async findSynchronizations(page: number, perPage: number): Promise<AuthProviderSyncHistory[]> {
		return await this.syncHistoryRepository.find({
			where: { providerType: 'ldap' },
			order: { id: 'DESC' },
			take: perPage,
			skip: Math.abs(page) * perPage,
		});
	}

	async findSynchronizationsWithCount(
		offset: number,
		limit: number,
	): Promise<[AuthProviderSyncHistory[], number]> {
		return await this.syncHistoryRepository.findAndCount({
			where: { providerType: 'ldap' },
			order: { id: 'DESC' },
			skip: offset,
			take: limit,
		});
	}
}
