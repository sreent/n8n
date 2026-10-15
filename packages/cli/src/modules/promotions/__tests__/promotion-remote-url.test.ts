import { checkRemoteUrl } from '../promotion-remote-url';

describe('checkRemoteUrl', () => {
	describe('a username and password provider', () => {
		it.each([
			'https://example.com/acme/flows.git',
			'http://example.com/acme/flows.git',
			'https://example.com',
		])('accepts %s', (url) => {
			expect(() => checkRemoteUrl(url, 'token')).not.toThrow();
		});

		it.each([
			['https://user:pass@example.com/acme/flows.git', 'Remote URL must not contain credentials'],
			['https://user@example.com/acme/flows.git', 'Remote URL must not contain credentials'],
			[
				'git://example.com/acme/flows.git',
				'Username and password providers require an HTTP(S) remote URL',
			],
			['file:///tmp/flows.git', 'Username and password providers require an HTTP(S) remote URL'],
			[
				'ssh://git@example.com/acme/flows.git',
				'Username and password providers require an HTTP(S) remote URL',
			],
			['git@example.com:acme/flows.git', 'Remote URL must be a valid HTTP or HTTPS URL'],
			['example.com/acme/flows.git', 'Remote URL must be a valid HTTP or HTTPS URL'],
			['-uhttps://example.com/acme/flows.git', 'Remote URL must be a valid HTTP or HTTPS URL'],
		])('refuses %s', (url, message) => {
			expect(() => checkRemoteUrl(url, 'token')).toThrow(message);
		});
	});

	describe('an SSH key provider', () => {
		it.each([
			'git@remote.test:acme/flows.git',
			'remote.test:acme/flows.git',
			'ssh://git@remote.test/acme/flows.git',
			'ssh://git@remote.test:2222/acme/flows.git',
		])('accepts %s', (url) => {
			expect(() => checkRemoteUrl(url, 'ssh-key')).not.toThrow();
		});

		it.each([
			['ssh://git:secret@remote.test/acme/flows.git', 'Remote URL must not contain credentials'],
			['git@remote.test:', 'SSH key providers require an ssh:// or [user@]host:path remote URL'],
			[
				'https://example.com/acme/flows.git',
				'SSH key providers require an ssh:// or [user@]host:path remote URL',
			],
			[
				'ext::ssh -o x remote.test %S acme/flows.git',
				'SSH key providers require an ssh:// or [user@]host:path remote URL',
			],
			[
				'-oProxyCommand=x:acme/flows.git',
				'SSH key providers require an ssh:// or [user@]host:path remote URL',
			],
		])('refuses %s', (url, message) => {
			expect(() => checkRemoteUrl(url, 'ssh-key')).toThrow(message);
		});
	});
});
