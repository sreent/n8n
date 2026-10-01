import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

export type CredentialMatchingMode = 'name-and-type' | 'id-only';

/** The connection fields of the settings form. */
export interface GitSyncSettingsForm {
	repositoryUrl: string;
	branch: string;
	directory: string;
	projectId: string;
	username: string;
	/** The blanking value keeps the stored token. An empty value removes it. */
	accessToken: string;
	authorName: string;
	authorEmail: string;
	credentialMatchingMode: CredentialMatchingMode;
}

export interface GitSyncSettings extends GitSyncSettingsForm {
	projectName: string | null;
}

export interface GitSyncConnectionTestResult {
	defaultBranch: string | null;
	branchExists: boolean;
	branchHead: string | null;
}

export interface GitSyncProjectOption {
	id: string;
	name: string;
	type: string;
}

export interface GitSyncWorkflowChange {
	id: string;
	name: string;
	change: 'created' | 'modified' | 'deleted';
}

export interface GitSyncStatus {
	branch: string;
	remoteHead: string | null;
	lastSyncedCommit: string | null;
	remoteChanged: boolean;
	outgoing: GitSyncWorkflowChange[];
	incoming: GitSyncWorkflowChange[];
	conflicts: GitSyncWorkflowChange[];
	lastPush: { at: string; userId: string; commit: string; message: string } | null;
	lastPull: {
		at: string;
		userId: string;
		commit: string;
		created: number;
		updated: number;
		skipped: number;
	} | null;
}

export type GitSyncPushResult =
	| { result: 'up-to-date'; commit: string | null }
	| { result: 'pushed'; commit: string; changedFiles: number };

export type GitSyncPullResult =
	| { result: 'no-remote-branch' }
	| { result: 'no-package'; commit: string }
	| { result: 'up-to-date'; commit: string; removedUpstream: GitSyncWorkflowChange[] }
	| {
			result: 'pulled';
			commit: string;
			created: string[];
			updated: string[];
			skipped: string[];
			stubbedCredentials: string[];
			publishingBlocked: string[];
			removedUpstream: GitSyncWorkflowChange[];
	  };

/** Fields the form may leave empty. The backend fills in the defaults. */
const toRequestBody = (form: GitSyncSettingsForm) => ({
	...form,
	projectId: form.projectId || undefined,
});

export async function getGitSyncSettings(
	context: IRestApiContext,
): Promise<GitSyncSettings | null> {
	return await makeRestApiRequest(context, 'GET', '/git-sync/settings');
}

export async function saveGitSyncSettings(
	context: IRestApiContext,
	form: GitSyncSettingsForm,
): Promise<GitSyncSettings> {
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
