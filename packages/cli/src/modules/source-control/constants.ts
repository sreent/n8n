/** Settings row that holds the preferences of source control. */
export const SOURCE_CONTROL_PREFERENCES_DB_KEY = 'features.sourceControl';

/** Settings row that holds the SSH key pair. The private key is encrypted. */
export const SOURCE_CONTROL_SSH_KEYS_DB_KEY = 'features.sourceControl.sshKeys';

/** Settings row that holds the HTTPS user name and password. Both are encrypted. */
export const SOURCE_CONTROL_HTTPS_CREDENTIALS_DB_KEY = 'features.sourceControl.httpsCredentials';

/** Folders and files of the work folder and of the n8n folder. */
export const SOURCE_CONTROL_GIT_FOLDER = 'git';
export const SOURCE_CONTROL_SSH_FOLDER = 'ssh';
export const SOURCE_CONTROL_SSH_KEY_NAME = 'key';
export const SOURCE_CONTROL_SSH_PRIVATE_KEY_TEMP_FILE = 'ssh_private_key_temp';
export const SOURCE_CONTROL_KNOWN_HOSTS_FILE = 'known_hosts';

export const SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER = 'workflows';
export const SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER = 'credential_stubs';
export const SOURCE_CONTROL_DATA_TABLE_EXPORT_FOLDER = 'datatables';
export const SOURCE_CONTROL_PROJECT_EXPORT_FOLDER = 'projects';
export const SOURCE_CONTROL_VARIABLES_EXPORT_FILE = 'variable_stubs.json';
export const SOURCE_CONTROL_TAGS_EXPORT_FILE = 'tags.json';
export const SOURCE_CONTROL_FOLDERS_EXPORT_FILE = 'folders.json';
export const SOURCE_CONTROL_README = 'README.md';

/** The content of `README.md` in the first commit of an empty repository. */
export const SOURCE_CONTROL_README_CONTENT = '\n# n8n Source Control\n';

export const SOURCE_CONTROL_DEFAULT_BRANCH = 'main';
export const SOURCE_CONTROL_DEFAULT_BRANCH_COLOR = '#5296D6';
export const SOURCE_CONTROL_DEFAULT_NAME = 'n8n user';
export const SOURCE_CONTROL_DEFAULT_EMAIL = 'n8n@example.com';
export const SOURCE_CONTROL_ORIGIN = 'origin';

/** The comment of the public key of each key pair. */
export const SOURCE_CONTROL_KEY_COMMENT = 'n8n deploy key';

/** The answer of the routes that need a connection, when there is none. */
export const SOURCE_CONTROL_NOT_CONNECTED_MESSAGE = 'source_control_not_connected';
