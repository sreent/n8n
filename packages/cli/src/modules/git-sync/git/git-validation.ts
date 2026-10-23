import { GIT_SYNC_ERROR_CODES } from '@n8n/api-types';

import { GitSyncError } from '../git-sync.errors';

const invalid = (message: string) =>
	new GitSyncError(message, 400, GIT_SYNC_ERROR_CODES.invalidSettings);

/**
 * Checks a repository URL. The URL must use an allowed protocol and host, and
 * must not carry credentials, a query, or a fragment. The token goes in its own field.
 */
export function validateRepositoryUrl(
	raw: string,
	allowedProtocols: readonly string[],
	allowedHosts: readonly string[],
): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw invalid('The repository URL is not valid.');
	}

	const protocol = url.protocol.replace(/:$/, '');
	if (!allowedProtocols.includes(protocol)) {
		throw invalid(`The repository URL must use ${allowedProtocols.join(' or ')}.`);
	}
	if (url.username || url.password) {
		throw invalid(
			'Remove the user name and password from the repository URL. Use the access token field.',
		);
	}
	if (url.search || url.hash) {
		throw invalid('The repository URL must not have a query or a fragment.');
	}
	if (
		protocol !== 'file' &&
		allowedHosts.length > 0 &&
		!allowedHosts.map((host) => host.toLowerCase()).includes(url.hostname.toLowerCase())
	) {
		throw invalid(`The host ${url.hostname} is not in N8N_GIT_SYNC_ALLOWED_HOSTS.`);
	}

	return url;
}

// A strict subset of `git check-ref-format --branch`: no leading or trailing slash or
// dot, no `..`, no `//`, no `@{`, no `.lock` suffix, and no leading hyphen.
const BRANCH_PATTERN = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|\/\.|\.lock$|[/.]$))[A-Za-z0-9._/-]+$/;

export function validateBranch(branch: string): string {
	if (!BRANCH_PATTERN.test(branch) || branch.length > 255) {
		throw invalid(`"${branch}" is not a valid branch name.`);
	}
	return branch;
}

// Folder segments: letters, digits, `_`, `-` and `.`, but a segment cannot start with a dot.
// This blocks `.git`, `..`, and hidden folders.
const DIRECTORY_PATTERN = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)?$/;

/** Checks the repository folder that holds the package. An empty string means the repository root. */
export function validateDirectory(directory: string): string {
	const trimmed = directory.replace(/^\/+|\/+$/g, '');
	if (!DIRECTORY_PATTERN.test(trimmed)) {
		throw invalid(`"${directory}" is not a valid folder in the repository.`);
	}
	return trimmed;
}
