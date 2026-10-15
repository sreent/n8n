import type { SourceControlledFile } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';

import type {
	AccessScope,
	LocalCredential,
	LocalDataTable,
	LocalProject,
	LocalVariable,
	LocalWorkflow,
} from './source-control-resources.service';
import {
	sanitizeCredentialData,
	SourceControlResourcesService,
} from './source-control-resources.service';
import type {
	ExportableCredential,
	ExportableDataTable,
	ExportableFolder,
	ExportableProject,
	ExportableVariable,
	ExportableWorkflow,
	StatusResourceOwner,
} from './types/exportable';

export interface SourceControlGetStatusOptions {
	direction: 'push' | 'pull';
	preferLocalVersion: boolean;
	verbose: boolean;
	origin?: 'ui' | 'publicApi';
	/** `false`: the status emits no telemetry event. */
	track?: boolean;
}

interface RemoteWorkflowItem {
	id: string;
	versionId: string | undefined;
	name: string;
	description: string | null;
	parentFolderId: string | null;
	remoteId: string;
	filename: string;
	owner?: StatusResourceOwner;
	isRemoteArchived: boolean;
}

interface LocalWorkflowItem {
	id: string;
	versionId: string;
	name: string;
	description: string | null;
	localId: string;
	parentFolderId: string | null;
	filename: string;
	updatedAt: string;
	owner?: StatusResourceOwner;
}

/** The status in detail: what differs between the instance and the branch. */
export interface SourceControlVerboseStatus {
	wfRemoteVersionIds: RemoteWorkflowItem[];
	wfLocalVersionIds: LocalWorkflowItem[];
	wfMissingInLocal: RemoteWorkflowItem[];
	wfMissingInRemote: LocalWorkflowItem[];
	wfModifiedInEither: Array<LocalWorkflowItem & { remoteId: string }>;
	credMissingInLocal: unknown[];
	credMissingInRemote: unknown[];
	credModifiedInEither: unknown[];
	varMissingInLocal: ExportableVariable[];
	varMissingInRemote: LocalVariable[];
	varModifiedInEither: LocalVariable[];
	tagsMissingInLocal: Array<{ id: string; name: string }>;
	tagsMissingInRemote: Array<{ id: string; name: string }>;
	tagsModifiedInEither: Array<{ id: string; name: string }>;
	mappingsMissingInLocal: Array<{ workflowId: string; tagId: string }>;
	mappingsMissingInRemote: Array<{ workflowId: string; tagId: string }>;
	foldersMissingInLocal: ExportableFolder[];
	foldersMissingInRemote: ExportableFolder[];
	foldersModifiedInEither: ExportableFolder[];
	projectsRemote: unknown[];
	projectsLocal: unknown[];
	projectsMissingInLocal: unknown[];
	projectsMissingInRemote: unknown[];
	projectsModifiedInEither: unknown[];
	dtMissingInLocal: unknown[];
	dtMissingInRemote: unknown[];
	dtModifiedInEither: unknown[];
	sourceControlledFiles: SourceControlledFile[];
}

/** The id and the name of the entry for changed tag mappings. */
const TAGS_ENTRY_ID = 'tags';
const TAGS_ENTRY_NAME = 'Workflow Tags';

const now = () => new Date().toISOString();

/** The names of the folders from the top folder to `folderId`. */
function folderPath(
	folders: Map<string, { name: string; parentFolderId: string | null }>,
	folderId: string | null,
) {
	const names: string[] = [];
	const seen = new Set<string>();
	let current = folderId;
	while (current && !seen.has(current)) {
		seen.add(current);
		const folder = folders.get(current);
		if (!folder) break;
		names.unshift(folder.name);
		current = folder.parentFolderId;
	}
	return names;
}

/**
 * Fork code (not in upstream n8n): compares the instance with the files of the work folder. Each
 * type gives first the resources that only the branch has, in the order of the files, then the
 * resources of the instance that the branch does not have or that differ, in the order of the
 * database. See `README.md` in this folder.
 */
