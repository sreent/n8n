/** Settings row that holds the connection. The access token is encrypted. */
export const GIT_SYNC_CONNECTION_KEY = 'features.gitSync.connection';

/** Settings row that holds the sync state: last synced commit and workflow baseline. */
export const GIT_SYNC_STATE_KEY = 'features.gitSync.state';

/** Key of the lease that keeps Git sync operations one at a time. */
export const GIT_SYNC_LOCK_KEY = 'git-sync:operation';

/** Default folder in the repository that holds the package. */
export const DEFAULT_PACKAGE_DIRECTORY = 'n8n';

/** Default user name for HTTPS token auth. GitHub, GitLab and Azure DevOps accept it. */
export const DEFAULT_GIT_USERNAME = 'x-access-token';

/** `GIT_CONFIG_COUNT` and friends need this Git version or later. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 31];

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
