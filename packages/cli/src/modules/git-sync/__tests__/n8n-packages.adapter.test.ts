import type { User } from '@n8n/db';
import { mock } from 'vitest-mock-extended';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PackageWriter } from '@/modules/n8n-packages/io/package-writer';
import { TarPackageReader } from '@/modules/n8n-packages/io/tar/tar-package-reader';
import type { PackageImportConfig } from '@/modules/n8n-packages/n8n-packages.config';
import type { N8nPackagesService } from '@/modules/n8n-packages/n8n-packages.service';
import type { PackageManifest } from '@/modules/n8n-packages/spec/manifest.schema';
import type { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { GitSyncError } from '../git-sync.errors';
import { N8nPackagesAdapter } from '../package/n8n-packages.adapter';

const limits = {
	maxUncompressedBytes: 1024 * 1024,
	maxEntryBytes: 64 * 1024,
	maxEntries: 100,
	maxPathLength: 1024,
} as PackageImportConfig;

const manifest: PackageManifest = {
	packageFormatVersion: '1',
	exportedAt: '2026-10-01T00:00:00.000Z',
	sourceN8nVersion: '2.42.0',
	sourceId: 'instance-1',
	workflows: [
		{ id: 'wf1', name: 'Alpha', target: 'workflows/alpha-wf1' },
		{ id: 'wf2', name: 'Beta', target: 'workflows/beta-wf2' },
	],
	credentials: [{ id: 'c1', name: 'Basic', target: 'credentials/basic-c1' }],
	tags: [{ id: 't1', name: 'ops', target: 'tags/ops-t1' }],
};

const n8nPackagesService = mock<N8nPackagesService>();
const workflowFinderService = mock<WorkflowFinderService>();
const adapter = new N8nPackagesAdapter(n8nPackagesService, workflowFinderService, limits);

let packageDir: string;

async function writePackageFile(relativePath: string, content: string) {
	const fullPath = path.join(packageDir, relativePath);
	await mkdir(path.dirname(fullPath), { recursive: true });
	await writeFile(fullPath, content);
}

beforeEach(async () => {
	vi.clearAllMocks();
	packageDir = await mkdtemp(path.join(tmpdir(), 'git-sync-adapter-'));
	await writePackageFile('manifest.json', JSON.stringify(manifest));
	for (const id of ['wf1', 'wf2']) {
		const folder = id === 'wf1' ? 'alpha-wf1' : 'beta-wf2';
		await writePackageFile(`workflows/${folder}/workflow.json`, `{"id":"${id}"}`);
		await writePackageFile(`workflows/${folder}/workflow-metadata.json`, '{"versionId":"v"}');
	}
	await writePackageFile('credentials/basic-c1/credential.json', '{"id":"c1"}');
	await writePackageFile('tags/ops-t1/tag.json', '{"id":"t1"}');
});

afterEach(async () => {
	await rm(packageDir, { recursive: true, force: true });
});

const readArchive = async (archive: Buffer) => {
	const reader = new TarPackageReader(archive, limits);
	return { reader, entries: await reader.listEntries() };
};

describe('N8nPackagesAdapter.packSubset', () => {
	it('packs the manifest first, the selected workflows and every dependency entry', async () => {
		const archive = await adapter.packSubset(packageDir, manifest, new Set(['wf2']));

		const { reader, entries } = await readArchive(archive);
		expect(entries[0]).toBe('manifest.json');
		expect(entries.sort()).toEqual(
			[
				'credentials/basic-c1/credential.json',
				'manifest.json',
				'tags/ops-t1/tag.json',
				'workflows/beta-wf2/workflow-metadata.json',
				'workflows/beta-wf2/workflow.json',
			].sort(),
		);
		const packedManifest = await reader.readManifest();
		expect(packedManifest.workflows).toEqual([manifest.workflows?.[1]]);
		expect(packedManifest.credentials).toEqual(manifest.credentials);
	});

	it('refuses a manifest target outside the package', async () => {
		const unsafe: PackageManifest = {
			...manifest,
			workflows: [{ id: 'wf1', name: 'Alpha', target: 'workflows/../../etc' }],
		};

		await expect(adapter.packSubset(packageDir, unsafe, new Set(['wf1']))).rejects.toThrow(
			GitSyncError,
		);
	});

	it('refuses a link in place of a package file', async () => {
		const outside = path.join(packageDir, '..', `outside-${path.basename(packageDir)}.json`);
		await writeFile(outside, '{"secret":true}');
		const linked = path.join(packageDir, 'workflows/alpha-wf1/workflow.json');
		await rm(linked);
		await symlink(outside, linked);

		try {
			await expect(adapter.packSubset(packageDir, manifest, new Set(['wf1']))).rejects.toThrow(
				'not a regular file',
			);
		} finally {
			await rm(outside, { force: true });
		}
	});

	it('reports a missing package file', async () => {
		await rm(path.join(packageDir, 'tags'), { recursive: true });

		await expect(adapter.packSubset(packageDir, manifest, new Set(['wf1']))).rejects.toThrow(
			'missing the file tags/ops-t1/tag.json',
		);
	});

	it('refuses a file above the entry size limit', async () => {
		await writePackageFile('workflows/alpha-wf1/workflow.json', 'x'.repeat(65 * 1024));

		await expect(adapter.packSubset(packageDir, manifest, new Set(['wf1']))).rejects.toThrow(
			'larger than the import limit',
		);
	});
});

describe('N8nPackagesAdapter.readManifest', () => {
	it('returns null when the folder has no package', async () => {
		await expect(adapter.readManifest(path.join(packageDir, 'missing'))).resolves.toBeNull();
	});

	it('refuses an invalid manifest', async () => {
		await writePackageFile('manifest.json', '{"packageFormatVersion":"1"}');

		await expect(adapter.readManifest(packageDir)).rejects.toThrow('not a valid n8n package');
	});

	it('refuses a package with folders', async () => {
		await writePackageFile(
			'manifest.json',
			JSON.stringify({
				...manifest,
				folders: [{ id: 'f1', name: 'Ops', target: 'folders/ops-f1' }],
			}),
		);

		await expect(adapter.readManifest(packageDir)).rejects.toThrow('flat workflow packages');
	});
});

describe('N8nPackagesAdapter.exportProject', () => {
	it('exports every workflow of the project and writes the files to the folder', async () => {
		const user = mock<User>();
		workflowFinderService.findOwnedWorkflowPlacementsInProject.mockResolvedValue([
			{ id: 'wf2', name: 'Beta', parentFolderId: null, isArchived: true },
			{ id: 'wf1', name: 'Alpha', parentFolderId: 'folder-1', isArchived: false },
		]);
		n8nPackagesService.exportPackageToWriter.mockImplementation(
			async (_request, writer: PackageWriter) => {
				await writer.writeDirectory('workflows/alpha-wf1');
				await writer.writeFile('workflows/alpha-wf1/workflow.json', '{"id":"wf1"}');
				await writer.writeFile(
					'workflows/alpha-wf1/workflow-metadata.json',
					Buffer.from('{"versionId":"v1","publishedVersionId":null}'),
				);
				await writer.writeFile('manifest.json', '{}');
				return { manifest, counts: mock() };
			},
		);
		const targetDir = path.join(packageDir, 'export');

		const result = await adapter.exportProject(user, 'project-1', targetDir);

		expect(workflowFinderService.findOwnedWorkflowPlacementsInProject).toHaveBeenCalledWith(
			'project-1',
			{ includeArchived: true },
		);
		expect(n8nPackagesService.exportPackageToWriter).toHaveBeenCalledWith(
			{
				user,
				workflowIds: ['wf1', 'wf2'],
				includeTags: true,
				includeArchivedWorkflows: true,
				missingWorkflowDependencyPolicy: 'reference-only',
				workflowVersionPolicy: 'latest',
				credentialExportPolicy: 'no-values',
				includeVariableValues: false,
			},
			expect.anything(),
		);
		expect(result.workflows).toEqual([
			{ id: 'wf1', name: 'Alpha' },
			{ id: 'wf2', name: 'Beta' },
		]);
		expect(result.files.map(({ path: filePath }) => filePath).sort()).toEqual([
			'manifest.json',
			'workflows/alpha-wf1/workflow-metadata.json',
			'workflows/alpha-wf1/workflow.json',
		]);
		expect(Object.fromEntries(result.metadata)).toEqual({
			'workflows/alpha-wf1/workflow-metadata.json': '{"versionId":"v1","publishedVersionId":null}',
		});
		await expect(
			readFile(path.join(targetDir, 'workflows/alpha-wf1/workflow.json'), 'utf8'),
		).resolves.toBe('{"id":"wf1"}');
	});
});

describe('N8nPackagesAdapter.importPackage', () => {
	it('keeps the source IDs, creates credential stubs and never writes variables', async () => {
		const user = mock<User>();
		const packageBuffer = Buffer.from('archive');

		await adapter.importPackage({
			user,
			projectId: 'project-1',
			packageBuffer,
			credentialMatchingMode: 'name-and-type',
		});

		expect(n8nPackagesService.importPackage).toHaveBeenCalledWith(
			expect.objectContaining({
				user,
				projectId: 'project-1',
				packageBuffer,
				credentialMatchingMode: 'name-and-type',
				credentialMissingMode: 'create-stub',
				workflowIdPolicy: 'source',
				workflowConflictPolicy: 'new-version',
				workflowPublishingPolicy: 'preserve-published-state',
				variableMissingMode: 'do-nothing',
				variableConflictPolicy: 'keep-existing',
			}),
		);
	});
});
