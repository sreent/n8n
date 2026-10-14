// Fork code (not in upstream n8n): the helpers of the push and pull modals of source control: the
// order of the rows, the folder tree of the workflows, the dates and the summaries of the toasts.
// See `FORK.md` in this folder.
import type { BaseTextKey } from '@n8n/i18n';
import { useI18n } from '@n8n/i18n';
import dateformat from 'dateformat';

import type { SourceControlledFile } from './sourceControl.types';

type FileStatus = SourceControlledFile['status'];

/** The rows of the push modal: changed resources first, deleted resources last. */
const PUSH_STATUS_ORDER: FileStatus[] = [
	'conflicted',
	'modified',
	'renamed',
	'created',
	'new',
	'staged',
	'unknown',
	'ignored',
	'deleted',
];

/** The rows of the pull modal: new resources first, deleted resources last. */
const PULL_STATUS_ORDER: FileStatus[] = [
	'created',
	'new',
	'conflicted',
	'modified',
	'renamed',
	'staged',
	'unknown',
	'ignored',
	'deleted',
];

export const STATUS_LABEL_KEYS: Partial<Record<FileStatus, BaseTextKey>> = {
	new: 'settings.sourceControl.status.created',
	created: 'settings.sourceControl.status.created',
	modified: 'settings.sourceControl.status.modified',
	deleted: 'settings.sourceControl.status.deleted',
	renamed: 'settings.sourceControl.status.renamed',
};

/** Sorts the files by status, then the most recently updated first. */
export function sortFiles(files: SourceControlledFile[], direction: 'push' | 'pull') {
	const order = direction === 'push' ? PUSH_STATUS_ORDER : PULL_STATUS_ORDER;
	const rank = (file: SourceControlledFile) => {
		const index = order.indexOf(file.status);
		return index === -1 ? order.length : index;
	};
	const time = (file: SourceControlledFile) => {
		const value = Date.parse(file.updatedAt);
		return Number.isNaN(value) ? 0 : value;
	};
	return [...files].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}

/** Compares folder names by their code units, as the folders of the original modals sort. */
const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type TreeRow =
	| { type: 'folder'; key: string; name: string; path: string[]; depth: number }
	| { type: 'file'; key: string; file: SourceControlledFile; depth: number };

type FolderNode = { files: SourceControlledFile[]; folders: Map<string, FolderNode> };

export const folderKey = (path: string[]) => JSON.stringify(path);

/**
 * The rows of a list of workflows: the files of the root first, then each folder (by name) with its
 * files and its subfolders. The files keep their order. A collapsed folder hides its content.
 */
export function buildTree(files: SourceControlledFile[], collapsed: Set<string>): TreeRow[] {
	const root: FolderNode = { files: [], folders: new Map() };
	for (const file of files) {
		let node = root;
		for (const name of file.folderPath ?? []) {
			let child = node.folders.get(name);
			if (!child) {
				child = { files: [], folders: new Map() };
				node.folders.set(name, child);
			}
			node = child;
		}
		node.files.push(file);
	}

	const rows: TreeRow[] = [];
	const walk = (node: FolderNode, path: string[]) => {
		for (const file of node.files) {
			rows.push({ type: 'file', key: `file:${file.type}:${file.id}`, file, depth: path.length });
		}
		for (const name of [...node.folders.keys()].sort(compareNames)) {
			const childPath = [...path, name];
			const key = folderKey(childPath);
			rows.push({
				type: 'folder',
				key: `folder:${key}`,
				name,
				path: childPath,
				depth: path.length,
			});
			const child = node.folders.get(name);
			if (child && !collapsed.has(key)) walk(child, childPath);
		}
	};
	walk(root, []);
	return rows;
}

/** The files below a folder, at any depth. */
export function filesInFolder(files: SourceControlledFile[], path: string[]) {
	return files.filter((file) => {
		const folderPath = file.folderPath ?? [];
		return path.every((name, index) => folderPath[index] === name);
	});
}

/** "Last updated 2 Jan at 03:04", with the year when it is not the current year. */
export function useLastUpdated() {
	const i18n = useI18n();
	return (updatedAt: string) => {
		const date = new Date(updatedAt);
		const sameYear = date.getFullYear() === new Date().getFullYear();
		return i18n.baseText('settings.sourceControl.lastUpdated', {
			interpolate: {
				date: dateformat(date, sameYear ? 'd mmm' : 'd mmm, yyyy'),
				time: dateformat(date, 'HH:MM'),
			},
		});
	};
}

type SummaryPart =
	| 'workflow'
	| 'credential'
	| 'variables'
	| 'datatable'
	| 'tags'
	| 'folders'
	| 'project';

export const PULL_SUMMARY_ORDER: SummaryPart[] = [
	'workflow',
	'credential',
	'variables',
	'datatable',
	'tags',
	'folders',
	'project',
];

export const PUSH_SUMMARY_ORDER: SummaryPart[] = [
	'workflow',
	'credential',
	'variables',
	'datatable',
	'folders',
	'tags',
	'project',
];

/**
 * The resources of a push or a pull in one sentence, for example "2 Workflows, 1 Credential and
 * Tags were pulled". The verb is singular for a single resource.
 */
export function useChangesSummary() {
	const i18n = useI18n();
	const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

	const partText = (part: SummaryPart, count: number) => {
		switch (part) {
			case 'workflow':
				return i18n.baseText('generic.workflow', {
					adjustToNumber: count,
					interpolate: { count: String(count) },
				});
			case 'credential':
				return i18n.baseText('generic.credential', {
					adjustToNumber: count,
					interpolate: { count: String(count) },
				});
			case 'datatable':
				return i18n.baseText('generic.datatable', {
					adjustToNumber: count,
					interpolate: { count: String(count) },
				});
			case 'variables':
				return i18n.baseText('generic.variable_plural');
			case 'tags':
				return i18n.baseText('generic.tag_plural');
			case 'folders':
				return i18n.baseText('generic.folders_plural');
			case 'project':
				return i18n.baseText('generic.projects');
		}
	};

	return (files: SourceControlledFile[], order: SummaryPart[], verbKey: BaseTextKey) => {
		const parts = order
			.map((part) => ({ part, count: files.filter((file) => file.type === part).length }))
			.filter(({ count }) => count > 0)
			.map(({ part, count }) => partText(part, count));
		const verb = i18n.baseText(verbKey, { adjustToNumber: files.length });
		return `${listFormat.format(parts)} ${verb}`;
	};
}
