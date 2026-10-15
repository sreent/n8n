import { Service } from '@n8n/di';
import { DataSource, EntityManager, In, Repository } from '@n8n/typeorm';

import { DynamicCredentialUserEntry } from '../entities/dynamic-credential-user-entry';

@Service()
export class DynamicCredentialUserEntryRepository extends Repository<DynamicCredentialUserEntry> {
	constructor(dataSource: DataSource) {
		super(DynamicCredentialUserEntry, dataSource.manager);
	}

	private repositoryFor(em?: EntityManager) {
		return em ? em.getRepository(DynamicCredentialUserEntry) : this;
	}

	/** The stored data of a user, or null. */
	async findData(credentialId: string, userId: string, resolverId: string) {
		const entry = await this.findOne({
			select: ['data'],
			where: { credentialId, userId, resolverId },
		});
		return entry?.data ?? null;
	}

	/** Stores the data of a user: changes the existing entry, else adds one. */
	async saveData(credentialId: string, userId: string, resolverId: string, data: string) {
		await this.upsert({ credentialId, userId, resolverId, data }, [
			'credentialId',
			'userId',
			'resolverId',
		]);
	}

	/** Deletes the data of a user, and tells if it existed. */
	async deleteData(credentialId: string, userId: string, resolverId: string) {
		const { affected } = await this.delete({ credentialId, userId, resolverId });
		return (affected ?? 0) > 0;
	}

	/** The entries of a user for some credentials of one resolver, in one query. */
	async findEntriesOfUser(userId: string, credentialIds: string[], resolverId: string) {
		return await this.find({
			select: ['credentialId', 'data'],
			where: { userId, credentialId: In(credentialIds), resolverId },
		});
	}

	/** The number of users with an entry for a credential under one resolver. */
	async countUsersOfCredential(credentialId: string, resolverId: string) {
		return await this.countBy({ credentialId, resolverId });
	}

	/** Deletes the entries of all users of a resolver. */
	async deleteAllOfResolver(resolverId: string) {
		await this.delete({ resolverId });
	}

	/** Deletes the entries of all users for a credential, of all resolvers. */
	async deleteAllOfCredential(credentialId: string, em?: EntityManager) {
		await this.repositoryFor(em).delete({ credentialId });
	}

	/** The entries of some users, optionally for one credential only. */
	async findEntriesOfUsers(userIds: string[], credentialId?: string, em?: EntityManager) {
		return await this.repositoryFor(em).find({
			select: ['credentialId', 'userId', 'resolverId'],
			where: { userId: In(userIds), ...(credentialId ? { credentialId } : {}) },
		});
	}

	/** Deletes the entries of a user for some credentials, of all resolvers. */
	async deleteEntriesOfUser(userId: string, credentialIds: string[], em?: EntityManager) {
		if (credentialIds.length === 0) return;
		await this.repositoryFor(em).delete({ userId, credentialId: In(credentialIds) });
	}
}
