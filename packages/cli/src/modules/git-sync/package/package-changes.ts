import { jsonParse } from 'n8n-workflow';

import type { GitSyncWorkflowChange, PublishState, WorkflowBaseline } from '../git-sync.types';
import {
	WORKFLOW_FILE_NAME,
	WORKFLOW_METADATA_FILE_NAME,
	WORKFLOWS_DIRECTORY,
} from './package-layout';

/** A file of the package. The path is relative to the package folder. */
export interface PackageFile {
	path: string;
	blobSha: string;
}

/** A changed file from `git diff --name-status`. The path is relative to the package folder. */
export interface PackageFileChange {
	status: string;
	path: string;
}

export interface WorkflowFileRef {
	id: string;
	kind: 'workflow' | 'metadata';
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `<slug>-<id>`: the slug can contain hyphens, the ID cannot, so the ID follows the last hyphen.
const WORKFLOW_FILE_PATTERN = new RegExp(
	`^${escapeRegExp(WORKFLOWS_DIRECTORY)}/[^/]*-([A-Za-z0-9_]+)/(${escapeRegExp(WORKFLOW_FILE_NAME)}|${escapeRegExp(WORKFLOW_METADATA_FILE_NAME)})$`,
);

/** Finds the workflow ID and the file kind of a package path, or returns null for other files. */
export function parseWorkflowFilePath(packagePath: string): WorkflowFileRef | null {
	const match = WORKFLOW_FILE_PATTERN.exec(packagePath);
	if (!match) return null;

	const [, id, fileName] = match;
	// An ID such as `__proto__` cannot come from n8n, and it must not become an object key.
	if (Object.prototype.hasOwnProperty.call(Object.prototype, id)) return null;

	return { id, kind: fileName === WORKFLOW_FILE_NAME ? 'workflow' : 'metadata' };
}

/** Removes the package folder from a repository path. Returns null for a path outside the folder. */
export function toPackagePath(repositoryPath: string, directory: string): string | null {
	if (!directory) return repositoryPath;
	const prefix = `${directory}/`;
	return repositoryPath.startsWith(prefix) ? repositoryPath.slice(prefix.length) : null;
}

/**
 * Reads the publish state from the content of a metadata file, the same way the import
 * does. Returns undefined when the content is not a metadata file.
 */
export function publishStateOf(metadataContent: string): PublishState | undefined {
	const metadata = jsonParse<unknown>(metadataContent, { fallbackValue: null });
	if (typeof metadata !== 'object' || metadata === null) return undefined;

	const versionId: unknown = Reflect.get(metadata, 'versionId');
	const publishedVersionId: unknown = Reflect.get(metadata, 'publishedVersionId');
	if (typeof versionId !== 'string') return undefined;
	if (publishedVersionId === null) return 'unpublished';
	if (typeof publishedVersionId !== 'string') return undefined;
	return publishedVersionId === versionId ? 'published' : 'published-other-version';
}

/**
 * Groups the package files by workflow ID: the hash of the workflow file and, when the
 * metadata contents are given, the publish state. Other files are left out.
 */
export function collectWorkflowSnapshots(
	files: readonly PackageFile[],
	metadataContents?: ReadonlyMap<string, string>,
): Map<string, WorkflowBaseline> {
	const workflowHashes = new Map<string, string>();
	const publishStates = new Map<string, PublishState>();
	for (const file of files) {
		const ref = parseWorkflowFilePath(file.path);
		if (!ref) continue;
		if (ref.kind === 'workflow') {
			workflowHashes.set(ref.id, file.blobSha);
			continue;
		}
		const content = metadataContents?.get(file.path);
		const publishState = content === undefined ? undefined : publishStateOf(content);
		if (publishState) publishStates.set(ref.id, publishState);
	}

	// A metadata file without a workflow file is not a workflow.
	const result = new Map<string, WorkflowBaseline>();
	for (const [id, workflow] of workflowHashes) {
		const publishState = publishStates.get(id);
		result.set(id, publishState === undefined ? { workflow } : { workflow, publishState });
	}
	return result;
}

/** Finds the metadata file of each workflow. */
export function metadataPathsById(files: readonly PackageFile[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const file of files) {
		const ref = parseWorkflowFilePath(file.path);
		if (ref?.kind === 'metadata') result.set(ref.id, file.path);
	}
	return result;
}

const CHANGE_ORDER: Record<GitSyncWorkflowChange['change'], number> = {
	created: 0,
	modified: 1,
	deleted: 2,
};

function sortChanges(changes: GitSyncWorkflowChange[]): GitSyncWorkflowChange[] {
	return changes.sort(
		(a, b) =>
			CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] ||
			a.name.localeCompare(b.name) ||
			a.id.localeCompare(b.id),
	);
}

