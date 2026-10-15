import { ModuleRegistry } from '@n8n/backend-common';
import type { Project, User } from '@n8n/db';
import {
	CredentialsRepository,
	FolderRepository,
	ProjectRelationRepository,
	ProjectRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
	TagRepository,
	UserRepository,
	VariablesRepository,
	WorkflowRepository,
	WorkflowTagMappingRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { hasGlobalScope } from '@n8n/permissions';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Cipher } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';

import { DataTableColumnRepository } from '@/modules/data-table/data-table-column.repository';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';
import { ProjectService } from '@/services/project.service';

import {
	SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER,
	SOURCE_CONTROL_DATA_TABLE_EXPORT_FOLDER,
	SOURCE_CONTROL_FOLDERS_EXPORT_FILE,
	SOURCE_CONTROL_PROJECT_EXPORT_FOLDER,
	SOURCE_CONTROL_TAGS_EXPORT_FILE,
	SOURCE_CONTROL_VARIABLES_EXPORT_FILE,
	SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER,
} from './constants';
import { SourceControlPreferencesService } from './source-control-preferences.service';
import type {
	ExportableCredential,
	ExportableDataTable,
	ExportableFolder,
	ExportableFolders,
	ExportableProject,
	ExportableTags,
	ExportableVariable,
	ExportableWorkflow,
	RemoteResourceOwner,
	StatusResourceOwner,
} from './types/exportable';

/** A workflow of the instance, as the status compares it. */
export interface LocalWorkflow {
	id: string;
	name: string;
	versionId: string;
	description: string | null;
	parentFolderId: string | null;
	updatedAt: string;
	isPublished: boolean;
	isArchived: boolean;
	owner: StatusResourceOwner | undefined;
}

export interface LocalCredential {
	id: string;
	name: string;
	type: string;
	data: Record<string, unknown>;
	updatedAt: string;
	isGlobal: boolean;
	isResolvable: boolean;
	resolvableAllowFallback: boolean;
	owner: StatusResourceOwner | undefined;
}

/** A global variable of the instance, with its value. */
export interface LocalVariable extends ExportableVariable {
	project: null;
}

export interface LocalDataTable extends ExportableDataTable {
	projectId: string;
	owner: StatusResourceOwner | undefined;
}

export interface LocalProject {
	id: string;
	name: string;
	description: string | null;
	icon: unknown;
	updatedAt: string;
	variableStubs: ExportableVariable[];
}

/** The resources that a user may see in source control. */
export interface AccessScope {
	/** `undefined`: all projects. */
	projectIds: Set<string> | undefined;
}

const toIso = (value: Date | string | null | undefined) =>
	value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString());

/** Strings become empty unless they are expressions. Numbers and booleans stay. `null` goes. */
export function sanitizeCredentialData(value: unknown): unknown {
	if (typeof value === 'string') return value.startsWith('={{') ? value : '';
	if (Array.isArray(value)) return value.map(sanitizeCredentialData);
	if (value !== null && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === null || entry === undefined) continue;
			result[key] = sanitizeCredentialData(entry);
		}
		return result;
	}
	return value;
}

/** The data of a credential stub. See {@link sanitizeCredentialData}. */
export function sanitizeCredentialObject(data: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(data)) {
		if (entry === null || entry === undefined) continue;
		result[key] = sanitizeCredentialData(entry);
	}
	return result;
}

/**
 * Fork code (not in upstream n8n): reads the resources of source control, from the database and
 * from the files of the work folder. The status, the export and the import use it.
 */
@Service()
export class SourceControlResourcesService {
	constructor(
		private readonly preferencesService: SourceControlPreferencesService,
		private readonly workflowRepository: WorkflowRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly variablesRepository: VariablesRepository,
		private readonly tagRepository: TagRepository,
		private readonly tagMappingRepository: WorkflowTagMappingRepository,
		private readonly folderRepository: FolderRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly userRepository: UserRepository,
		private readonly dataTableRepository: DataTableRepository,
		private readonly dataTableColumnRepository: DataTableColumnRepository,
		private readonly projectService: ProjectService,
		private readonly cipher: Cipher,
		private readonly moduleRegistry: ModuleRegistry,
	) {}