@Service()
export class SourceControlStatusService {
	constructor(private readonly resources: SourceControlResourcesService) {}

	async computeStatus(
		user: User,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlVerboseStatus> {
		const scope = await this.resources.getAccessScope(user);
		const context = await this.resources.getProjectOwners();
		const usersByEmail = await this.resources.getUsersByEmail();
		const push = options.direction === 'push';
		const files: SourceControlledFile[] = [];

		const workflows = await this.workflowStatus(scope, context, usersByEmail, options, files);
		const credentials = await this.credentialStatus(scope, context, usersByEmail, push, files);
		const variables = await this.variableStatus(push, options.preferLocalVersion, files);
		const dataTables = await this.dataTableStatus(
			scope,
			context,
			usersByEmail,
			push,
			options,
			files,
		);
		const tags = await this.tagStatus(scope, push, options.preferLocalVersion, files);
		const folders = await this.folderStatus(scope, push, options.preferLocalVersion, files);
		const projects = await this.projectStatus(scope, push, options.preferLocalVersion, files);

		return {
			...workflows,
			...credentials,
			...variables,
			...dataTables,
			...tags,
			...folders,
			...projects,
			sourceControlledFiles: files,
		};
	}

	// #region Workflows

	private async workflowStatus(
		scope: AccessScope,
		context: Awaited<ReturnType<SourceControlResourcesService['getProjectOwners']>>,
		usersByEmail: Map<string, User>,
		options: SourceControlGetStatusOptions,
		files: SourceControlledFile[],
	) {
		const push = options.direction === 'push';
		const local = await this.resources.getLocalWorkflows(scope);
		const remoteFiles = await this.resources.getRemoteWorkflows();
		const localFolders = new Map(
			(await this.resources.getLocalFolders({ projectIds: undefined })).map((folder) => [
				folder.id,
				folder,
			]),
		);
		const remoteFolders = new Map(
			(await this.resources.getRemoteFolders()).map((folder) => [folder.id, folder]),
		);

		const remote: Array<RemoteWorkflowItem & { content: ExportableWorkflow }> = [];
		for (const { file, content } of remoteFiles) {
			const project = await this.resources.resolveRemoteOwner(content.owner, context, usersByEmail);
			if (scope.projectIds !== undefined && !this.resources.inScope(scope, project?.id)) continue;
			remote.push({
				id: content.id,
				versionId: content.versionId,
				name: content.name,
				description: content.description ?? null,
				parentFolderId: content.parentFolderId ?? null,
				remoteId: content.id,
				filename: file,
				...(project ? { owner: this.resources.statusOwner(project) } : {}),
				isRemoteArchived: content.isArchived ?? false,
				content,
			});
		}
		const remoteById = new Map(remote.map((item) => [item.id, item]));
		const localById = new Map(local.map((item) => [item.id, item]));

		const localItem = (workflow: LocalWorkflow): LocalWorkflowItem => ({
			id: workflow.id,
			versionId: workflow.versionId,
			name: workflow.name,
			description: workflow.description,
			localId: workflow.id,
			parentFolderId: workflow.parentFolderId,
			filename: this.resources.workflowFile(workflow.id),
			updatedAt: workflow.updatedAt,
			...(workflow.owner ? { owner: workflow.owner } : {}),
		});
		const remoteItem = ({
			content: _content,
			...item
		}: RemoteWorkflowItem & { content: ExportableWorkflow }) => item;

		const wfMissingInLocal = remote.filter((item) => !localById.has(item.id));
		const wfMissingInRemote: LocalWorkflowItem[] = [];
		const wfModifiedInEither: Array<LocalWorkflowItem & { remoteId: string }> = [];

		for (const item of wfMissingInLocal) {
			files.push({
				id: item.id,
				name: item.name,
				type: 'workflow',
				status: push ? 'deleted' : 'created',
				location: push ? 'local' : 'remote',
				conflict: false,
				file: item.filename,
				updatedAt: now(),
				isLocalPublished: false,
				isRemoteArchived: item.isRemoteArchived,
				parentFolderId: item.parentFolderId,
				folderPath: folderPath(remoteFolders, item.parentFolderId),
				...(item.owner ? { owner: item.owner } : {}),
			});
		}

		for (const workflow of local) {
			const remoteWorkflow = remoteById.get(workflow.id);
			const base = {
				id: workflow.id,
				type: 'workflow' as const,
				location: push ? ('local' as const) : ('remote' as const),
				file: this.resources.workflowFile(workflow.id),
				updatedAt: workflow.updatedAt,
				isLocalPublished: workflow.isPublished,
				...(workflow.owner ? { owner: workflow.owner } : {}),
			};
			if (!remoteWorkflow) {
				wfMissingInRemote.push(localItem(workflow));
				files.push({
					...base,
					name: workflow.name,
					status: push ? 'created' : 'deleted',
					conflict: !push,
					isRemoteArchived: false,
					parentFolderId: workflow.parentFolderId,
					folderPath: folderPath(localFolders, workflow.parentFolderId),
				});
				continue;
			}
			if (remoteWorkflow.versionId === workflow.versionId) continue;
			const preferLocal = options.preferLocalVersion;
			const name =
				workflow.name === remoteWorkflow.name
					? workflow.name
					: preferLocal
						? `${workflow.name} (Remote: ${remoteWorkflow.name})`
						: `${remoteWorkflow.name} (Local: ${workflow.name})`;
			wfModifiedInEither.push({
				...localItem(workflow),
				name,
				localId: workflow.versionId,
				remoteId: remoteWorkflow.versionId ?? '',
			});
			const parentFolderId = preferLocal ? workflow.parentFolderId : remoteWorkflow.parentFolderId;
			files.push({
				...base,
				name,
				status: 'modified',
				conflict: true,
				isRemoteArchived: remoteWorkflow.isRemoteArchived,
				parentFolderId,
				folderPath: preferLocal
					? folderPath(localFolders, parentFolderId)
					: folderPath(remoteFolders, parentFolderId),
				remoteFolderPath: folderPath(remoteFolders, remoteWorkflow.parentFolderId),
			});
		}

		return {
			wfRemoteVersionIds: remote.map(remoteItem),
			wfLocalVersionIds: local.map(localItem),
			wfMissingInLocal: wfMissingInLocal.map(remoteItem),
			wfMissingInRemote,
			wfModifiedInEither,
		};
	}

	// #endregion

	// #region Credentials

	private async credentialStatus(
		scope: AccessScope,
		context: Awaited<ReturnType<SourceControlResourcesService['getProjectOwners']>>,
		usersByEmail: Map<string, User>,
		push: boolean,
		files: SourceControlledFile[],
	) {
		const local = await this.resources.getLocalCredentials(scope);
		const remote: Array<{
			file: string;
			content: ExportableCredential;
			owner?: StatusResourceOwner;
		}> = [];
		for (const { file, content } of await this.resources.getRemoteCredentials()) {
			const project = await this.resources.resolveRemoteOwner(
				content.ownedBy,
				context,
				usersByEmail,
			);
			if (scope.projectIds !== undefined && !this.resources.inScope(scope, project?.id)) continue;
			remote.push({ file, content, owner: this.resources.statusOwner(project) });
		}
		const localById = new Map(local.map((credential) => [credential.id, credential]));
		const remoteById = new Map(remote.map((item) => [item.content.id, item]));

		const remoteItem = (item: (typeof remote)[number]) => ({
			...item.content,
			ownedBy: item.owner ?? null,
			filename: item.file,
		});
		const localItem = (credential: LocalCredential) => ({
			id: credential.id,
			name: credential.name,
			type: credential.type,
			data: sanitizeCredentialData(credential.data),
			filename: this.resources.credentialFile(credential.id),
			ownedBy: credential.owner ?? null,
			isGlobal: credential.isGlobal,
			isResolvable: credential.isResolvable,
			resolvableAllowFallback: credential.resolvableAllowFallback,
		});

		const credMissingInLocal = remote.filter((item) => !localById.has(item.content.id));
		const credMissingInRemote: LocalCredential[] = [];
		const credModifiedInEither: LocalCredential[] = [];
		for (const item of credMissingInLocal) {
			files.push({
				id: item.content.id,
				name: item.content.name,
				type: 'credential',
				status: push ? 'deleted' : 'created',
				location: push ? 'local' : 'remote',
				conflict: false,
				file: item.file,
				updatedAt: now(),
				...(item.owner ? { owner: item.owner } : {}),
			});
		}
		for (const credential of local) {
			const remoteCredential = remoteById.get(credential.id);
			const base = {
				id: credential.id,
				type: 'credential' as const,
				location: push ? ('local' as const) : ('remote' as const),
				file: this.resources.credentialFile(credential.id),
				updatedAt: credential.updatedAt,
				...(credential.owner ? { owner: credential.owner } : {}),
			};
			if (!remoteCredential) {
				credMissingInRemote.push(credential);
				files.push({
					...base,
					name: credential.name,
					status: push ? 'created' : 'deleted',
					conflict: !push,
				});
				continue;
			}
			if (
				remoteCredential.content.name === credential.name &&
				remoteCredential.content.type === credential.type
			) {
				continue;
			}
			credModifiedInEither.push(credential);
			files.push({
				...base,
				name: push ? credential.name : remoteCredential.content.name,
				status: 'modified',
				conflict: true,
			});
		}
		return {
			credMissingInLocal: credMissingInLocal.map(remoteItem),
			credMissingInRemote: credMissingInRemote.map(localItem),
			credModifiedInEither: credModifiedInEither.map(localItem),
		};
	}

	// #endregion

	// #region Variables

	private async variableStatus(push: boolean, preferLocal: boolean, files: SourceControlledFile[]) {
		const local = await this.resources.getLocalVariables();
		const remote = await this.resources.getRemoteVariables();
		const localById = new Map(local.map((variable) => [variable.id, variable]));
		const remoteById = new Map(remote.map((variable) => [variable.id, variable]));
		const file = this.resources.variablesFile;

		const varMissingInLocal = remote.filter((variable) => !localById.has(variable.id));
		const varMissingInRemote: LocalVariable[] = [];
		const varModifiedInEither: LocalVariable[] = [];
		for (const variable of varMissingInLocal) {
			files.push({
				id: variable.id,
				name: variable.key,
				type: 'variables',
				status: push ? 'deleted' : 'created',
				location: push ? 'local' : 'remote',
				conflict: false,
				file,
				updatedAt: now(),
			});
		}
		for (const variable of local) {
			const remoteVariable = remoteById.get(variable.id);
			if (!remoteVariable) {
				varMissingInRemote.push(variable);
				files.push({
					id: variable.id,
					name: variable.key,
					type: 'variables',
					status: push ? 'created' : 'deleted',
					location: push ? 'local' : 'remote',
					conflict: !push,
					file,
					updatedAt: now(),
				});
				continue;
			}
			if (remoteVariable.key === variable.key) continue;
			varModifiedInEither.push(variable);
			files.push({
				id: variable.id,
				name: preferLocal ? variable.key : remoteVariable.key,
				type: 'variables',
				status: 'modified',
				location: push ? 'local' : 'remote',
				conflict: true,
				file,
				updatedAt: now(),
			});
		}
		// As in the original, the verbose status lists the variables of the instance with their values.
		return { varMissingInLocal, varMissingInRemote, varModifiedInEither };
	}

	// #endregion

	// #region Tags

	private async tagStatus(
		scope: AccessScope,
		push: boolean,
		preferLocal: boolean,
		files: SourceControlledFile[],
	) {
		const local = await this.resources.getLocalTags(scope);
		const remote = await this.resources.getRemoteTags();
		const localById = new Map(local.tags.map((tag) => [tag.id, tag]));
		const remoteById = new Map(remote.tags.map((tag) => [tag.id, tag]));
		const file = this.resources.tagsFile;
		const location = push ? ('local' as const) : ('remote' as const);

		const tagsMissingInLocal = remote.tags.filter((tag) => !localById.has(tag.id));
		const tagsMissingInRemote: Array<{ id: string; name: string }> = [];
		const tagsModifiedInEither: Array<{ id: string; name: string }> = [];
		const start = files.length;
		for (const tag of tagsMissingInLocal) {
			files.push({
				id: tag.id,
				name: tag.name,
				type: 'tags',
				status: push ? 'deleted' : 'created',
				location,
				conflict: false,
				file,
				updatedAt: now(),
			});
		}
		for (const tag of local.tags) {
			const remoteTag = remoteById.get(tag.id);
			if (!remoteTag) {
				tagsMissingInRemote.push(tag);
				files.push({
					id: tag.id,
					name: tag.name,
					type: 'tags',
					status: push ? 'created' : 'deleted',
					location,
					conflict: !push,
					file,
					updatedAt: now(),
				});
				continue;
			}
			if (remoteTag.name === tag.name) continue;
			tagsModifiedInEither.push(tag);
			files.push({
				id: tag.id,
				name: preferLocal ? tag.name : remoteTag.name,
				type: 'tags',
				status: 'modified',
				location,
				conflict: true,
				file,
				updatedAt: now(),
			});
		}

		const key = (mapping: { workflowId: string; tagId: string }) =>
			`${mapping.workflowId}:${mapping.tagId}`;
		const localMappings = new Set(local.mappings.map(key));
		const remoteMappings = new Set(remote.mappings.map(key));
		const mappingsMissingInLocal = remote.mappings.filter(
			(mapping) => !localMappings.has(key(mapping)),
		);
		const mappingsMissingInRemote = local.mappings.filter(
			(mapping) => !remoteMappings.has(key(mapping)),
		);
		// Changed mappings alone give one entry for the whole file.
		if (
			files.length === start &&
			(mappingsMissingInLocal.length > 0 || mappingsMissingInRemote.length > 0)
		) {
			files.push({
				id: TAGS_ENTRY_ID,
				name: TAGS_ENTRY_NAME,
				type: 'tags',
				status: 'modified',
				location,
				conflict: false,
				file,
				updatedAt: now(),
			});
		}
		return {
			tagsMissingInLocal,
			tagsMissingInRemote,
			tagsModifiedInEither,
			mappingsMissingInLocal,
			mappingsMissingInRemote,
		};
	}

	// #endregion

	// #region Folders

	private async folderStatus(
		scope: AccessScope,
		push: boolean,
		preferLocal: boolean,
		files: SourceControlledFile[],
	) {
		const local = await this.resources.getLocalFolders(scope);
		const remote = (await this.resources.getRemoteFolders()).filter((folder) =>
			this.resources.inScope(scope, folder.homeProjectId),
		);
		const localById = new Map(local.map((folder) => [folder.id, folder]));
		const remoteById = new Map(remote.map((folder) => [folder.id, folder]));
		const file = this.resources.foldersFile;
		const location = push ? ('local' as const) : ('remote' as const);

		const foldersMissingInLocal = remote.filter((folder) => !localById.has(folder.id));
		const foldersMissingInRemote: ExportableFolder[] = [];
		const foldersModifiedInEither: ExportableFolder[] = [];
		for (const folder of foldersMissingInLocal) {
			files.push({
				id: folder.id,
				name: folder.name,
				type: 'folders',
				status: push ? 'deleted' : 'created',
				location,
				conflict: false,
				file,
				updatedAt: now(),
			});
		}
		for (const folder of local) {
			const remoteFolder = remoteById.get(folder.id);
			if (!remoteFolder) {
				foldersMissingInRemote.push(folder);
				files.push({
					id: folder.id,
					name: folder.name,
					type: 'folders',
					status: push ? 'created' : 'deleted',
					location,
					conflict: !push,
					file,
					updatedAt: folder.updatedAt,
				});
				continue;
			}
			if (
				remoteFolder.name === folder.name &&
				remoteFolder.parentFolderId === folder.parentFolderId &&
				remoteFolder.homeProjectId === folder.homeProjectId
			) {
				continue;
			}
			foldersModifiedInEither.push(folder);
			files.push({
				id: folder.id,
				name: preferLocal ? folder.name : remoteFolder.name,
				type: 'folders',
				status: 'modified',
				location,
				conflict: true,
				file,
				updatedAt: folder.updatedAt,
			});
		}
		return { foldersMissingInLocal, foldersMissingInRemote, foldersModifiedInEither };
	}

	// #endregion

	// #region Projects

	private async projectStatus(
		scope: AccessScope,
		push: boolean,
		preferLocal: boolean,
		files: SourceControlledFile[],
	) {
		const local = await this.resources.getLocalProjects(scope);
		const remote = (await this.resources.getRemoteProjects()).filter(({ content }) =>
			this.resources.inScope(scope, content.id),
		);
		const localById = new Map(local.map((project) => [project.id, project]));
		const remoteById = new Map(remote.map((item) => [item.content.id, item]));
		const location = push ? ('local' as const) : ('remote' as const);

		const remoteItem = (item: { file: string; content: ExportableProject }) => ({
			...item.content,
			filename: item.file,
		});
		const localItem = (project: LocalProject) => ({
			id: project.id,
			name: project.name,
			description: project.description,
			icon: project.icon,
			filename: this.resources.projectFile(project.id),
			type: 'team',
			owner: { type: 'team', teamId: project.id, teamName: project.name },
			variableStubs: project.variableStubs,
		});
		const owner = (id: string, name: string): StatusResourceOwner => ({
			type: 'team',
			projectId: id,
			projectName: name,
		});

		const projectsMissingInLocal = remote.filter((item) => !localById.has(item.content.id));
		const projectsMissingInRemote: LocalProject[] = [];
		const projectsModifiedInEither: LocalProject[] = [];
		for (const item of projectsMissingInLocal) {
			files.push({
				id: item.content.id,
				name: item.content.name,
				type: 'project',
				status: push ? 'deleted' : 'created',
				location,
				conflict: false,
				file: item.file,
				updatedAt: now(),
				owner: owner(item.content.id, item.content.name),
			});
		}
		for (const project of local) {
			const remoteProject = remoteById.get(project.id);
			const file = this.resources.projectFile(project.id);
			if (!remoteProject) {
				projectsMissingInRemote.push(project);
				// A pull does not delete projects, so its status leaves them out.
				if (!push) continue;
				files.push({
					id: project.id,
					name: project.name,
					type: 'project',
					status: push ? 'created' : 'deleted',
					location,
					conflict: !push,
					file,
					updatedAt: project.updatedAt,
					owner: owner(project.id, project.name),
				});
				continue;
			}
			if (!this.isProjectModified(project, remoteProject.content)) continue;
			projectsModifiedInEither.push(project);
			const name = preferLocal ? project.name : remoteProject.content.name;
			files.push({
				id: project.id,
				name,
				type: 'project',
				status: 'modified',
				location,
				conflict: true,
				file,
				updatedAt: project.updatedAt,
				owner: owner(project.id, name),
			});
		}
		return {
			projectsRemote: remote.map(remoteItem),
			projectsLocal: local.map(localItem),
			projectsMissingInLocal: projectsMissingInLocal.map(remoteItem),
			projectsMissingInRemote: projectsMissingInRemote.map(localItem),
			projectsModifiedInEither: projectsModifiedInEither.map(localItem),
		};
	}

	private isProjectModified(local: LocalProject, remote: ExportableProject) {
		const stubs = (variables: ExportableVariable[]) =>
			JSON.stringify(variables.map(({ id, key }) => ({ id, key })));
		return (
			local.name !== remote.name ||
			(local.description ?? null) !== (remote.description ?? null) ||
			JSON.stringify(local.icon ?? null) !== JSON.stringify(remote.icon ?? null) ||
			stubs(local.variableStubs) !== stubs(remote.variableStubs ?? [])
		);
	}

	// #endregion

	// #region Data tables

	private async dataTableStatus(
		scope: AccessScope,
		context: Awaited<ReturnType<SourceControlResourcesService['getProjectOwners']>>,
		usersByEmail: Map<string, User>,
		push: boolean,
		options: SourceControlGetStatusOptions,
		files: SourceControlledFile[],
	) {
		const local = await this.resources.getLocalDataTables(scope);
		const remote: Array<{
			file: string;
			content: ExportableDataTable;
			owner?: StatusResourceOwner;
		}> = [];
		for (const { file, content } of await this.resources.getRemoteDataTables()) {
			const project = await this.resources.resolveRemoteOwner(
				content.ownedBy,
				context,
				usersByEmail,
			);
			if (scope.projectIds !== undefined && !this.resources.inScope(scope, project?.id)) continue;
			remote.push({ file, content, owner: this.resources.statusOwner(project) });
		}
		const localById = new Map(local.map((table) => [table.id, table]));
		const remoteById = new Map(remote.map((item) => [item.content.id, item]));
		const location = push ? ('local' as const) : ('remote' as const);

		const localItem = (table: LocalDataTable) => ({
			id: table.id,
			name: table.name,
			columns: table.columns,
			ownedBy: table.owner ?? null,
			filename: this.resources.dataTableFile(table.id),
			createdAt: table.createdAt,
			updatedAt: table.updatedAt,
		});

		const dtMissingInLocal = remote.filter((item) => !localById.has(item.content.id));
		const dtMissingInRemote: LocalDataTable[] = [];
		const dtModifiedInEither: LocalDataTable[] = [];
		for (const item of dtMissingInLocal) {
			files.push({
				id: item.content.id,
				name: item.content.name,
				type: 'datatable',
				status: push ? 'deleted' : 'created',
				location,
				conflict: false,
				file: item.file,
				updatedAt: now(),
				...(item.owner ? { owner: item.owner } : {}),
			});
		}
		for (const table of local) {
			const remoteTable = remoteById.get(table.id);
			const file = this.resources.dataTableFile(table.id);
			const owner = table.owner ? { owner: table.owner } : {};
			if (!remoteTable) {
				dtMissingInRemote.push(table);
				files.push({
					id: table.id,
					name: table.name,
					type: 'datatable',
					status: push ? 'created' : 'deleted',
					location,
					conflict: !push,
					file,
					updatedAt: table.updatedAt,
					...owner,
				});
				continue;
			}
			const columns = (value: ExportableDataTable['columns']) =>
				JSON.stringify(value.map(({ id, name, type, index }) => ({ id, name, type, index })));
			if (
				remoteTable.content.name === table.name &&
				columns(remoteTable.content.columns ?? []) === columns(table.columns)
			) {
				continue;
			}
			dtModifiedInEither.push(table);
			files.push({
				id: table.id,
				name: options.preferLocalVersion ? table.name : remoteTable.content.name,
				type: 'datatable',
				status: 'modified',
				location,
				conflict: true,
				file,
				updatedAt: table.updatedAt,
				...owner,
			});
		}
		return {
			dtMissingInLocal: dtMissingInLocal.map((item) => item.content),
			dtMissingInRemote: dtMissingInRemote.map(localItem),
			dtModifiedInEither: dtModifiedInEither.map(localItem),
		};
	}

	// #endregion
}