const nameOf = (names: ReadonlyMap<string, string>, id: string) => names.get(id) ?? id;

/**
 * Workflows changed in n8n since the last sync: the current export compared with the
 * baseline. A change of the publish state counts as a change.
 */
export function changesSinceBaseline(
	current: ReadonlyMap<string, WorkflowBaseline>,
	baseline: Readonly<Record<string, WorkflowBaseline>>,
	names: ReadonlyMap<string, string>,
): GitSyncWorkflowChange[] {
	const base = new Map(Object.entries(baseline));
	const changes: GitSyncWorkflowChange[] = [];

	for (const [id, snapshot] of current) {
		const previous = base.get(id);
		if (!previous) {
			changes.push({ id, name: nameOf(names, id), change: 'created' });
		} else if (
			previous.workflow !== snapshot.workflow ||
			previous.publishState !== snapshot.publishState
		) {
			changes.push({ id, name: nameOf(names, id), change: 'modified' });
		}
	}
	for (const id of base.keys()) {
		if (!current.has(id)) changes.push({ id, name: nameOf(names, id), change: 'deleted' });
	}

	return sortChanges(changes);
}

/**
 * Workflows in `source` that `target` does not have, or has with other content. Compares the
 * workflow files only: the version IDs differ between instances even when the content is the same.
 */
export function changesBetweenPackages(
	source: ReadonlyMap<string, WorkflowBaseline>,
	target: ReadonlyMap<string, WorkflowBaseline>,
	names: ReadonlyMap<string, string>,
): GitSyncWorkflowChange[] {
	const changes: GitSyncWorkflowChange[] = [];
	for (const [id, snapshot] of source) {
		const other = target.get(id);
		if (!other) {
			changes.push({ id, name: nameOf(names, id), change: 'created' });
		} else if (other.workflow !== snapshot.workflow) {
			changes.push({ id, name: nameOf(names, id), change: 'modified' });
		}
	}
	return sortChanges(changes);
}

/** Workflows that a diff between two commits changed. */
export function changesFromDiff(
	entries: readonly PackageFileChange[],
	names: ReadonlyMap<string, string>,
): GitSyncWorkflowChange[] {
	const workflowStatuses = new Map<string, Set<string>>();
	const touched = new Set<string>();

	for (const entry of entries) {
		const ref = parseWorkflowFilePath(entry.path);
		if (!ref) continue;
		touched.add(ref.id);
		if (ref.kind !== 'workflow') continue;
		const statuses = workflowStatuses.get(ref.id) ?? new Set<string>();
		statuses.add(entry.status);
		workflowStatuses.set(ref.id, statuses);
	}

	const changes: GitSyncWorkflowChange[] = [];
	for (const id of touched) {
		// A rename moves the files to a new folder, so the diff has a deletion and an addition
		// for the same ID. That is a modification.
		const statuses = workflowStatuses.get(id) ?? new Set<string>();
		const added = statuses.has('A');
		const deleted = statuses.has('D');
		const change = added && !deleted ? 'created' : deleted && !added ? 'deleted' : 'modified';
		changes.push({ id, name: nameOf(names, id), change });
	}
	return sortChanges(changes);
}

/** Workflows that changed on both sides. */
export function findConflicts(
	outgoing: readonly GitSyncWorkflowChange[],
	incoming: readonly GitSyncWorkflowChange[],
): GitSyncWorkflowChange[] {
	const incomingIds = new Set(incoming.map(({ id }) => id));
	return outgoing.filter(({ id }) => incomingIds.has(id));
}