	/** Data tables take part only while the data table module runs. */
	private get dataTablesActive() {
		return this.moduleRegistry.isActive('data-table');
	}

	get gitFolder() {
		return this.preferencesService.gitFolder;
	}

	// #region Access

	/**
	 * A user with the global scope `sourceControl:push` sees all resources. Another user sees the
	 * resources of the team projects where the user has `sourceControl:push`.
	 */
	async getAccessScope(user: User): Promise<AccessScope> {
		if (hasGlobalScope(user, 'sourceControl:push')) return { projectIds: undefined };
		const ids = await this.projectService.getProjectIdsWithScope(user, ['sourceControl:push']);
		return { projectIds: new Set(ids) };
	}

	inScope(scope: AccessScope, projectId: string | undefined) {
		return scope.projectIds === undefined || (!!projectId && scope.projectIds.has(projectId));
	}

	// #endregion

	// #region Owners

	/** The projects by id, with the owner of each personal project. */
	async getProjectOwners() {
		const projects = await this.projectRepository.find();
		const relations = await this.projectRelationRepository.find({
			where: { role: { slug: 'project:personalOwner' } },
			relations: { user: true },
		});
		const personalOwners = new Map<string, User>();
		for (const relation of relations) personalOwners.set(relation.projectId, relation.user);
		return { projects: new Map(projects.map((project) => [project.id, project])), personalOwners };
	}

	statusOwner(project: Project | undefined): StatusResourceOwner | undefined {
		if (!project) return undefined;
		return {
			type: project.type === 'personal' ? 'personal' : 'team',
			projectId: project.id,
			projectName: project.name,
		};
	}

	/** The owner of a resource in a file. */
	remoteOwner(
		project: Project | undefined,
		personalOwners: Map<string, User>,
	): RemoteResourceOwner | undefined {
		if (!project) return undefined;
		if (project.type === 'personal') {
			return {
				type: 'personal',
				projectId: project.id,
				projectName: project.name,
				personalEmail: personalOwners.get(project.id)?.email ?? '',
			};
		}
		return { type: 'team', teamId: project.id, teamName: project.name };
	}

	/** The local project of the owner in a file: the personal project of the user with the email, or the team project with the id. */
	async resolveRemoteOwner(
		owner:
			| RemoteResourceOwner
			| { type: 'team'; projectId: string; projectName: string }
			| null
			| undefined,
		context: Awaited<ReturnType<SourceControlResourcesService['getProjectOwners']>>,
		usersByEmail: Map<string, User>,
	): Promise<Project | undefined> {
		if (!owner) return undefined;
		if (owner.type === 'personal') {
			const user = usersByEmail.get(owner.personalEmail);
			if (!user) return undefined;
			for (const [projectId, owningUser] of context.personalOwners) {
				if (owningUser.id === user.id) return context.projects.get(projectId);
			}
			return undefined;
		}
		const id = 'teamId' in owner ? owner.teamId : owner.projectId;
		const project = context.projects.get(id);
		return project?.type === 'team' ? project : undefined;
	}

	async getUsersByEmail() {
		const users = await this.userRepository.find();
		return new Map(users.map((user) => [user.email, user]));
	}

	// #endregion

	// #region Local resources

	async getLocalWorkflows(scope: AccessScope): Promise<LocalWorkflow[]> {
		const workflows = await this.workflowRepository.find({
			select: {
				id: true,
				name: true,
				versionId: true,
				description: true,
				parentFolder: { id: true },
				updatedAt: true,
				activeVersionId: true,
				isArchived: true,
			},
			relations: { parentFolder: true },
		});
		const owners = await this.getWorkflowOwnerProjects();
		return workflows
			.map((workflow) => {
				const project = owners.get(workflow.id);
				return {
					id: workflow.id,
					name: workflow.name,
					versionId: workflow.versionId,
					description: workflow.description ?? null,
					parentFolderId: workflow.parentFolder?.id ?? null,
					updatedAt: toIso(workflow.updatedAt),
					isPublished: !!workflow.activeVersionId,
					isArchived: workflow.isArchived,
					owner: this.statusOwner(project),
				};
			})
			.filter((workflow) => this.inScope(scope, workflow.owner?.projectId));
	}

