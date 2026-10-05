import { RESOURCES } from '../constants';
import type { Resource, Scope } from '../types';

/** For each resource, the operations that the scopes allow. */
export type PermissionsRecord = {
	[R in Resource]: Partial<Record<(typeof RESOURCES)[R][number], boolean>>;
};

/** Turn a list of scopes into a record of allowed operations for each resource. */
export function getResourcePermissions(scopes: readonly Scope[] = []): PermissionsRecord {
	const permissions: Record<string, Record<string, boolean>> = {};
	for (const resource of Object.keys(RESOURCES)) permissions[resource] = {};

	for (const scope of scopes) {
		const [resource, operation] = scope.split(':');
		if (resource in permissions) permissions[resource][operation] = true;
	}

	return permissions as PermissionsRecord;
}
