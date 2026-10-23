import type { GitSyncSettingsResponse } from '@n8n/api-types';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';
import { createPinia, setActivePinia } from 'pinia';

import { emptyForm, useGitSyncStore } from './git-sync.store';

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext: { baseUrl: '', pushRef: '' } }),
}));

type ApiMock = (...args: unknown[]) => Promise<unknown>;
const getSettingsMock = vi.fn<ApiMock>();
const saveSettingsMock = vi.fn<ApiMock>();
const deleteSettingsMock = vi.fn<ApiMock>();
const testConnectionMock = vi.fn<ApiMock>();
const getStatusMock = vi.fn<ApiMock>();
const pushMock = vi.fn<ApiMock>();
const pullMock = vi.fn<ApiMock>();
vi.mock('./git-sync.api', () => ({
	getGitSyncSettings: async (...args: unknown[]) => await getSettingsMock(...args),
	saveGitSyncSettings: async (...args: unknown[]) => await saveSettingsMock(...args),
	deleteGitSyncSettings: async (...args: unknown[]) => await deleteSettingsMock(...args),
	testGitSyncConnection: async (...args: unknown[]) => await testConnectionMock(...args),
	getGitSyncProjects: async () => await Promise.resolve([]),
	getGitSyncStatus: async (...args: unknown[]) => await getStatusMock(...args),
	pushToGit: async (...args: unknown[]) => await pushMock(...args),
	pullFromGit: async (...args: unknown[]) => await pullMock(...args),
}));

const saved: GitSyncSettingsResponse = {
	repositoryUrl: 'https://github.com/acme/flows.git',
	branch: 'main',
	directory: 'n8n',
	projectId: 'project-1',
	projectName: 'Ada Lovelace',
	username: 'x-access-token',
	accessToken: CREDENTIAL_BLANKING_VALUE,
	authorName: 'n8n Git sync',
	authorEmail: 'bot@example.com',
	credentialMatchingMode: 'name-and-type',
};

beforeEach(() => {
	vi.clearAllMocks();
	setActivePinia(createPinia());
});

describe('useGitSyncStore', () => {
	it('starts a new connection with the email of the user', async () => {
		getSettingsMock.mockResolvedValue(null);
		const store = useGitSyncStore();

		await store.fetchSettings('ada@example.com');

		expect(store.isConnected).toBe(false);
		expect(store.form).toEqual(emptyForm('ada@example.com'));
		expect(store.isDirty).toBe(false);
		expect(store.canSave).toBe(false);
	});

	it('loads the saved connection into the form and tracks edits', async () => {
		getSettingsMock.mockResolvedValue(saved);
		const store = useGitSyncStore();

		await store.fetchSettings();
		expect(store.isConnected).toBe(true);
		expect(store.form.accessToken).toBe(CREDENTIAL_BLANKING_VALUE);
		expect(store.isDirty).toBe(false);

		store.form.branch = 'prod';
		expect(store.isDirty).toBe(true);

		store.discardChanges();
		expect(store.form.branch).toBe('main');
	});

	it('saves the form and clears the old status', async () => {
		getSettingsMock.mockResolvedValue(null);
		saveSettingsMock.mockResolvedValue(saved);
		const store = useGitSyncStore();
		await store.fetchSettings('bot@example.com');
		store.form.repositoryUrl = saved.repositoryUrl;

		await store.saveSettings();

		expect(saveSettingsMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ repositoryUrl: saved.repositoryUrl, branch: 'main' }),
		);
		expect(store.settings).toEqual(saved);
		expect(store.isDirty).toBe(false);
		expect(store.saving).toBe(false);
	});

	it('forgets everything on disconnect', async () => {
		getSettingsMock.mockResolvedValue(saved);
		pushMock.mockResolvedValue({ result: 'pushed', commit: 'abc', changedFiles: 2 });
		const store = useGitSyncStore();
		await store.fetchSettings();
		await store.push('First push');

		await store.disconnect();

		expect(deleteSettingsMock).toHaveBeenCalled();
		expect(store.isConnected).toBe(false);
		expect(store.lastPushResult).toBeNull();
		expect(store.form.authorEmail).toBe('bot@example.com');
	});

	it('sends the push and pull options', async () => {
		pushMock.mockResolvedValue({ result: 'up-to-date', commit: 'abc' });
		pullMock.mockResolvedValue({ result: 'no-remote-branch' });
		const store = useGitSyncStore();

		await store.push('Release', true);
		await store.pull(true, false);

		expect(pushMock).toHaveBeenCalledWith(expect.anything(), {
			message: 'Release',
			replaceRemoteContent: true,
		});
		expect(pullMock).toHaveBeenCalledWith(expect.anything(), {
			overwriteLocalChanges: true,
			full: false,
		});
		expect(store.lastPullResult).toEqual({ result: 'no-remote-branch' });
	});

	it('clears the busy flag when a request fails', async () => {
		pullMock.mockRejectedValue(new Error('network'));
		const store = useGitSyncStore();

		await expect(store.pull()).rejects.toThrow('network');

		expect(store.pulling).toBe(false);
		expect(store.isBusy).toBe(false);
	});
});
