import type { User } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonParse } from 'n8n-workflow';

import { formatEntityFile } from '@/modules/n8n-packages/io/entity-file-format';
import { N8nPackagesService } from '@/modules/n8n-packages/n8n-packages.service';
import type { ImportRequest, ImportResult } from '@/modules/n8n-packages/n8n-packages.types';
import type { PackageManifest } from '@/modules/n8n-packages/spec/manifest.schema';
import { packageManifestSchema } from '@/modules/n8n-packages/spec/manifest.schema';

import { mergeSelectionManifest } from './promotion-package-manifest';
import { PROMOTION_PACKAGE_FOLDER } from './promotions.constants';

const MANIFEST_FILE = 'manifest.json';

/**
 * The import policy of Apply. The package is the source of truth: projects, folders and workflows
 * follow it, and the workflows that the package does not have go. Existing variables keep their
 * values.
 */
const APPLY_POLICY: Omit<ImportRequest, 'user'> = {
	projectConflictPolicy: 'overwrite',
	workflowConflictPolicy: 'new-version',
	workflowIdPolicy: 'source',
	workflowPublishingPolicy: 'match-source',
	missingNodeTypeMode: 'fail',
	credentialMatchingMode: 'id-only',
	credentialMissingMode: 'create-stub',
	folderConflictPolicy: 'overwrite',
	overwriteDeletionPolicy: 'hard-delete',
	dataTableMatchingMode: 'by-id',
	dataTableMissingMode: 'create',
	dataTableSchemaConflictPolicy: 'fail',
	variableMissingMode: 'create-with-value',
	variableConflictPolicy: 'keep-existing',
	tagMissingMode: 'create',
	tagConflictPolicy: 'rename',
};

interface SelectionRequest {
	projectId: string;
	liveIds: string[];
	deletedIds: string[];
	canExportVariableValues: boolean;
}

function countBy<T>(items: T[], predicate: (item: T) => boolean) {
	return items.filter(predicate).length;
}

/** The counts of an apply, from the result of the package import. */
function applyCounts(result: ImportResult) {
	const publishing = (state: string) =>
		countBy(result.workflows, ({ publishing: outcome }) => outcome.state === state);
	return {
		projects: {
			created: countBy(result.projects, ({ status }) => status === 'created'),
			updated: countBy(result.projects, ({ status }) => status === 'updated'),
			skipped: countBy(result.projects, ({ status }) => status === 'skipped'),
			deleted: 0,
		},
		folders: {
			created: countBy(result.folders, ({ status }) => status === 'created'),
			skipped: countBy(result.folders, ({ status }) => status === 'skipped'),
			removed: result.removedFolders.length,
		},
		workflows: {
			created: countBy(result.workflows, ({ status }) => status === 'created'),
			updated: countBy(result.workflows, ({ status }) => status === 'updated'),
			skipped: countBy(result.workflows, ({ status }) => status === 'skipped'),
			archived: countBy(result.removedWorkflows, ({ deletion }) => deletion === 'archived'),
			deleted: countBy(result.removedWorkflows, ({ deletion }) => deletion === 'deleted'),
			publishing: {
				published: publishing('published'),
				unpublished: publishing('unpublished'),
				unchanged: publishing('unchanged'),
				blocked: publishing('blocked'),
				failed: publishing('failed'),
			},
		},
		credentials: {
			matched: result.credentials.matched.length,
			stubbed: result.credentials.stubbed.length,
		},
		dataTables: { matched: result.dataTables.matched, created: result.dataTables.created },
		variables: {
			matched: result.variables.matched.length,
			created: result.variables.created.length,
			updated: result.variables.updated.length,
			stubbed: result.variables.stubbed.length,
			missing: result.variables.missing.length,
		},
		tags: {
			matched: result.tags.matched.length,
			created: result.tags.created.length,
			renamed: result.tags.renamed.length,
			reconciled: result.tags.reconciled.length,
			skipped: result.tags.skipped.length,
		},
	};
}

/**
 * Fork code (not in upstream n8n): the package of a checkout, in the folder `n8n-export`. A
 * promotion writes it with the package engine, and an apply imports it with the package engine.
 */
@Service()
export class PromotionPackages {
	constructor(
		private readonly packagesService: N8nPackagesService,
		private readonly projectRepository: ProjectRepository,
	) {}

