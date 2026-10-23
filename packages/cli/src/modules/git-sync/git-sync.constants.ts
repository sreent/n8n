/** Settings row that holds the connection. The access token is encrypted. */
export const GIT_SYNC_CONNECTION_KEY = 'features.gitSync.connection';

/** Settings row that holds the sync state: last synced commit and workflow baseline. */
export const GIT_SYNC_STATE_KEY = 'features.gitSync.state';

/** Key of the lease that keeps Git sync operations one at a time. */
export const GIT_SYNC_LOCK_KEY = 'git-sync:operation';

/** `GIT_CONFIG_COUNT` and friends need this Git version or later. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 31];
