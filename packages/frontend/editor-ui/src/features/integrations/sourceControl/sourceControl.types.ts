// Fork code (not in upstream n8n): the types of the source control editor. See `FORK.md` in this
// folder.
import type {
	GitCommitInfo,
	PullWorkFolderRequestDto,
	PushWorkFolderRequestDto,
	SourceControlledFile,
} from '@n8n/api-types';

import type { IWorkflowDb } from '@/Interface';

export type { SourceControlledFile };

export type SshKeyTypes = 'ed25519' | 'rsa';

export type ConnectionType = 'ssh' | 'https';

/** The connection of the instance to a Git repository, as the REST API of source control gives it. */
export interface SourceControlPreferences {
	connected: boolean;
	repositoryUrl: string;
	branchName: string;
	branches: string[];
	branchReadOnly: boolean;
	branchColor: string;
	publicKey?: string;
	keyGeneratorType?: SshKeyTypes;
	connectionType?: ConnectionType;
	/** The branch of the work folder, from `GET /source-control/get-branches`. */
	currentBranch?: string;
}

/** The fields that the settings page sends to `POST /source-control/preferences`. */
export type SourceControlPreferencesUpdate = Partial<SourceControlPreferences> & {
	httpsUsername?: string;
	httpsPassword?: string;
};

/** The answer of `GET /source-control/get-branches`. */
export interface SourceControlBranches {
	branches: string[];
	currentBranch: string;
}

/** The query of `GET /source-control/get-status`. */
export interface SourceControlStatusOptions {
	direction: 'push' | 'pull';
	preferLocalVersion: boolean;
	verbose: boolean;
}

/** A workflow of the connected branch, as the REST API of source control gives it. */
export interface RemoteWorkflowResponse {
	content: IWorkflowDb;
	type: 'workflow';
}

/** How a pull publishes the workflows that it imports. */
export type AutoPublishMode = 'none' | 'all' | 'published';

export type PushWorkfolderData = PushWorkFolderRequestDto;

/** The body of a pull. Without `autoPublish`, the server uses `none`. */
export type PullWorkfolderData = Partial<PullWorkFolderRequestDto>;

/** The answer of `POST /source-control/push-workfolder`. */
export interface PushWorkfolderResult {
	files: SourceControlledFile[];
	commit: GitCommitInfo | null;
}
