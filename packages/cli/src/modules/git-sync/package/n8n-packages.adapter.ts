import { GIT_SYNC_ERROR_CODES, type GitSyncCredentialMatchingMode } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';

import { DirectoryPackageWriter } from '@/modules/n8n-packages/io/directory/directory-package-writer';
import { formatEntityFile } from '@/modules/n8n-packages/io/entity-file-format';
import { HashingPackageWriter } from '@/modules/n8n-packages/io/hashing-package-writer';
import { PACKAGE_ENTITY_LAYOUT } from '@/modules/n8n-packages/io/manifest-entry';
import type { PackageWriter } from '@/modules/n8n-packages/io/package-writer';
import { TarPackageWriter } from '@/modules/n8n-packages/io/tar/tar-package-writer';
import { PackageImportConfig } from '@/modules/n8n-packages/n8n-packages.config';
import { N8nPackagesService } from '@/modules/n8n-packages/n8n-packages.service';
import {
	CredentialExportPolicy,
	DataTableMatchingMode,
	DataTableMissingMode,
	DataTableSchemaConflictPolicy,
	ExportDependencyPolicy,
	ExportVersionPolicy,
	MissingNodeTypeMode,
	OverwriteDeletionPolicy,
	ProjectConflictPolicy,
	TagConflictPolicy,
	TagMissingMode,
	VariableConflictPolicy,
	VariableMissingMode,
	WorkflowConflictPolicy,
	WorkflowIdPolicy,
	WorkflowPublishingPolicy,
	type ImportPackageRequest,
	type ImportResult,
} from '@/modules/n8n-packages/n8n-packages.types';
import {
	packageManifestSchema,
	type ManifestEntry,
	type PackageManifest,
} from '@/modules/n8n-packages/spec/manifest.schema';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { GitSyncError } from '../git-sync.errors';
import type { PackageFile } from './package-changes';
import {
	MANAGED_PACKAGE_ENTRIES,
	MANIFEST_FILE_NAME,
	WORKFLOW_FILE_NAME,
	WORKFLOW_METADATA_FILE_NAME,
} from './package-layout';

/**
 * Import options for a pull. The workflow IDs stay the same on every instance, so a
 * second pull updates the same workflows. Credentials become stubs that the user fills
 * in once on each instance. Variables are never written.
 */
const GIT_SYNC_IMPORT_POLICY = {
	credentialMissingMode: 'create-stub',
	workflowConflictPolicy: WorkflowConflictPolicy.NewVersion,
	workflowPublishingPolicy: WorkflowPublishingPolicy.PreservePublishedState,
	workflowIdPolicy: WorkflowIdPolicy.Source,
	missingNodeTypeMode: MissingNodeTypeMode.Fail,
	projectConflictPolicy: ProjectConflictPolicy.Merge,
	overwriteDeletionPolicy: OverwriteDeletionPolicy.Archive,
	dataTableMatchingMode: DataTableMatchingMode.ById,
	dataTableMissingMode: DataTableMissingMode.Create,
	dataTableSchemaConflictPolicy: DataTableSchemaConflictPolicy.KeepExisting,
	variableMissingMode: VariableMissingMode.DoNothing,
	variableConflictPolicy: VariableConflictPolicy.KeepExisting,
	tagMissingMode: TagMissingMode.Create,
	tagConflictPolicy: TagConflictPolicy.Skip,
} as const satisfies Omit<
	ImportPackageRequest,
	'user' | 'projectId' | 'packageBuffer' | 'credentialMatchingMode'
>;

/** The manifest collections, other than workflows, whose files a pull takes along. */
const DEPENDENCY_COLLECTIONS = ['credentials', 'dataTables', 'variables', 'tags'] as const;

/** A manifest target in a flat workflow package: `<collection folder>/<slug>-<id>`. */
const SAFE_TARGET_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface ProjectExport {
	manifest: PackageManifest;
	/** Every file of the package, with its Git blob hash. */
	files: PackageFile[];
	/** Path to content of every workflow metadata file. These files hold the publish state. */
	metadata: Map<string, string>;
	/** ID and name of every workflow in the project. */
	workflows: Array<{ id: string; name: string }>;
}