	/** The owner project of each workflow. */
	async getWorkflowOwnerProjects() {
		const shared = await this.sharedWorkflowRepository.find({
			where: { role: 'workflow:owner' },
			relations: { project: true },
		});
		return new Map(shared.map((entry) => [entry.workflowId, entry.project]));
	}

	async getLocalCredentials(scope: AccessScope): Promise<LocalCredential[]> {
		const credentials = await this.credentialsRepository.find();
		const shared = await this.sharedCredentialsRepository.find({
			where: { role: 'credential:owner' },
			relations: { project: true },
		});
		const owners = new Map(shared.map((entry) => [entry.credentialsId, entry.project]));
		const result: LocalCredential[] = [];
		for (const credential of credentials) {
			const project = owners.get(credential.id);
			if (!this.inScope(scope, project?.id)) continue;
			let data: Record<string, unknown> = {};
			try {
				data = jsonParse<Record<string, unknown>>(await this.cipher.decryptV2(credential.data), {
					fallbackValue: {},
				});
			} catch {
				data = {};
			}
			result.push({
				id: credential.id,
				name: credential.name,
				type: credential.type,
				data,
				updatedAt: toIso(credential.updatedAt),
				isGlobal: credential.isGlobal ?? false,
				isResolvable: credential.isResolvable ?? false,
				resolvableAllowFallback: credential.resolvableAllowFallback ?? false,
				owner: this.statusOwner(project),
			});
		}
		return result;
	}

	/** The global variables, with their values. Project variables are part of their project. */
	async getLocalVariables(): Promise<LocalVariable[]> {
		const variables = await this.variablesRepository.find({ relations: { project: true } });
		return variables
			.filter((variable) => !variable.project)
			.map((variable) => ({
				id: variable.id,
				key: variable.key,
				type: variable.type ?? 'string',
				value: variable.value,
				project: null,
			}));
	}

	async getLocalTags(scope: AccessScope): Promise<ExportableTags> {
		const tags = await this.tagRepository.find({ select: { id: true, name: true } });
		const mappings = await this.tagMappingRepository.find();
		let workflowIds: Set<string> | undefined;
		if (scope.projectIds !== undefined) {
			const owners = await this.getWorkflowOwnerProjects();
			workflowIds = new Set(
				[...owners].filter(([, project]) => this.inScope(scope, project?.id)).map(([id]) => id),
			);
		}
		return {
			tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
			mappings: mappings
				.filter((mapping) => !workflowIds || workflowIds.has(mapping.workflowId))
				.map((mapping) => ({ workflowId: mapping.workflowId, tagId: mapping.tagId })),
		};
	}

	async getLocalFolders(scope: AccessScope): Promise<ExportableFolder[]> {
		const folders = (await this.folderRepository.find({ relations: { homeProject: true } })).filter(
			(folder) => this.inScope(scope, folder.homeProject?.id),
		);
		// For a user with some projects, the original reads the folders through the index of the
		// project and the id, so they come in that order.
		if (scope.projectIds !== undefined) {
			const key = (folder: (typeof folders)[number]) =>
				`${folder.homeProject?.id ?? ''}\u0000${folder.id}`;
			folders.sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
		}
		return folders.map((folder) => ({
			id: folder.id,
			name: folder.name,
			parentFolderId: folder.parentFolderId ?? null,
			homeProjectId: folder.homeProject?.id ?? '',
			createdAt: toIso(folder.createdAt),
			updatedAt: toIso(folder.updatedAt),
		}));
	}

	/** The team projects, each with the stubs of its variables. */
	async getLocalProjects(scope: AccessScope): Promise<LocalProject[]> {
		const projects = await this.projectRepository.find({ where: { type: 'team' } });
		const variables = await this.variablesRepository.find({ relations: { project: true } });
		return projects
			.filter((project) => this.inScope(scope, project.id))
			.map((project) => ({
				id: project.id,
				name: project.name,
				description: project.description ?? null,
				icon: project.icon ?? null,
				updatedAt: toIso(project.updatedAt),
				variableStubs: variables
					.filter((variable) => variable.project?.id === project.id)
					.map((variable) => ({
						id: variable.id,
						key: variable.key,
						type: variable.type ?? 'string',
						value: '',
					})),
			}));
	}

