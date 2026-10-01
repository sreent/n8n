import { Z } from '@n8n/api-types';
import { z } from 'zod';

import { DEFAULT_GIT_USERNAME, DEFAULT_PACKAGE_DIRECTORY } from './git-sync.constants';
import { credentialMatchingModeSchema } from './git-sync.types';

export class GitSyncSettingsDto extends Z.class({
	repositoryUrl: z.string().trim().min(1).max(2048),
	branch: z.string().trim().min(1).max(255),
	directory: z.string().trim().max(255).default(DEFAULT_PACKAGE_DIRECTORY),
	projectId: z.string().trim().min(1).max(64).optional(),
	username: z.string().trim().min(1).max(255).default(DEFAULT_GIT_USERNAME),
	/** Omit, or send the blanking value, to keep the stored token. Send an empty string to remove it. */
	accessToken: z.string().max(8192).optional(),
	authorName: z.string().trim().min(1).max(255).default('n8n Git sync'),
	authorEmail: z.string().trim().email().max(255),
	credentialMatchingMode: credentialMatchingModeSchema.default('name-and-type'),
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
