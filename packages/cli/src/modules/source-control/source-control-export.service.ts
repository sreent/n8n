import { WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AccessScope } from './source-control-resources.service';
import {
	sanitizeCredentialObject,
	SourceControlResourcesService,
} from './source-control-resources.service';
import type {
	ExportableCredential,
	ExportableDataTable,
	ExportableFolders,
	ExportableProject,
	ExportableTags,
	ExportableVariable,
	ExportableWorkflow,
} from './types/exportable';

/**
 * Fork code (not in upstream n8n): writes resources of the instance to the work folder, in the
 * layout and the format of the original. See `README.md` in this folder.
 */
@Service()
export class SourceControlExportService {
	constructor(
		private readonly resources: SourceControlResourcesService,
		private readonly workflowRepository: WorkflowRepository,
	) {}

	private async write(file: string, content: unknown) {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(content, null, 2));
	}

	async deleteFiles(files: string[]) {
		for (const file of files) await rm(file, { force: true });
	}

	/** Writes `workflows/<id>.json` for each workflow. */
	async exportWorkflows(ids: string[]) {
		if (ids.length === 0) return;
		const wanted = new Set(ids);
		const workflows = (
			await this.workflowRepository.find({ relations: { parentFolder: true } })
		).filter((workflow) => wanted.has(workflow.id));
		const owners = await this.resources.getWorkflowOwnerProjects();
		const context = await this.resources.getProjectOwners();
		for (const workflow of workflows) {
			const project = owners.get(workflow.id);
			const content: ExportableWorkflow = {
				id: workflow.id,
				name: workflow.name,
				description: workflow.description ?? null,
				nodes: workflow.nodes,
				connections: workflow.connections,
				settings: workflow.settings,
				triggerCount: workflow.triggerCount,
				versionId: workflow.versionId,
				owner: this.resources.remoteOwner(
					project ? context.projects.get(project.id) : undefined,
					context.personalOwners,
				),
				parentFolderId: workflow.parentFolder?.id ?? null,
				isArchived: workflow.isArchived,
				nodeGroups: workflow.nodeGroups,
			};
			await this.write(this.resources.workflowFile(workflow.id), content);
		}
	}

	/** Writes `credential_stubs/<id>.json` for each credential: no secrets, only expressions. */
	async exportCredentials(ids: string[]) {
		if (ids.length === 0) return;
		const wanted = new Set(ids);
		const credentials = (
			await this.resources.getLocalCredentials({ projectIds: undefined })
		).filter((credential) => wanted.has(credential.id));
		const context = await this.resources.getProjectOwners();
		for (const credential of credentials) {
			const project = credential.owner
				? context.projects.get(credential.owner.projectId)
				: undefined;
			const content: ExportableCredential = {
				id: credential.id,
				name: credential.name,
				type: credential.type,
				data: sanitizeCredentialObject(credential.data),
				ownedBy: this.resources.remoteOwner(project, context.personalOwners) ?? null,
				isGlobal: credential.isGlobal,
				isResolvable: credential.isResolvable,
				resolvableAllowFallback: credential.resolvableAllowFallback,
			};
			await this.write(this.resources.credentialFile(credential.id), content);
		}
	}

	/** Writes `variable_stubs.json` with all global variables, without their values. */
	async exportVariables() {
		const variables: ExportableVariable[] = (await this.resources.getLocalVariables()).map(
			({ id, key, type }) => ({ id, key, type, value: '' }),
		);
		await this.write(this.resources.variablesFile, variables);
	}

	/** Writes `tags.json` with all tags and the tags of the workflows that the user may push. */
	async exportTags(scope: AccessScope) {
		const tags: ExportableTags = await this.resources.getLocalTags(scope);
		await this.write(this.resources.tagsFile, tags);
	}

	/** Writes `folders.json` with the folders of the projects that the user may push. */
	async exportFolders(scope: AccessScope) {
		const folders: ExportableFolders = { folders: await this.resources.getLocalFolders(scope) };
		await this.write(this.resources.foldersFile, folders);
	}

	/** Writes `projects/<id>.json` for each team project. */
	async exportProjects(ids: string[]) {
		if (ids.length === 0) return;
		const wanted = new Set(ids);
		const projects = (await this.resources.getLocalProjects({ projectIds: undefined })).filter(
			(project) => wanted.has(project.id),
		);
		for (const project of projects) {
			const content: ExportableProject = {
				id: project.id,
				name: project.name,
				icon: project.icon,
				description: project.description,
				type: 'team',
				owner: { type: 'team', teamId: project.id, teamName: project.name },
				variableStubs: project.variableStubs,
			};
			await this.write(this.resources.projectFile(project.id), content);
		}
	}

	/** Writes `datatables/<id>.json` for each data table: the columns, not the rows. */
	async exportDataTables(ids: string[]) {
		if (ids.length === 0) return;
		const wanted = new Set(ids);
		const tables = (await this.resources.getLocalDataTables({ projectIds: undefined })).filter(
			(table) => wanted.has(table.id),
		);
		for (const table of tables) {
			const content: ExportableDataTable = {
				id: table.id,
				name: table.name,
				columns: table.columns,
				ownedBy: table.ownedBy,
				createdAt: table.createdAt,
				updatedAt: table.updatedAt,
			};
			await this.write(this.resources.dataTableFile(table.id), content);
		}
	}
}
