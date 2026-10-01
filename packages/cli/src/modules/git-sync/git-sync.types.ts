import { z } from 'zod';

/** How the import matches package credentials to credentials on this instance. */
export const credentialMatchingModeSchema = z.enum(['name-and-type', 'id-only']);
export type GitSyncCredentialMatchingMode = z.infer<typeof credentialMatchingModeSchema>;

/** The connection as stored in the settings table. */
export const storedConnectionSchema = z.object({
	version: z.literal(1),
	repositoryUrl: z.string(),
	branch: z.string(),
	directory: z.string(),
	projectId: z.string(),
	username: z.string(),
	encryptedToken: z.string().nullable(),
	authorName: z.string(),
	authorEmail: z.string(),
	credentialMatchingMode: credentialMatchingModeSchema,
});
export type StoredConnection = z.infer<typeof storedConnectionSchema>;

/**
 * The publish state that a package import reads from the metadata file. The version IDs
 * themselves differ on every instance, so Git sync compares this state instead.
 */
export const publishStateSchema = z.enum(['unpublished', 'published', 'published-other-version']);
export type PublishState = z.infer<typeof publishStateSchema>;

/** One workflow as the last sync left it: the hash of its workflow file and its publish state. */
const workflowBaselineSchema = z.object({
	workflow: z.string(),
	publishState: publishStateSchema.optional(),
});
export type WorkflowBaseline = z.infer<typeof workflowBaselineSchema>;

const lastPushSchema = z.object({
	at: z.string(),
	userId: z.string(),
	commit: z.string(),
	message: z.string(),
});

const lastPullSchema = z.object({
	at: z.string(),
	userId: z.string(),
	commit: z.string(),
	created: z.number(),
	updated: z.number(),
	skipped: z.number(),
});

/** The sync state as stored in the settings table. */
export const storedStateSchema = z.object({
	version: z.literal(1),
	/** Hash of the connection fields that decide which content the state belongs to. */
	fingerprint: z.string(),
	lastSyncedCommit: z.string().nullable(),
	/** Workflow ID to its state after the last push or pull. */
	baseline: z.record(z.string(), workflowBaselineSchema),
	lastPush: lastPushSchema.nullable(),
	lastPull: lastPullSchema.nullable(),
});
export type StoredState = z.infer<typeof storedStateSchema>;

/** The connection with the token decrypted, for the Git client. */
export interface GitSyncConnection extends Omit<StoredConnection, 'encryptedToken' | 'version'> {
	token: string | null;
}

/** The connection as the API returns it. The token is never returned. */
export interface GitSyncSettingsResponse
	extends Omit<StoredConnection, 'encryptedToken' | 'version'> {
	/** The blanking value when a token is stored, or an empty string. */
	accessToken: string;
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
	lastPush: StoredState['lastPush'];
	lastPull: StoredState['lastPull'];
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
