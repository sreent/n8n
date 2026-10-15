import type { PromotionProviderAuthType } from '@n8n/api-types';
import { BadRequestError } from '@n8n/errors';

/** `[user@]host:path`, the short form of an SSH URL. The path cannot be empty. */
const SCP_LIKE_URL = /^(?:[^@\s/:]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):(?!\/\/)[^\s:][^\s]*$/;

function parseUrl(url: string) {
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
}

/**
 * Checks that a remote URL suits the authentication method of a provider. A username and a
 * password provider needs an HTTP(S) URL. An SSH key provider needs `ssh://` or
 * `[user@]host:path`. No URL can hold a password, and an HTTP(S) URL cannot hold a username.
 */
export function checkRemoteUrl(remoteUrl: string, authType: PromotionProviderAuthType) {
	const url = parseUrl(remoteUrl);
	if (authType === 'token') {
		if (!url) throw new BadRequestError('Remote URL must be a valid HTTP or HTTPS URL');
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new BadRequestError('Username and password providers require an HTTP(S) remote URL');
		}
		if (url.username || url.password) {
			throw new BadRequestError('Remote URL must not contain credentials');
		}
		return;
	}
	if (url?.protocol === 'ssh:') {
		if (url.password) throw new BadRequestError('Remote URL must not contain credentials');
		if (url.hostname && url.pathname.length > 1 && !url.hostname.startsWith('-')) return;
	} else if (!remoteUrl.startsWith('-') && SCP_LIKE_URL.test(remoteUrl)) {
		return;
	}
	throw new BadRequestError('SSH key providers require an ssh:// or [user@]host:path remote URL');
}
