import { gitSyncCredentialMatchingModeSchema } from '@n8n/api-types';
import { z } from 'zod';

// The schemas of the settings table. The shapes of the REST API are in `@n8n/api-types`.

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
	credentialMatchingMode: gitSyncCredentialMatchingModeSchema,
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
