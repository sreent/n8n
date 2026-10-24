// Fork service (not in upstream n8n): the credential sharing service of the fork, in place of the
// enterprise `credentials.service.ee.ts` for ordinary code. packages/cli/src/workflows/FORK.md
// describes its behaviour.
import type { CredentialConnectionStatus } from '@n8n/api-types';
import { CredentialsFinderService } from '@n8n/backend-services';
import type { CredentialsEntity, EntityManager, User } from '@n8n/db';
import { SharingRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { NotFoundError } from '@n8n/errors';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

import { TransferCredentialError } from '@/errors/response-errors/transfer-credential.error';
import { PolicyEnforcementService } from '@/policy/policy-enforcement.service';
import { OwnershipService } from '@/services/ownership.service';
import { ProjectService } from '@/services/project.service';

import { CredentialConnectionStatusProxy } from './credential-connection-status-proxy';
import { CredentialsService } from './credentials.service';

@Service()
export class EnterpriseCredentialsService {
	constructor(
		private readonly sharingRepository: SharingRepository,
		private readonly ownershipService: OwnershipService,
		private readonly credentialsService: CredentialsService,
		private readonly credentialsFinderService: CredentialsFinderService,
		private readonly projectService: ProjectService,
		private readonly connectionStatusProxy: CredentialConnectionStatusProxy,
		private readonly policyEnforcementService: PolicyEnforcementService,
	) {}

	/**
	 * Share a credential with projects, in the transaction of the caller. Personal projects always
	 * get the share. A team project gets it only when the user may list it. The project that owns
	 * the credential gets no share. The caller checks that the user may share the credential.
	 */
	async shareWithProjects(
		user: User,
		credentialId: string,
		shareWithIds: string[],
		entityManager: EntityManager,
	) {
		const credential = await this.sharingRepository.findProjectCredential(
			credentialId,
			entityManager,
		);
		if (!credential) throw new NotFoundError('Credential not found');

		const projectIds: string[] = [];
		for (const project of await this.sharingRepository.findProjects(shareWithIds, entityManager)) {
			if (
				project.type === 'personal' ||
				(await this.projectService.getProjectWithScope(
					user,
					project.id,
					['project:list'],
					entityManager,
				))
			) {
				projectIds.push(project.id);
			}
		}
		return await this.sharingRepository.shareCredential(credentialId, projectIds, entityManager);
	}

	/**
	 * A credential that the user can see, with its home project and shares. The decrypted data is
	 * there when `includeDecryptedData` is set and the user may also update the credential.
	 */
	async getOneForUser(user: User, credentialId: string, includeDecryptedData: boolean) {
		let credential: CredentialsEntity | null = null;
		let decryptedData: ICredentialDataDecryptedObject | undefined;
		if (includeDecryptedData) {
			credential = await this.credentialsFinderService.findCredentialForUser(
				credentialId,
				user,
				['credential:read', 'credential:update'],
				{ includeInstanceCredentials: true },
			);
			if (credential) decryptedData = await this.credentialsService.decrypt(credential);
		}
		credential ??= await this.credentialsFinderService.findCredentialForUser(
			credentialId,
			user,
			['credential:read'],
			{ includeInstanceCredentials: true, visibilityOnly: true },
		);
		if (!credential) {
			throw new NotFoundError(
				'Could not load the credential. If you think this is an error, ask the owner to share it with you again',
			);
		}

		const { data: _, ...rest } = this.ownershipService.addOwnedByAndSharedWith(credential);
		const enriched: typeof rest & CredentialConnectionStatus = rest;
		await this.credentialsService.populateConnectedByMe([enriched], user);
		if (credential.isResolvable) {
			enriched.connectedUserCount = await this.credentialsService.countConnectedUsers(
				credential.id,
			);
		}

		if (!decryptedData) return enriched;

		// The editor checks `oauthTokenData` to show that a credential is connected. It gets a flag,
		// never the token. For an end-user credential, the flag is the connection of the user.
		if (credential.isResolvable) {
			if (enriched.connectedByMe) decryptedData.oauthTokenData = true;
			else delete decryptedData.oauthTokenData;
		} else if (decryptedData.oauthTokenData) {
			decryptedData.oauthTokenData = true;
		}
		return { data: decryptedData, ...enriched };
	}

	/**
	 * Move a credential to another project. The project becomes its owner, and all other shares
	 * go. The user needs `credential:move` on the credential and `credential:create` in the
	 * destination project.
	 */
	async transferOne(user: User, credentialId: string, destinationProjectId: string) {
		const credential = await this.credentialsFinderService.findCredentialForUser(
			credentialId,
			user,
			['credential:move'],
		);
		if (!credential) {
			throw new NotFoundError(
				`Could not find the credential with the id "${credentialId}". Make sure you have the permission to move it.`,
			);
		}

		const destinationProject = await this.projectService.getProjectWithScope(
			user,
			destinationProjectId,
			['credential:create'],
		);
		if (!destinationProject) {
			throw new NotFoundError(
				`Could not find project with the id "${destinationProjectId}". Make sure you have the permission to create credentials in it.`,
			);
		}

		const sourceProjectId = credential.shared.find(
			({ role }) => role === 'credential:owner',
		)?.projectId;
		if (sourceProjectId === destinationProject.id) {
			throw new TransferCredentialError(
				"You can't transfer a credential into the project that's already owning it.",
			);
		}

		if (credential.isResolvable) {
			this.credentialsService.ensureEndUserCredentialAllowedInProject(destinationProject);
			await this.credentialsService.ensureCanManageEndUserCredential(user, destinationProject.id);
		}

		await this.policyEnforcementService.enforceCredentialTransfer(
			{
				credential: { id: credential.id, type: credential.type },
				targetProjectId: destinationProject.id,
			},
			{ kind: 'user', user },
		);

		await this.sharingRepository.transferCredential(credential.id, destinationProject.id);

		// The members of the source project can lose access to the credential, and with it their
		// connections to it.
		if (sourceProjectId) {
			await this.connectionStatusProxy.cleanupOrphanedEntriesForProjects(credential.id, [
				sourceProjectId,
			]);
		}
	}
}
