import type { SourceControlledFile } from '@n8n/api-types';

/** The repository host of a URL, for telemetry. */
export function getRepoType(repositoryUrl: string | undefined): 'github' | 'gitlab' | 'other' {
	const url = repositoryUrl ?? '';
	if (url.includes('github.com')) return 'github';
	if (url.includes('gitlab.com')) return 'gitlab';
	return 'other';
}

/** The numbers of a pull for telemetry: the workflow entries and the entries in conflict. */
export function getTrackingInformationFromPullResult(
	userId: string,
	result: SourceControlledFile[],
) {
	const count = (type: SourceControlledFile['type'], conflicted: boolean) =>
		result.filter((file) => file.type === type && (!conflicted || file.status === 'conflicted'))
			.length;
	return {
		userId,
		credConflicts: count('credential', true),
		workflowConflicts: count('workflow', true),
		workflowUpdates: count('workflow', false),
	};
}

/** The numbers of a status for a push, for telemetry. */
export function getTrackingInformationFromPrePushResult(
	userId: string,
	result: SourceControlledFile[],
) {
	const workflows = result.filter((file) => file.type === 'workflow');
	const credentials = result.filter((file) => file.type === 'credential');
	return {
		userId,
		workflowsEligible: workflows.length,
		workflowsEligibleWithConflicts: workflows.filter((file) => file.conflict).length,
		credsEligible: credentials.length,
		credsEligibleWithConflicts: credentials.filter((file) => file.conflict).length,
		variablesEligible: result.filter((file) => file.type === 'variables').length,
	};
}

/** The numbers of a push, for telemetry. Only the workflows have a count. */
export function getTrackingInformationFromPostPushResult(
	userId: string,
	result: SourceControlledFile[],
) {
	const workflows = result.filter((file) => file.type === 'workflow').length;
	return {
		userId,
		workflowsPushed: workflows,
		workflowsEligible: workflows,
		credsPushed: 0,
		variablesPushed: 0,
	};
}
