import { CommaSeparatedStringArray, Config, Env } from '@n8n/config';

@Config
export class GitSyncConfig {
	/** Folder for the working copy. Empty means `<n8n folder>/git-sync`. */
	@Env('N8N_GIT_SYNC_DIR')
	dir: string = '';

	/**
	 * Protocols that Git may use. Only HTTPS is allowed by default.
	 * Do not allow `file` in production; it exists for tests.
	 */
	@Env('N8N_GIT_SYNC_ALLOWED_PROTOCOLS')
	allowedProtocols: CommaSeparatedStringArray<string> = ['https'];

	/** Hosts that a repository URL may use, for example `github.com,dev.azure.com`. Empty allows any host. */
	@Env('N8N_GIT_SYNC_ALLOWED_HOSTS')
	allowedHosts: CommaSeparatedStringArray<string> = [];

	/** Maximum duration of one Git command, in seconds. */
	@Env('N8N_GIT_SYNC_TIMEOUT_SECONDS')
	timeoutSeconds: number = 120;
}
