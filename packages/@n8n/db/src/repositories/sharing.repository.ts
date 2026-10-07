import { Service } from '@n8n/di';
import type { EntityManager } from '@n8n/typeorm';
import { DataSource, In } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import {
	CredentialsEntity,
	Folder,
	Project,
	SharedCredentials,
	SharedWorkflow,
	WorkflowEntity,
} from '../entities';
import { TransactionRunner } from '../services/transaction';
import { chunkIds } from '../utils/chunk-ids';

/**
 * Fork repository (not in upstream n8n): the queries of the fork's sharing services
 * (`packages/cli/src/workflows/enterprise-workflow.service.ts` and
 * `packages/cli/src/credentials/enterprise-credentials.service.ts`) that need operators or a
 * transaction.
 */
@Service()
export class SharingRepository extends BaseRepository<SharedWorkflow> {
	constructor(dataSource: DataSource, txRunner: TransactionRunner) {
		super(SharedWorkflow, dataSource.manager, txRunner);
	}

	/** A credential that projects can own and share. Instance credentials have no shares. */
	async findProjectCredential(credentialId: string, trx: EntityManager) {
		return await trx.findOneBy(CredentialsEntity, { id: credentialId, usageScope: 'project' });
	}

	async findProjects(projectIds: string[], trx: EntityManager) {
		if (projectIds.length === 0) return [];
		return await trx.findBy(Project, { id: In(projectIds) });
	}

	/**
	 * Share a workflow with each project as editor, except with the project that owns it. A share
	 * that exists already stays as it is.
	 */
	async shareWorkflow(workflowId: string, projectIds: string[], trx: EntityManager) {
		const owners = await trx.findBy(SharedWorkflow, { workflowId, role: 'workflow:owner' });
		const rows = projectIds
			.filter((projectId) => !owners.some((owner) => owner.projectId === projectId))
			.map((projectId) =>
				trx.create(SharedWorkflow, { workflowId, projectId, role: 'workflow:editor' }),
			);
		return await trx.save(rows);
	}

	/**
	 * Share a credential with each project as user, except with the project that owns it. A share
	 * that exists already stays as it is.
	 */
	async shareCredential(credentialId: string, projectIds: string[], trx: EntityManager) {
		const owners = await trx.findBy(SharedCredentials, {
			credentialsId: credentialId,
			role: 'credential:owner',
		});
		const rows = projectIds
			.filter((projectId) => !owners.some((owner) => owner.projectId === projectId))
			.map((projectId) =>
				trx.create(SharedCredentials, {
					credentialsId: credentialId,
					projectId,
					role: 'credential:user',
				}),
			);
		return await trx.save(rows);
	}

	/** Make a project the owner of a credential, in place of all its shares. */
	async transferCredential(credentialId: string, projectId: string) {
		await this.runInTransaction({}, async (trx) => {
			await trx.delete(SharedCredentials, { credentialsId: credentialId });
			await trx.insert(SharedCredentials, {
				credentialsId: credentialId,
				projectId,
				role: 'credential:owner',
			});
		});
	}

	/**
	 * Make a project the owner of a workflow, in place of all its shares, and put the workflow in
	 * a folder of that project (`null` for the root). The same transaction shares the credentials
	 * with the project.
	 */
	async transferWorkflow(
		workflowId: string,
		projectId: string,
		parentFolderId: string | null,
		credentialIds: string[],
	) {
		await this.runInTransaction({}, async (trx) => {
			await this.makeOwner(trx, [workflowId], projectId);
			await trx.update(
				WorkflowEntity,
				{ id: workflowId },
				{ parentFolder: parentFolderId === null ? null : { id: parentFolderId } },
			);
			await this.shareCredentialsWithProject(trx, credentialIds, projectId);
		});
	}

	/**
	 * Move folders and their workflows to a project. `folderId` is the top folder, which goes into
	 * `parentFolderId` (`null` for the root). The project becomes the owner of the workflows, in
	 * place of all their shares. The same transaction shares the credentials with the project.
	 */
	async transferFolder(
		folderId: string,
		folderIds: string[],
		parentFolderId: string | null,
		workflowIds: string[],
		projectId: string,
		credentialIds: string[],
	) {
		await this.runInTransaction({}, async (trx) => {
			for (const chunk of chunkIds(folderIds)) {
				await trx.update(Folder, { id: In(chunk) }, { homeProject: { id: projectId } });
			}
			await trx.update(
				Folder,
				{ id: folderId },
				{ parentFolder: parentFolderId === null ? null : { id: parentFolderId } },
			);
			await this.makeOwner(trx, workflowIds, projectId);
			await this.shareCredentialsWithProject(trx, credentialIds, projectId);
		});
	}

	/** The ids of the workflows in these folders, archived workflows too. */
	async findWorkflowIdsInFolders(folderIds: string[]) {
		const ids: string[] = [];
		for (const chunk of chunkIds(folderIds)) {
			const workflows = await this.manager.find(WorkflowEntity, {
				select: { id: true },
				where: { parentFolder: { id: In(chunk) } },
			});
			ids.push(...workflows.map(({ id }) => id));
		}
		return ids;
	}

	private async makeOwner(trx: EntityManager, workflowIds: string[], projectId: string) {
		for (const chunk of chunkIds(workflowIds)) {
			await trx.delete(SharedWorkflow, { workflowId: In(chunk) });
			await trx.insert(
				SharedWorkflow,
				chunk.map((workflowId) => ({ workflowId, projectId, role: 'workflow:owner' as const })),
			);
		}
	}

	/** Share credentials with a project as user, when the project has no share of them yet. */
	private async shareCredentialsWithProject(
		trx: EntityManager,
		credentialIds: string[],
		projectId: string,
	) {
		for (const chunk of chunkIds([...new Set(credentialIds)])) {
			const existing = await trx.findBy(SharedCredentials, {
				credentialsId: In(chunk),
				projectId,
			});
			const missing = chunk.filter(
				(credentialId) => !existing.some((share) => share.credentialsId === credentialId),
			);
			if (missing.length === 0) continue;
			await trx.insert(
				SharedCredentials,
				missing.map((credentialsId) => ({
					credentialsId,
					projectId,
					role: 'credential:user' as const,
				})),
			);
		}
	}
}
