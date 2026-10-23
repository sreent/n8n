import {
	GIT_SYNC_DEFAULT_AUTHOR_NAME,
	GIT_SYNC_DEFAULT_DIRECTORY,
	GIT_SYNC_DEFAULT_USERNAME,
	GitSyncPullDto,
	GitSyncPushDto,
	GitSyncSettingsDto,
} from '../git-sync.dto';

const settings = {
	repositoryUrl: 'https://git.example.com/acme/workflows.git',
	branch: 'main',
	authorEmail: 'ada@example.com',
};

describe('GitSyncSettingsDto', () => {
	test('fills in the defaults', () => {
		const result = GitSyncSettingsDto.safeParse(settings);

		expect(result.success).toBe(true);
		expect(result.data).toEqual({
			...settings,
			directory: GIT_SYNC_DEFAULT_DIRECTORY,
			username: GIT_SYNC_DEFAULT_USERNAME,
			authorName: GIT_SYNC_DEFAULT_AUTHOR_NAME,
			credentialMatchingMode: 'name-and-type',
		});
	});

	test.each([
		{ name: 'an empty repository URL', request: { ...settings, repositoryUrl: ' ' } },
		{ name: 'an author e-mail that is not valid', request: { ...settings, authorEmail: 'ada' } },
		{
			name: 'an unknown matching mode',
			request: { ...settings, credentialMatchingMode: 'name-only' },
		},
	])('rejects $name', ({ request }) => {
		expect(GitSyncSettingsDto.safeParse(request).success).toBe(false);
	});
});

describe('GitSyncPushDto', () => {
	test('needs a commit message', () => {
		expect(GitSyncPushDto.safeParse({ message: '  ' }).success).toBe(false);
		expect(GitSyncPushDto.safeParse({ message: 'Update' }).data).toEqual({
			message: 'Update',
			replaceRemoteContent: false,
		});
	});
});

describe('GitSyncPullDto', () => {
	test('pulls only the changes by default', () => {
		expect(GitSyncPullDto.safeParse({}).data).toEqual({
			overwriteLocalChanges: false,
			full: false,
		});
	});
});