/** Writes to several package writers at once. */
class TeePackageWriter implements PackageWriter {
	constructor(private readonly writers: readonly PackageWriter[]) {}

	async writeFile(filePath: string, content: string | Buffer): Promise<void> {
		for (const writer of this.writers) await writer.writeFile(filePath, content);
	}

	async writeDirectory(directoryPath: string): Promise<void> {
		for (const writer of this.writers) await writer.writeDirectory(directoryPath);
	}
}

/** Keeps the content of the workflow metadata files. */
class MetadataCaptureWriter implements PackageWriter {
	readonly contents = new Map<string, string>();

	writeFile(filePath: string, content: string | Buffer): void {
		const normalised = filePath.startsWith('./') ? filePath.slice(2) : filePath;
		if (normalised.endsWith(`/${WORKFLOW_METADATA_FILE_NAME}`)) {
			this.contents.set(normalised, content.toString());
		}
	}

	writeDirectory(): void {
		return;
	}
}

const invalidPackage = (message: string) =>
	new GitSyncError(message, 400, GIT_SYNC_ERROR_CODES.invalidPackage);

/**
 * The only connection between Git sync and the package import and export of n8n.
 * When the package API changes in an n8n upgrade, the compile errors show up here.
 */
@Service()
export class N8nPackagesAdapter {
	constructor(
		private readonly n8nPackagesService: N8nPackagesService,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly packageImportConfig: PackageImportConfig,
	) {}

	/**
	 * Exports every workflow of the project, archived ones included, as a flat workflow
	 * package. Writes the files to `targetDir` when it is given, and always returns their hashes.
	 */
	async exportProject(user: User, projectId: string, targetDir?: string): Promise<ProjectExport> {
		const placements = await this.workflowFinderService.findOwnedWorkflowPlacementsInProject(
			projectId,
			{ includeArchived: true },
		);
		// A fixed order keeps the manifest stable between exports.
		const workflows = placements
			.map(({ id, name }) => ({ id, name }))
			.sort((a, b) => a.id.localeCompare(b.id));

		const hashingWriter = new HashingPackageWriter();
		const metadataWriter = new MetadataCaptureWriter();
		const writers: PackageWriter[] = [hashingWriter, metadataWriter];
		if (targetDir) {
			await mkdir(targetDir, { recursive: true });
			writers.push(new DirectoryPackageWriter(targetDir));
		}

		const { manifest } = await this.n8nPackagesService.exportPackageToWriter(
			{
				user,
				workflowIds: workflows.map(({ id }) => id),
				includeTags: true,
				includeArchivedWorkflows: true,
				// A pull imports workflows only, so the package keeps agents out.
				includeAgents: false,
				dependencyPolicy: ExportDependencyPolicy.ReferenceOnly,
				versionPolicy: ExportVersionPolicy.Latest,
				credentialExportPolicy: CredentialExportPolicy.NoValues,
				includeVariableValues: false,
			},
			new TeePackageWriter(writers),
		);

		return {
			manifest,
			files: hashingWriter.finalize(),
			metadata: metadataWriter.contents,
			workflows,
		};
	}

	/** Removes the entries that the package owns, so that a new export replaces them. */
	async clearManagedEntries(packageDir: string): Promise<void> {
		for (const entry of MANAGED_PACKAGE_ENTRIES) {
			await rm(path.join(packageDir, entry), { recursive: true, force: true });
		}
	}

	/** Reads the manifest of the package in `packageDir`. Returns null when the folder has no package. */
	async readManifest(packageDir: string): Promise<PackageManifest | null> {
		const content = await this.readPackageFile(packageDir, MANIFEST_FILE_NAME, { optional: true });
		if (content === null) return null;
		return this.parseManifest(content.toString('utf8'));
	}

	parseManifest(content: string): PackageManifest {
		const result = packageManifestSchema.safeParse(
			jsonParse<unknown>(content, { fallbackValue: null }),
		);
		if (!result.success) {
			throw invalidPackage(
				'The manifest.json file in the repository is not a valid n8n package manifest.',
			);
		}
		if (result.data.folders?.length || result.data.projects?.length) {
			throw new GitSyncError(
				'The package in the repository has folders or projects. Git sync supports flat workflow packages only.',
				400,
				GIT_SYNC_ERROR_CODES.unsupportedRepository,
			);
		}
		return result.data;
	}

