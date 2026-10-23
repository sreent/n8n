import type {
	GitSyncConnectionTestResult,
	GitSyncProjectOption,
	GitSyncPullResult,
	GitSyncPushResult,
	GitSyncSettingsResponse,
	GitSyncStatus,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/**
 * The connection fields of the settings form. The blanking value of `accessToken` keeps the stored
 * token. An empty value removes it.
 */
export type GitSyncSettingsForm = Omit<GitSyncSettingsResponse, 'projectName'>;

/** Fields the form may leave empty. The backend fills in the defaults. */
const toRequestBody = (form: GitSyncSettingsForm) => ({
	...form,
	projectId: form.projectId || undefined,
});

export async function getGitSyncSettings(
	context: IRestApiContext,
): Promise<GitSyncSettingsResponse | null> {
	return await makeRestApiRequest(context, 'GET', '/git-sync/settings');
}

export async function saveGitSyncSettings(
	context: IRestApiContext,
	form: GitSyncSettingsForm,
): Promise<GitSyncSettingsResponse> {
	return await makeRestApiRequest(context, 'PUT', '/git-sync/settings', toRequestBody(form));
}

export async function deleteGitSyncSettings(context: IRestApiContext): Promise<void> {
	await makeRestApiRequest(context, 'DELETE', '/git-sync/settings');
}

export async function testGitSyncConnection(
	context: IRestApiContext,
	form: GitSyncSettingsForm,
): Promise<GitSyncConnectionTestResult> {
	return await makeRestApiRequest(
		context,
		'POST',
		'/git-sync/test-connection',
		toRequestBody(form),
	);
}

export async function getGitSyncProjects(
	context: IRestApiContext,
	search?: string,
): Promise<GitSyncProjectOption[]> {
	return await makeRestApiRequest(context, 'GET', '/git-sync/projects', search ? { search } : {});
}

export async function getGitSyncStatus(context: IRestApiContext): Promise<GitSyncStatus> {
	return await makeRestApiRequest(context, 'GET', '/git-sync/status');
}

export async function pushToGit(
	context: IRestApiContext,
	body: { message: string; replaceRemoteContent: boolean },
): Promise<GitSyncPushResult> {
	return await makeRestApiRequest(context, 'POST', '/git-sync/push', body);
}

export async function pullFromGit(
	context: IRestApiContext,
	body: { overwriteLocalChanges: boolean; full: boolean },
): Promise<GitSyncPullResult> {
	return await makeRestApiRequest(context, 'POST', '/git-sync/pull', body);
}