	async getLocalDataTables(scope: AccessScope): Promise<LocalDataTable[]> {
		if (!this.dataTablesActive) return [];
		const tables = await this.dataTableRepository.find({ relations: { project: true } });
		const columns = await this.dataTableColumnRepository.find();
		const context = await this.getProjectOwners();
		return tables
			.filter((table) => this.inScope(scope, table.projectId))
			.map((table) => {
				const project = context.projects.get(table.projectId);
				return {
					id: table.id,
					name: table.name,
					columns: columns
						.filter((column) => column.dataTableId === table.id)
						.sort((left, right) => left.index - right.index)
						.map((column) => ({
							id: column.id,
							name: column.name,
							type: column.type,
							index: column.index,
						})),
					ownedBy:
						this.remoteOwner(project, context.personalOwners) ??
						({ type: 'team', teamId: table.projectId, teamName: '' } as const),
					createdAt: toIso(table.createdAt),
					updatedAt: toIso(table.updatedAt),
					projectId: table.projectId,
					owner: this.statusOwner(project),
				};
			});
	}

	// #endregion

	// #region Files of the work folder

	filePath(...parts: string[]) {
		return path.join(this.gitFolder, ...parts);
	}

	workflowFile(id: string) {
		return this.filePath(SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER, `${id}.json`);
	}

	credentialFile(id: string) {
		return this.filePath(SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER, `${id}.json`);
	}

	dataTableFile(id: string) {
		return this.filePath(SOURCE_CONTROL_DATA_TABLE_EXPORT_FOLDER, `${id}.json`);
	}

	projectFile(id: string) {
		return this.filePath(SOURCE_CONTROL_PROJECT_EXPORT_FOLDER, `${id}.json`);
	}

	get variablesFile() {
		return this.filePath(SOURCE_CONTROL_VARIABLES_EXPORT_FILE);
	}

	get tagsFile() {
		return this.filePath(SOURCE_CONTROL_TAGS_EXPORT_FILE);
	}

	get foldersFile() {
		return this.filePath(SOURCE_CONTROL_FOLDERS_EXPORT_FILE);
	}

	private async readJsonFiles<T>(folder: string): Promise<Array<{ file: string; content: T }>> {
		const directory = this.filePath(folder);
		if (!existsSync(directory)) return [];
		const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
		const result: Array<{ file: string; content: T }> = [];
		for (const name of names) {
			const file = path.join(directory, name);
			const content = jsonParse<T | null>(await readFile(file, 'utf8'), { fallbackValue: null });
			if (content) result.push({ file, content });
		}
		return result;
	}

	private async readJsonFile<T>(file: string, fallback: T): Promise<T> {
		if (!existsSync(file)) return fallback;
		return jsonParse<T>(await readFile(file, 'utf8'), { fallbackValue: fallback });
	}

	async getRemoteWorkflows() {
		return await this.readJsonFiles<ExportableWorkflow>(SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER);
	}

	async getRemoteCredentials() {
		return await this.readJsonFiles<ExportableCredential>(SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER);
	}

	async getRemoteDataTables() {
		if (!this.dataTablesActive) return [];
		return await this.readJsonFiles<ExportableDataTable>(SOURCE_CONTROL_DATA_TABLE_EXPORT_FOLDER);
	}

	async getRemoteProjects() {
		return await this.readJsonFiles<ExportableProject>(SOURCE_CONTROL_PROJECT_EXPORT_FOLDER);
	}

	async getRemoteVariables(): Promise<ExportableVariable[]> {
		const variables = await this.readJsonFile<ExportableVariable[]>(this.variablesFile, []);
		return Array.isArray(variables) ? variables : [];
	}

	async getRemoteTags(): Promise<ExportableTags> {
		const tags = await this.readJsonFile<Partial<ExportableTags>>(this.tagsFile, {});
		return { tags: tags.tags ?? [], mappings: tags.mappings ?? [] };
	}

	async getRemoteFolders(): Promise<ExportableFolder[]> {
		const folders = await this.readJsonFile<Partial<ExportableFolders>>(this.foldersFile, {});
		return folders.folders ?? [];
	}

	// #endregion
}
