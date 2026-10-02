import { ResponseError } from '@n8n/errors';

import type { GitSyncErrorCode } from './git-sync.constants';

/**
 * An error that the Git sync API sends to the client. The client reads
 * `meta.code` to show a specific message, for example "pull first".
 */
export class GitSyncError extends ResponseError {
	override readonly meta: { code: GitSyncErrorCode } & Record<string, unknown>;

	constructor(
		message: string,
		httpStatusCode: number,
		code: GitSyncErrorCode,
		details: Record<string, unknown> = {},
	) {
		super(message, httpStatusCode);
		this.name = 'GitSyncError';
		this.meta = { code, ...details };
	}
}
