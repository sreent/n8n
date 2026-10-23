import type { GitSyncWorkflowChange } from '@n8n/api-types';
import { isRecord } from '@n8n/utils/is-record';

const CHANGE_KINDS: ReadonlySet<string> = new Set(['created', 'modified', 'deleted']);

function isWorkflowChange(value: unknown): value is GitSyncWorkflowChange {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		typeof value.change === 'string' &&
		CHANGE_KINDS.has(value.change)
	);
}

function errorMeta(error: unknown): Record<string, unknown> | undefined {
	if (!isRecord(error)) return undefined;
	return isRecord(error.meta) ? error.meta : undefined;
}

/** The Git sync error code from `meta.code` of an API error. */
export function errorCode(error: unknown): string | undefined {
	const code = errorMeta(error)?.code;
	return typeof code === 'string' ? code : undefined;
}

/** The workflows that changed on both sides, from `meta.conflicts` of an API error. */
export function errorConflicts(error: unknown): GitSyncWorkflowChange[] {
	const conflicts = errorMeta(error)?.conflicts;
	return Array.isArray(conflicts) ? conflicts.filter(isWorkflowChange) : [];
}
