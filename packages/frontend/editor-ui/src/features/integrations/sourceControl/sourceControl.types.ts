// Fork code (not in upstream n8n): the types of the source control stand-ins. See `FORK.md` in
// this folder.
import type { SourceControlledFile } from '@n8n/api-types';

import type { IWorkflowDb } from '@/Interface';

export type { SourceControlledFile };

export type SshKeyTypes = 'ed25519' | 'rsa';

/** The connection of the instance to a Git repository, as the REST API of source control gave it. */
export interface SourceControlPreferences {
	connected: boolean;
	repositoryUrl: string;
	branchName: string;
	branches: string[];
	branchReadOnly: boolean;
	branchColor: string;
	publicKey?: string;
	keyGeneratorType?: SshKeyTypes;
	connectionType?: 'ssh' | 'https';
}

/** A workflow of the connected branch, as the REST API of source control gave it. */
export interface RemoteWorkflowResponse {
	content: IWorkflowDb;
	type: 'workflow';
}

/** How a pull publishes the workflows that it imports. */
export type AutoPublishMode = 'none' | 'all' | 'published';
