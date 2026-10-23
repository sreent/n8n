// Fork code (not in upstream n8n): the REST API of Git sync (`/rest/git-sync`), for the backend
// module and the editor module. See packages/cli/src/modules/git-sync/README.md.
import { z } from 'zod';

import { Z } from '../../zod-class';

/** The default folder in the repository that holds the package. */
export const GIT_SYNC_DEFAULT_DIRECTORY = 'n8n';

/** The default user name for HTTPS token auth. GitHub, GitLab and Azure DevOps accept it. */
export const GIT_SYNC_DEFAULT_USERNAME = 'x-access-token';

/** The default author name of the commits of Git sync. */
export const GIT_SYNC_DEFAULT_AUTHOR_NAME = 'n8n Git sync';

/** Error codes in `meta.code` of Git sync error responses. */
export const GIT_SYNC_ERROR_CODES = {
	gitMissing: 'GIT_SYNC_GIT_MISSING',
	notConfigured: 'GIT_SYNC_NOT_CONFIGURED',
	invalidSettings: 'GIT_SYNC_INVALID_SETTINGS',
	authFailed: 'GIT_SYNC_AUTH_FAILED',
	remoteUnreachable: 'GIT_SYNC_REMOTE_UNREACHABLE',
	busy: 'GIT_SYNC_BUSY',
	pullFirst: 'GIT_SYNC_PULL_FIRST',
	pushRejected: 'GIT_SYNC_PUSH_REJECTED',
	localChanges: 'GIT_SYNC_LOCAL_CHANGES',
	unsupportedRepository: 'GIT_SYNC_UNSUPPORTED_REPOSITORY',
	invalidPackage: 'GIT_SYNC_INVALID_PACKAGE',
	gitFailed: 'GIT_SYNC_GIT_FAILED',
} as const;

export type GitSyncErrorCode = (typeof GIT_SYNC_ERROR_CODES)[keyof typeof GIT_SYNC_ERROR_CODES];

/** How the import matches package credentials to credentials on this instance. */
export const gitSyncCredentialMatchingModeSchema = z.enum(['name-and-type', 'id-only']);
export type GitSyncCredentialMatchingMode = z.infer<typeof gitSyncCredentialMatchingModeSchema>;

export class GitSyncSettingsDto extends Z.class({
	repositoryUrl: z.string().trim().min(1).max(2048),
	branch: z.string().trim().min(1).max(255),
	directory: z.string().trim().max(255).default(GIT_SYNC_DEFAULT_DIRECTORY),
	projectId: z.string().trim().min(1).max(64).optional(),
	username: z.string().trim().min(1).max(255).default(GIT_SYNC_DEFAULT_USERNAME),
	/** Omit, or send the blanking value, to keep the stored token. Send an empty string to remove it. */
	accessToken: z.string().max(8192).optional(),
	authorName: z.string().trim().min(1).max(255).default(GIT_SYNC_DEFAULT_AUTHOR_NAME),
	authorEmail: z.string().trim().email().max(255),
	credentialMatchingMode: gitSyncCredentialMatchingModeSchema.default('name-and-type'),
}) {}

export class GitSyncProjectsQueryDto extends Z.class({
	search: z.string().trim().max(100).optional(),
}) {}

export class GitSyncPushDto extends Z.class({
	message: z.string().trim().min(1).max(1000),
	/** Commit the n8n content on top of the remote branch, even when the branch has new commits. */
	replaceRemoteContent: z.boolean().default(false),
}) {}

export class GitSyncPullDto extends Z.class({
	/** Replace workflows that changed in n8n since the last sync and also changed in Git. */
	overwriteLocalChanges: z.boolean().default(false),
	/** Import every workflow in the package, not only the ones that changed since the last sync. */
	full: z.boolean().default(false),
}) {}

/** The connection as the API returns it. The token is never returned. */
export interface GitSyncSettingsResponse {
	repositoryUrl: string;
	branch: string;
	directory: string;
	projectId: string;
	username: string;
	/** The blanking value when a token is stored, or an empty string. */
	accessToken: string;
	authorName: string;
	authorEmail: string;
	credentialMatchingMode: GitSyncCredentialMatchingMode;
	projectName: string | null;
}

export interface GitSyncConnectionTestResult {
	/** The default branch of the repository, or null for an empty repository. */
	defaultBranch: string | null;
	branchExists: boolean;
	branchHead: string | null;
}

export interface GitSyncProjectOption {
	id: string;
	name: string;
	type: string;
}

/** One workflow that changed. */
export interface GitSyncWorkflowChange {
	id: string;
	name: string;
	change: 'created' | 'modified' | 'deleted';
}

export interface GitSyncLastPush {
	at: string;
	userId: string;
	commit: string;
	message: string;
}

export interface GitSyncLastPull {
	at: string;
	userId: string;
	commit: string;
	created: number;
	updated: number;
	skipped: number;
}

export interface GitSyncStatus {
	branch: string;
	remoteHead: string | null;
	lastSyncedCommit: string | null;
	/** True when the branch has commits that this instance has not pulled. */
	remoteChanged: boolean;
	/** Workflows changed in n8n since the last sync. */
	outgoing: GitSyncWorkflowChange[];
	/** Workflows changed in Git since the last sync. */
	incoming: GitSyncWorkflowChange[];
	/** Workflows changed in both places. */
	conflicts: GitSyncWorkflowChange[];
	lastPush: GitSyncLastPush | null;
	lastPull: GitSyncLastPull | null;
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