	/**
	 * Builds a package archive with the selected workflows and every credential, data table,
	 * variable and tag entry of the package. The manifest comes first, as the import requires.
	 */
	async packSubset(
		packageDir: string,
		manifest: PackageManifest,
		workflowIds: ReadonlySet<string>,
	): Promise<Buffer> {
		const workflows = (manifest.workflows ?? []).filter(({ id }) => workflowIds.has(id));
		const subset: PackageManifest = { ...manifest, workflows };

		const writer = new TarPackageWriter();
		writer.writeFile(MANIFEST_FILE_NAME, formatEntityFile(subset));

		const budget = { entries: 1, bytes: 0 };
		const copy = async (entry: ManifestEntry, directory: string, fileName: string) => {
			const filePath = `${this.checkTarget(entry, directory)}/${fileName}`;
			const content = await this.readPackageFile(packageDir, filePath);
			budget.entries += 1;
			budget.bytes += content.length;
			if (
				budget.entries > this.packageImportConfig.maxEntries ||
				budget.bytes > this.packageImportConfig.maxUncompressedBytes
			) {
				throw invalidPackage(
					'The package in the repository is larger than the import limits allow.',
				);
			}
			writer.writeFile(filePath, content);
		};

		for (const entry of workflows) {
			await copy(entry, PACKAGE_ENTITY_LAYOUT.workflows.directory, WORKFLOW_FILE_NAME);
			await copy(entry, PACKAGE_ENTITY_LAYOUT.workflows.directory, WORKFLOW_METADATA_FILE_NAME);
		}
		for (const collection of DEPENDENCY_COLLECTIONS) {
			const { directory, fileName } = PACKAGE_ENTITY_LAYOUT[collection];
			for (const entry of manifest[collection] ?? []) {
				await copy(entry, directory, fileName);
			}
		}

		return await buffer(writer.finalize());
	}

	async importPackage(options: {
		user: User;
		projectId: string;
		packageBuffer: Buffer;
		credentialMatchingMode: GitSyncCredentialMatchingMode;
	}): Promise<ImportResult> {
		return await this.n8nPackagesService.importPackage({
			...GIT_SYNC_IMPORT_POLICY,
			user: options.user,
			projectId: options.projectId,
			packageBuffer: options.packageBuffer,
			credentialMatchingMode: options.credentialMatchingMode,
		});
	}

	/** Accepts only `<collection folder>/<segment>` targets, so a manifest cannot point outside the package. */
	private checkTarget(entry: ManifestEntry, directory: string): string {
		const [first, second, ...rest] = entry.target.split('/');
		if (first !== directory || !second || rest.length > 0 || !SAFE_TARGET_SEGMENT.test(second)) {
			throw invalidPackage(`The manifest entry "${entry.target}" is not a valid package path.`);
		}
		return entry.target;
	}

	/** Reads a regular file of the package. Refuses links and files above the entry size limit. */
	private async readPackageFile(
		packageDir: string,
		filePath: string,
		options: { optional: true },
	): Promise<Buffer | null>;
	private async readPackageFile(packageDir: string, filePath: string): Promise<Buffer>;
	private async readPackageFile(
		packageDir: string,
		filePath: string,
		options?: { optional: true },
	): Promise<Buffer | null> {
		const fullPath = path.join(packageDir, filePath);
		const stats = await lstat(fullPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
			throw error;
		});

		if (!stats) {
			if (options?.optional) return null;
			throw invalidPackage(`The package in the repository is missing the file ${filePath}.`);
		}
		if (!stats.isFile()) {
			throw invalidPackage(`The package entry ${filePath} is not a regular file.`);
		}
		if (stats.size > this.packageImportConfig.maxEntryBytes) {
			throw invalidPackage(`The package file ${filePath} is larger than the import limit.`);
		}
		return await readFile(fullPath);
	}
}
