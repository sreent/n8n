import type { PackageManifest } from '@/modules/n8n-packages/spec/manifest.schema';
import type {
	PackageCredentialRequirement,
	PackageDataTableRequirement,
	PackageNodeTypeRequirement,
	PackageRequirements,
	PackageTagRequirement,
	PackageVariableRequirement,
	PackageWorkflowRequirement,
} from '@/modules/n8n-packages/spec/requirements.schema';

type ManifestEntry = NonNullable<PackageManifest['workflows']>[number];
type EntryList = 'folders' | 'projects' | 'credentials' | 'dataTables' | 'variables' | 'tags';

const ENTRY_LISTS: EntryList[] = [
	'folders',
	'projects',
	'credentials',
	'dataTables',
	'variables',
	'tags',
];

/** Replaces the entries with the ids of the new entries, and adds the other new entries at the end. */
function upsertEntries(old: ManifestEntry[] | undefined, added: ManifestEntry[] | undefined) {
	const result = [...(old ?? [])];
	for (const entry of added ?? []) {
		const index = result.findIndex(({ id }) => id === entry.id);
		if (index >= 0) result[index] = entry;
		else result.push(entry);
	}
	return result;
}

/**
 * Removes the uses of the replaced workflows, and the requirements that no workflow uses then.
 * Adds the new requirements: a requirement that exists gets the new uses, in the order of the ids.
 */
function mergeUses<T extends { usedByWorkflows: string[] }>(
	old: T[] | undefined,
	added: T[] | undefined,
	keyOf: (entry: T) => string,
	replaced: ReadonlySet<string>,
) {
	const result: T[] = [];
	for (const entry of old ?? []) {
		const usedByWorkflows = entry.usedByWorkflows.filter((id) => !replaced.has(id));
		if (usedByWorkflows.length > 0) result.push({ ...entry, usedByWorkflows });
	}
	for (const entry of added ?? []) {
		const index = result.findIndex((existing) => keyOf(existing) === keyOf(entry));
		if (index < 0) {
			result.push(entry);
			continue;
		}
		result[index] = {
			...entry,
			usedByWorkflows: [
				...new Set([...result[index].usedByWorkflows, ...entry.usedByWorkflows]),
			].sort(),
		};
	}
	return result;
}

function mergeRequirements(
	old: PackageRequirements | undefined,
	added: PackageRequirements | undefined,
	replaced: ReadonlySet<string>,
): PackageRequirements | undefined {
	const byId = ({ id }: { id: string }) => id;
	const credentials = mergeUses<PackageCredentialRequirement>(
		old?.credentials,
		added?.credentials,
		byId,
		replaced,
	);
	const dataTables = mergeUses<PackageDataTableRequirement>(
		old?.dataTables,
		added?.dataTables,
		byId,
		replaced,
	);
	const workflows = mergeUses<PackageWorkflowRequirement>(
		old?.workflows,
		added?.workflows,
		byId,
		replaced,
	);
	const variables = mergeUses<PackageVariableRequirement>(
		old?.variables,
		added?.variables,
		({ name }) => name,
		replaced,
	);
	const tags = mergeUses<PackageTagRequirement>(old?.tags, added?.tags, byId, replaced);
	const nodeTypes = mergeUses<PackageNodeTypeRequirement>(
		old?.nodeTypes,
		added?.nodeTypes,
		({ type, typeVersion }) => `${type}@${typeVersion}`,
		replaced,
	);
	const merged: PackageRequirements = {
		...(credentials.length > 0 ? { credentials } : {}),
		...(dataTables.length > 0 ? { dataTables } : {}),
		...(workflows.length > 0 ? { workflows } : {}),
		...(variables.length > 0 ? { variables } : {}),
		...(tags.length > 0 ? { tags } : {}),
		...(nodeTypes.length > 0 ? { nodeTypes } : {}),
	};
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The manifest of a package after a selective promotion: the manifest on the branch with the
 * entries of the selection. `replaced` holds the ids of the selected and the deleted workflows,
 * whose old entries go. The workflows stay in the order of their folders.
 */
export function mergeSelectionManifest(
	old: PackageManifest | undefined,
	selection: PackageManifest,
	replaced: ReadonlySet<string>,
): PackageManifest {
	const workflows = [
		...(old?.workflows ?? []).filter(({ id }) => !replaced.has(id)),
		...(selection.workflows ?? []),
	].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
	const manifest: PackageManifest = {
		packageFormatVersion: selection.packageFormatVersion,
		exportedAt: selection.exportedAt,
		sourceN8nVersion: selection.sourceN8nVersion,
		sourceId: selection.sourceId,
	};
	for (const list of ENTRY_LISTS) {
		const entries = upsertEntries(old?.[list], selection[list]);
		if (entries.length > 0) manifest[list] = entries;
	}
	if (workflows.length > 0) manifest.workflows = workflows;
	const requirements = mergeRequirements(old?.requirements, selection.requirements, replaced);
	if (requirements) manifest.requirements = requirements;
	return manifest;
}
