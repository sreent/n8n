import { ProjectRelationRepository, User, UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';

import type {
	ICredentialConnectionStatusProvider,
	UserConnection,
} from '@/credentials/credential-connection-status-provider.interface';
import { extractAccountIdentifierFromData } from '@/oauth/account-identifier';
import { userHasScopes } from '@/permissions/check-access';

import { SYSTEM_RESOLVER_ID } from '../constants';
import { DynamicCredentialUserEntryRepository } from '../database/repositories/dynamic-credential-user-entry.repository';

/** The transaction that the ordinary callers pass, if any. */
type Transaction = Parameters<ICredentialConnectionStatusProvider['deleteAllUserEntries']>[1];

/**
 * The connections of n8n users to private credentials: the entries of the system resolver. A
 * user keeps an entry only while they may connect the credential (`credential:connect`).
 */
@Service()
export class CredentialConnectionStatusService implements ICredentialConnectionStatusProvider {
	constructor(
		private readonly repository: DynamicCredentialUserEntryRepository,
		private readonly userRepository: UserRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly cipher: Cipher,
	) {}

	async findMyConnections(userId: string, credentialIds: string[]) {
		const entries = await this.repository.findEntriesOfUser(
			userId,
			credentialIds,
			SYSTEM_RESOLVER_ID,
		);
		const connections = new Map<string, UserConnection>();
		for (const entry of entries) {
			const accountIdentifier = await this.accountIdentifierOf(entry.data);
			connections.set(entry.credentialId, accountIdentifier ? { accountIdentifier } : {});
		}
		return connections;
	}

	async countConnectedUsers(credentialId: string) {
		return await this.repository.countUsersOfCredential(credentialId, SYSTEM_RESOLVER_ID);
	}

	async deleteAllUserEntries(credentialId: string, em?: Transaction) {
		await this.repository.deleteAllOfCredential(credentialId, em);
	}

	async cleanupOrphanedEntriesForUsers(userIds: string[], em?: Transaction, credentialId?: string) {
		if (userIds.length === 0) return;
		const entries = await this.repository.findEntriesOfUsers(userIds, credentialId, em);
		const credentialsByUser = new Map<string, Set<string>>();
		for (const entry of entries) {
			const credentials = credentialsByUser.get(entry.userId) ?? new Set<string>();
			credentials.add(entry.credentialId);
			credentialsByUser.set(entry.userId, credentials);
		}
		for (const [userId, credentialIds] of credentialsByUser) {
			const user = await this.findUser(userId, em);
			const orphaned: string[] = [];
			for (const id of credentialIds) {
				const allowed =
					user !== null &&
					(await userHasScopes(user, ['credential:connect'], false, { credentialId: id }, em));
				if (!allowed) orphaned.push(id);
			}
			await this.repository.deleteEntriesOfUser(userId, orphaned, em);
		}
	}

	async cleanupOrphanedEntriesForProjects(
		credentialId: string,
		projectIds: string[],
		em?: Transaction,
	) {
		const userIds = new Set<string>();
		for (const projectId of projectIds) {
			for (const userId of await this.projectRelationRepository.findUserIdsByProjectId(projectId)) {
				userIds.add(userId);
			}
		}
		await this.cleanupOrphanedEntriesForUsers([...userIds], em, credentialId);
	}

	private async findUser(userId: string, em?: Transaction) {
		const options = { where: { id: userId }, relations: { role: true } };
		return em ? await em.findOne(User, options) : await this.userRepository.findOne(options);
	}

	/** The provider account of a connection, when the stored token names one. */
	private async accountIdentifierOf(data: string) {
		try {
			return extractAccountIdentifierFromData(
				jsonParse<Record<string, unknown>>(await this.cipher.decryptV2(data)),
			);
		} catch {
			return undefined;
		}
	}
}
