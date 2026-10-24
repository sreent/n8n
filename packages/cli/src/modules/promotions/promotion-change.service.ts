import type {
	PromotableResource,
	PromotableResourceStatus,
	PromotionConnectionChanges,
	PromotionChangesQueryDto,
	PromotionDirection,
} from '@n8n/api-types';
import type { User } from '@n8n/db';
import { VariablesRepository, WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';
import path from 'node:path';

import { HashingPackageWriter } from '@/modules/n8n-packages/io/hashing-package-writer';
import { PACKAGE_ENTITY_LAYOUT } from '@/modules/n8n-packages/io/manifest-entry';
import { N8nPackagesService } from '@/modules/n8n-packages/n8n-packages.service';
import {
	packageManifestSchema,
	type PackageManifest,
} from '@/modules/n8n-packages/spec/manifest.schema';
import type { PackageRequirements } from '@/modules/n8n-packages/spec/requirements.schema';

import type { PromotionConfig } from './database/entities/promotion-config.entity';
import type { PromotionConnection } from './database/entities/promotion-connection.entity';
import { checkoutBranchOf, PromotionCheckouts } from './promotion-checkouts';
import { PromotionGitRunner } from './promotion-git';
import { PromotionProvidersService } from './promotion-providers.service';
import { PromotionTargets } from './promotion-targets';
import { PROMOTION_PACKAGE_FOLDER } from './promotions.constants';

/** The folders of the branch that the change list reads. */
const BRANCH_FOLDERS = ['projects', 'credentials', 'data-tables', 'variables', 'tags'];

const WORKFLOW_FILE = 'workflow.json';

/** A workflow of the package: its folder in the package and the Git hash of `workflow.json`. */
interface PackageWorkflow {
	id: string;
	folder: string;
	blob: string;
}

/** The entities that a workflow uses and that the package has as files of their own. */
const DEPENDENCY_KINDS = ['credentials', 'dataTables', 'tags'] as const;

/** The workflow id at the end of the folder name `<slug>-<id>`. */
function idOfFolder(folder: string) {
	const name = path.posix.basename(folder);
	return name.slice(name.lastIndexOf('-') + 1);
}

/** The slug at the start of the folder name `<slug>-<id>`. */
function slugOfFolder(folder: string) {
	const name = path.posix.basename(folder);
	return name.slice(0, name.lastIndexOf('-'));
}

/** Whether the workflow is one of the consumers of a requirement. */
function isUsedByWorkflow(
	requirement: { usedBy: Array<{ kind: string; id: string }> },
	workflowId: string,
) {
	return requirement.usedBy.some(({ kind, id }) => kind === 'workflow' && id === workflowId);
}

/** The number of credentials, data tables, sub-workflows, variables and tags that a workflow uses. */
function dependencyCount(requirements: PackageRequirements | undefined, workflowId: string) {
	if (!requirements) return 0;
	const lists = [
		requirements.credentials,
		requirements.dataTables,
		requirements.workflows,
		requirements.variables,
		requirements.tags,
	];
	let count = 0;
	for (const list of lists) {
		for (const entry of list ?? []) {
			if (isUsedByWorkflow(entry, workflowId)) count++;
		}
	}
	return count;
}

/** The folder of the project of a workflow: `projects/<slug>-<id>`. */
function projectFolderOf(workflowFolder: string) {
	return workflowFolder.split('/').slice(0, 2).join('/');
}

type VariableScope = 'global' | 'project';

/** What a package has for the credentials, data tables, tags and variables of one workflow. */
interface Dependencies {
	/** Credentials, data tables and tags: the folder of the entity and the Git hash of its file. */
	entities: Map<string, string>;
	/** Variables by name: the scopes in which the package has a variable with that name. */
	variables: Map<string, Set<VariableScope>>;
}

/**
 * The dependencies of a workflow in a package, from the requirements of the package. A variable
 * counts by its scope only: its id, its folder and its value are not a change. Sub-workflows and
 * node types do not count.
 */
function dependenciesOf(
	manifest: PackageManifest | undefined,
	blobOf: (file: string) => string | undefined,
	workflowId: string,
	workflowFolder: string,
): Dependencies {
	const dependencies: Dependencies = { entities: new Map(), variables: new Map() };
	const requirements = manifest?.requirements;
	if (!manifest || !requirements) return dependencies;
	for (const kind of DEPENDENCY_KINDS) {
		for (const requirement of requirements[kind] ?? []) {
			if (!isUsedByWorkflow(requirement, workflowId)) continue;
			const { id } = requirement;
			const entry = manifest[kind]?.find((candidate) => candidate.id === id);
			const file = entry ? `${entry.target}/${PACKAGE_ENTITY_LAYOUT[kind].fileName}` : undefined;
			dependencies.entities.set(
				`${kind}:${id}`,
				entry && file ? `${entry.target}:${blobOf(file) ?? ''}` : '',
			);
		}
	}
	const projectVariables = `${projectFolderOf(workflowFolder)}/variables/`;
	for (const requirement of requirements.variables ?? []) {
		if (!isUsedByWorkflow(requirement, workflowId)) continue;
		const { name } = requirement;
		const scopes = new Set<VariableScope>();
		for (const entry of manifest.variables ?? []) {
			if (entry.name !== name) continue;
			if (entry.target.startsWith('variables/')) scopes.add('global');
			else if (entry.target.startsWith(projectVariables)) scopes.add('project');
		}
		dependencies.variables.set(name, scopes);
	}
	return dependencies;
}

/**
 * Credentials, data tables and tags change when the two sides differ. For `promote`, a variable
 * changes when the scopes of the two sides differ. For `apply`, a variable changes only when this
 * instance has no variable with that name in a scope of the branch, because an apply keeps the
 * variables of this instance.
 */
function dependenciesDiffer(
	direction: PromotionDirection,
	local: Dependencies,
	branch: Dependencies,
	instanceVariables: Map<string, Set<VariableScope>>,
) {
	if (local.entities.size !== branch.entities.size) return true;
	for (const [key, value] of local.entities) {
		if (branch.entities.get(key) !== value) return true;
	}
	const none = new Set<VariableScope>();
	if (direction === 'apply') {
		for (const [name, scopes] of branch.variables) {
			const here = instanceVariables.get(name) ?? none;
			if ([...scopes].some((scope) => !here.has(scope))) return true;
		}
		return false;
	}
	for (const name of new Set([...local.variables.keys(), ...branch.variables.keys()])) {
		const here = local.variables.get(name) ?? none;
		const there = branch.variables.get(name) ?? none;
		if (here.size !== there.size || [...there].some((scope) => !here.has(scope))) return true;
	}
	return false;
}

const compareText = (a: string, b: string) => a.localeCompare(b);

/**
 * Fork code (not in upstream n8n): the change list of a team project. It compares what a
 * promotion of the project writes now with the branch of the configuration, after a fetch. For
 * `promote`, a row tells what a promotion changes on the branch. For `apply`, a row tells what an
 * apply changes on this instance. See `README.md`.
 */
@Service()
export class PromotionChangeService {
	constructor(
		private readonly targets: PromotionTargets,
		private readonly checkouts: PromotionCheckouts,
		private readonly git: PromotionGitRunner,
		private readonly providersService: PromotionProvidersService,
		private readonly packagesService: N8nPackagesService,
		private readonly workflowRepository: WorkflowRepository,
		private readonly variablesRepository: VariablesRepository,
	) {}

	async getChanges(
		user: User,
		projectId: string,
		direction: PromotionDirection,
		query: Pick<PromotionChangesQueryDto, 'search' | 'sort' | 'order'>,
	): Promise<PromotionConnectionChanges> {
		const { project, connection, config } = await this.targets.forProject(projectId, direction);
		await this.targets.assertCloned(connection, config, 'branch files');

		const commitSha = await this.fetchBranch(connection, config);
		const repository = this.checkouts.repository(config.id);
		const branchFiles = await this.listBranchFiles(repository, commitSha);
		const branchWorkflows = this.projectWorkflows(branchFiles, project.id);

		const writer = new HashingPackageWriter();
		const { manifest } = await this.packagesService.exportPackageToWriter(
			// Git connections move workflows only, so the package keeps agents out.
			{ user, projectIds: [project.id], includeArchivedWorkflows: true, includeAgents: false },
			writer,
		);
		const hashes = new Map(writer.finalize().map(({ path: file, blobSha }) => [file, blobSha]));
		const instanceWorkflows = new Map<string, PackageWorkflow>();
		for (const entry of manifest.workflows ?? []) {
			instanceWorkflows.set(entry.id, {
				id: entry.id,
				folder: entry.target,
				blob: hashes.get(`${entry.target}/${WORKFLOW_FILE}`) ?? '',
			});
		}

		const ids = [...new Set([...instanceWorkflows.keys(), ...branchWorkflows.keys()])];
		// Apply always reads the manifest of the branch. Promote reads it to compare the
		// dependencies of the workflows that both sides have.
		const branchManifest =
			direction === 'apply' ||
			ids.some((id) => instanceWorkflows.has(id) && branchWorkflows.has(id))
				? await this.readBranchManifest(repository, commitSha)
				: undefined;
		const instanceVariables =
			direction === 'apply'
				? await this.variableScopes(project.id)
				: new Map<string, Set<VariableScope>>();
		const dependenciesChanged = (id: string, local: PackageWorkflow, branch: PackageWorkflow) =>
			dependenciesDiffer(
				direction,
				dependenciesOf(manifest, (file) => hashes.get(file), id, local.folder),
				dependenciesOf(branchManifest, (file) => branchFiles.get(file), id, branch.folder),
				instanceVariables,
			);
		const stored = await this.workflowRepository.findByIds(ids, {
			fields: ['id', 'name', 'isArchived', 'versionCounter', 'updatedAt'],
		});
		const storedById = new Map(stored.map((workflow) => [workflow.id, workflow]));

		const rows: PromotableResource[] = [];
		for (const id of ids) {
			const local = instanceWorkflows.get(id);
			const branch = branchWorkflows.get(id);
			const row = await this.toRow({
				id,
				direction,
				local,
				branch,
				stored: storedById.get(id),
				localRequirements: manifest.requirements,
				branchManifest,
				dependenciesChanged,
				readBranchWorkflow: async (folder) =>
					await this.readBranchWorkflow(repository, commitSha, folder),
			});
			if (row) rows.push(row);
		}

		const search = query.search?.toLowerCase();
		const filtered = search ? rows.filter(({ name }) => name.toLowerCase().includes(search)) : rows;
		return { commitSha, changes: sortRows(filtered, query.sort, query.order) };
	}

	private async toRow({
		id,
		direction,
		local,
		branch,
		stored,
		localRequirements,
		branchManifest,
		dependenciesChanged,
		readBranchWorkflow,
	}: {
		id: string;
		direction: PromotionDirection;
		local: PackageWorkflow | undefined;
		branch: PackageWorkflow | undefined;
		stored:
			| { name: string; isArchived: boolean; versionCounter: number; updatedAt: Date }
			| undefined;
		localRequirements: PackageRequirements | undefined;
		branchManifest: PackageManifest | undefined;
		dependenciesChanged: (id: string, local: PackageWorkflow, branch: PackageWorkflow) => boolean;
		readBranchWorkflow: (folder: string) => Promise<{ isArchived?: boolean } | undefined>;
	}): Promise<PromotableResource | undefined> {
		const instanceFields = {
			version: stored?.versionCounter ?? null,
			updatedAt: stored?.updatedAt.toISOString() ?? null,
			updatedBy: null,
		};
		const branchName = () =>
			branchManifest?.workflows?.find((entry) => entry.id === id)?.name ??
			(branch ? slugOfFolder(branch.folder) : id);

		if (direction === 'promote') {
			if (local && !branch) {
				return this.row(id, stored?.name ?? id, 'new', instanceFields, localRequirements);
			}
			if (!local && branch) {
				return {
					id,
					name: slugOfFolder(branch.folder),
					type: 'workflow',
					status: 'deleted',
					version: null,
					updatedAt: null,
					updatedBy: null,
					dependencyCount: 0,
				};
			}
		} else {
			if (!local && branch) {
				return {
					id,
					name: branchName(),
					type: 'workflow',
					status: 'new',
					version: null,
					updatedAt: null,
					updatedBy: null,
					dependencyCount: dependencyCount(branchManifest?.requirements, id),
				};
			}
			if (local && !branch) {
				return this.row(id, stored?.name ?? id, 'deleted', instanceFields, localRequirements);
			}
		}
		if (!local || !branch) return undefined;

		const renamed = local.folder !== branch.folder;
		const modified = local.blob !== branch.blob || dependenciesChanged(id, local, branch);
		if (!renamed && !modified) return undefined;

		let status: PromotableResourceStatus = renamed
			? modified
				? 'renamed-and-modified'
				: 'renamed'
			: 'modified';
		if (direction === 'promote') {
			if (modified && stored?.isArchived) status = 'archived';
			return this.row(id, stored?.name ?? id, status, instanceFields, localRequirements);
		}
		if (modified) {
			const branchWorkflow = await readBranchWorkflow(branch.folder);
			if (branchWorkflow?.isArchived && !stored?.isArchived) status = 'archived';
		}
		return this.row(id, branchName(), status, instanceFields, branchManifest?.requirements);
	}

	private row(
		id: string,
		name: string,
		status: PromotableResourceStatus,
		fields: Pick<PromotableResource, 'version' | 'updatedAt' | 'updatedBy'>,
		requirements: PackageRequirements | undefined,
	): PromotableResource {
		return {
			id,
			name,
			type: 'workflow',
			status,
			...fields,
			dependencyCount: dependencyCount(requirements, id),
		};
	}

	/** The variables of this instance for a project, by name: global, of the project, or both. */
	private async variableScopes(projectId: string) {
		const scopes = new Map<string, Set<VariableScope>>();
		for (const variable of await this.variablesRepository.find({ relations: { project: true } })) {
			const scope: VariableScope | undefined = !variable.project
				? 'global'
				: variable.project.id === projectId
					? 'project'
					: undefined;
			if (!scope) continue;
			const names = scopes.get(variable.key) ?? new Set<VariableScope>();
			names.add(scope);
			scopes.set(variable.key, names);
		}
		return scopes;
	}

	/** Fetches the branch of the configuration, and gives its newest commit. */
	private async fetchBranch(connection: PromotionConnection, config: PromotionConfig) {
		const repository = this.checkouts.repository(config.id);
		const branchName = checkoutBranchOf(config);
		const provider = await this.providersService.getEntity(connection.providerId);
		const credentials = await this.providersService.decryptCredentials(provider);
		await this.git.withRemote(
			{
				remoteUrl: connection.target.remoteUrl,
				credentials,
				knownHostsFile: this.checkouts.knownHostsFile(config.id),
			},
			async (git) =>
				await git(repository, [
					'fetch',
					'--no-tags',
					'origin',
					`+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
				]),
		);
		return (
			await this.git.run(repository, ['rev-parse', `refs/remotes/origin/${branchName}`])
		).trim();
	}

	/** The files of the package folders of a commit, with their Git hashes. */
	private async listBranchFiles(repository: string, commitSha: string) {
		const output = await this.git.run(repository, [
			'ls-tree',
			'-r',
			'-z',
			commitSha,
			'--',
			...BRANCH_FOLDERS.map((folder) => `${PROMOTION_PACKAGE_FOLDER}/${folder}/`),
		]);
		const files = new Map<string, string>();
		for (const line of output.split('\0')) {
			const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
			if (!match) continue;
			files.set(match[2].slice(PROMOTION_PACKAGE_FOLDER.length + 1), match[1]);
		}
		return files;
	}

	/** The workflows of a project on the branch, by id. The folder of the project ends with its id. */
	private projectWorkflows(files: Map<string, string>, projectId: string) {
		const workflows = new Map<string, PackageWorkflow>();
		for (const [file, blob] of files) {
			const segments = file.split('/');
			if (segments[0] !== 'projects' || idOfFolder(segments[1]) !== projectId) continue;
			if (segments[segments.length - 1] !== WORKFLOW_FILE) continue;
			if (segments[segments.length - 3] !== 'workflows') continue;
			const folder = segments.slice(0, -1).join('/');
			workflows.set(idOfFolder(folder), { id: idOfFolder(folder), folder, blob });
		}
		return workflows;
	}

	/** The schema also reads the requirements of a package that an older n8n wrote. */
	private async readBranchManifest(repository: string, commitSha: string) {
		const text = await this.git.run(repository, [
			'show',
			`${commitSha}:${PROMOTION_PACKAGE_FOLDER}/manifest.json`,
		]);
		const parsed = packageManifestSchema.safeParse(jsonParse<unknown>(text));
		return parsed.success ? parsed.data : undefined;
	}

	private async readBranchWorkflow(repository: string, commitSha: string, folder: string) {
		const text = await this.git.run(repository, [
			'show',
			`${commitSha}:${PROMOTION_PACKAGE_FOLDER}/${folder}/${WORKFLOW_FILE}`,
		]);
		return jsonParse<{ isArchived?: boolean }>(text);
	}
}

const STATUS_COMPARE = (a: PromotableResource, b: PromotableResource) =>
	compareText(a.status, b.status);
const UPDATED_COMPARE = (a: PromotableResource, b: PromotableResource) =>
	compareText(a.updatedAt ?? '', b.updatedAt ?? '');
const NAME_COMPARE = (a: PromotableResource, b: PromotableResource) => compareText(a.name, b.name);

/** Sorts by the chosen field, then by name and id. */
function sortRows(
	rows: PromotableResource[],
	sort: 'name' | 'updatedAt' | 'status',
	order: 'asc' | 'desc',
) {
	const primary =
		sort === 'status' ? STATUS_COMPARE : sort === 'updatedAt' ? UPDATED_COMPARE : NAME_COMPARE;
	const sign = order === 'asc' ? 1 : -1;
	return [...rows].sort(
		(a, b) => sign * primary(a, b) || NAME_COMPARE(a, b) || compareText(a.id, b.id),
	);
}
