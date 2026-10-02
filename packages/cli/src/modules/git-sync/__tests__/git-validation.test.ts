import { GitSyncError } from '../git-sync.errors';
import { validateBranch, validateDirectory, validateRepositoryUrl } from '../git/git-validation';

describe('validateRepositoryUrl', () => {
	const httpsOnly = ['https'];

	it('accepts an HTTPS URL', () => {
		const url = validateRepositoryUrl('https://github.com/acme/flows.git', httpsOnly, []);

		expect(url.href).toBe('https://github.com/acme/flows.git');
	});

	it.each([
		['http://github.com/acme/flows.git'],
		['ssh://git@github.com/acme/flows.git'],
		['file:///srv/flows.git'],
		['https://user:secret@github.com/acme/flows.git'],
		['https://github.com/acme/flows.git?ref=main'],
		['https://github.com/acme/flows.git#main'],
		['not a url'],
	])('rejects %s', (url) => {
		expect(() => validateRepositoryUrl(url, httpsOnly, [])).toThrow(GitSyncError);
	});

	it('accepts only the allowed hosts, in any letter case', () => {
		expect(
			validateRepositoryUrl('https://GitHub.com/acme/flows.git', httpsOnly, ['github.com'])
				.hostname,
		).toBe('github.com');
		expect(() =>
			validateRepositoryUrl('https://gitlab.com/acme/flows.git', httpsOnly, ['github.com']),
		).toThrow('N8N_GIT_SYNC_ALLOWED_HOSTS');
	});

	it('does not apply the host list to file URLs when the file protocol is allowed', () => {
		expect(
			validateRepositoryUrl('file:///srv/flows.git', ['file', 'https'], ['github.com']).protocol,
		).toBe('file:');
	});

	it('reports a client error with the settings code', () => {
		try {
			validateRepositoryUrl('ftp://example.com/x', httpsOnly, []);
			throw new Error('expected an error');
		} catch (error) {
			expect(error).toBeInstanceOf(GitSyncError);
			expect((error as GitSyncError).httpStatusCode).toBe(400);
			expect((error as GitSyncError).meta.code).toBe('GIT_SYNC_INVALID_SETTINGS');
		}
	});
});

describe('validateBranch', () => {
	it.each(['main', 'release/2026-10', 'feature_x.y', 'n8n-prod'])('accepts %s', (branch) => {
		expect(validateBranch(branch)).toBe(branch);
	});

	it.each([
		'',
		'-main',
		'/main',
		'main/',
		'.main',
		'main.',
		'a..b',
		'a//b',
		'a@{1}',
		'main.lock',
		'refs/.hidden',
		'a b',
		'a~1',
		'a^',
		'a:b',
		'a\\b',
		'a*',
		'a?',
		'a[b',
		'x'.repeat(256),
	])('rejects %j', (branch) => {
		expect(() => validateBranch(branch)).toThrow(GitSyncError);
	});
});

describe('validateDirectory', () => {
	it('removes leading and trailing slashes', () => {
		expect(validateDirectory('/n8n/flows/')).toBe('n8n/flows');
	});

	it('accepts an empty value for the repository root', () => {
		expect(validateDirectory('')).toBe('');
	});

	it.each(['..', 'a/../b', '.git', 'a/.git', '.hidden', 'a b', 'a\\b', 'a//b'])(
		'rejects %j',
		(directory) => {
			expect(() => validateDirectory(directory)).toThrow(GitSyncError);
		},
	);
});