	/** Writes every team project to the package of the checkout, in place of the old package. */
	async exportAll(user: User, repository: string, canExportVariableValues: boolean) {
		const projects = await this.projectRepository.findBy({ type: 'team' });
		return await this.withStaging(repository, async (staging) => {
			const { counts } = await this.packagesService.exportPackageToDirectory(
				{
					user,
					projectIds: projects.map(({ id }) => id),
					includeArchivedWorkflows: true,
					canExportVariableValues,
				},
				{ targetDir: staging },
			);
			const target = path.join(repository, PROMOTION_PACKAGE_FOLDER);
			await rm(target, { recursive: true, force: true });
			await rename(staging, target);
			return counts;
		});
	}

	/**
	 * Writes the chosen workflows of a project to the package of the checkout. The deleted
	 * workflows leave the package. The manifest keeps the other workflows.
	 */
	async exportSelection(user: User, repository: string, request: SelectionRequest) {
		const target = path.join(repository, PROMOTION_PACKAGE_FOLDER);
		const old = await this.readManifest(target);
		this.checkDeletions(old, request);
		return await this.withStaging(repository, async (staging) => {
			const { counts, manifest } = await this.packagesService.exportPackageToDirectory(
				{
					user,
					projectIds: [request.projectId],
					projectWorkflowIds: request.liveIds,
					includeArchivedWorkflows: true,
					canExportVariableValues: request.canExportVariableValues,
				},
				{ targetDir: staging },
			);
			const replaced = new Set([...request.liveIds, ...request.deletedIds]);
			for (const entry of old?.workflows ?? []) {
				if (replaced.has(entry.id)) {
					await rm(path.join(target, entry.target), { recursive: true, force: true });
				}
			}
			await rm(path.join(staging, MANIFEST_FILE), { force: true });
			await cp(staging, target, { recursive: true, force: true });
			const merged = mergeSelectionManifest(old, manifest, replaced);
			await writeFile(
				path.join(target, MANIFEST_FILE),
				formatEntityFile(packageManifestSchema.parse(merged)),
			);
			return counts;
		});
	}

	/** Imports the package of the checkout with the policy of Apply. */
	async importAll(user: User, repository: string) {
		const sourceDir = path.join(repository, PROMOTION_PACKAGE_FOLDER);
		const result = await this.packagesService.importPackageFromDirectory(
			{ user, ...APPLY_POLICY },
			{ sourceDir },
		);
		return {
			counts: applyCounts(result),
			packageProjectIds: new Set(result.projects.map(({ sourceProjectId }) => sourceProjectId)),
		};
	}

	/** A deleted workflow must be on the branch, in the folder of the project. */
	private checkDeletions(old: PackageManifest | undefined, request: SelectionRequest) {
		const projectFolders = (old?.projects ?? [])
			.filter(({ id }) => id === request.projectId)
			.map(({ target }) => `${target}/`);
		const missing: string[] = [];
		const elsewhere: string[] = [];
		for (const id of request.deletedIds) {
			const entry = old?.workflows?.find((workflow) => workflow.id === id);
			if (!entry) missing.push(id);
			else if (!projectFolders.some((folder) => entry.target.startsWith(folder)))
				elsewhere.push(id);
		}
		if (missing.length > 0) {
			throw new BadRequestError(`Deleted workflows not found on the branch: ${missing.join(', ')}`);
		}
		if (elsewhere.length > 0) {
			throw new BadRequestError(
				`Deleted workflows do not belong to the selected project: ${elsewhere.join(', ')}`,
			);
		}
	}

	private async readManifest(packageFolder: string) {
		const file = path.join(packageFolder, MANIFEST_FILE);
		if (!existsSync(file)) return undefined;
		const parsed = packageManifestSchema.safeParse(jsonParse(await readFile(file, 'utf-8')));
		return parsed.success ? parsed.data : undefined;
	}

	/** Runs `action` with an empty folder next to the checkout, and removes the folder after. */
	private async withStaging<T>(repository: string, action: (staging: string) => Promise<T>) {
		const staging = await mkdtemp(path.join(path.dirname(repository), 'export-'));
		try {
			return await action(staging);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
}
