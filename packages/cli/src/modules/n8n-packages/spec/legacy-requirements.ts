// Fork code (not in upstream n8n): reads the requirements of a package that an older n8n wrote.
// Each requirement of such a package names its consumers in `usedByWorkflows`, a list of workflow
// IDs. Upstream n8n replaced the field with `usedBy` and kept the format version, so it rejects
// those packages. Git sync and Git connections keep packages in Git repositories, so the fork
// reads the old field as a list of workflow consumers. See ../FORK.md.
import { isRecord } from '@n8n/utils/is-record';

const REQUIREMENT_LISTS = [
	'credentials',
	'dataTables',
	'workflows',
	'agents',
	'variables',
	'tags',
	'nodeTypes',
] as const;

function upgradeRequirement(requirement: unknown): unknown {
	if (!isRecord(requirement) || 'usedBy' in requirement) return requirement;
	const { usedByWorkflows, ...rest } = requirement;
	if (!Array.isArray(usedByWorkflows)) return requirement;
	return { ...rest, usedBy: usedByWorkflows.map((id: unknown) => ({ kind: 'workflow', id })) };
}

/** Gives the requirements with `usedBy` in place of `usedByWorkflows`. Other values stay as they are. */
export function upgradeLegacyRequirements(requirements: unknown): unknown {
	if (!isRecord(requirements)) return requirements;
	const upgraded: Record<string, unknown> = { ...requirements };
	for (const list of REQUIREMENT_LISTS) {
		const entries = requirements[list];
		if (Array.isArray(entries)) upgraded[list] = entries.map(upgradeRequirement);
	}
	return upgraded;
}
