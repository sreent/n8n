/** Must match the backend module id. */
export const GIT_SYNC_MODULE_ID = 'git-sync';

export const GIT_SYNC_STORE = 'gitSync';

/** Route name of the settings page. */
export const GIT_SYNC_SETTINGS_VIEW = 'SettingsGitSyncView';

/**
 * Mirrors CREDENTIAL_BLANKING_VALUE from n8n-workflow. The API returns it in place of
 * a stored token. Sending it back keeps the stored token.
 */
export const CREDENTIALS_BLANKING_VALUE = '__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6';

export const DEFAULT_DIRECTORY = 'n8n';
export const DEFAULT_USERNAME = 'x-access-token';
export const DEFAULT_AUTHOR_NAME = 'n8n Git sync';

/** Error codes that the page handles. The backend sends them in `meta.code`. */
export const GIT_SYNC_ERROR_CODES = {
	pullFirst: 'GIT_SYNC_PULL_FIRST',
	localChanges: 'GIT_SYNC_LOCAL_CHANGES',
} as const;
