import { createComponentRenderer } from '@n8n/frontend-test-utils';
import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/vue';

import type { GitSyncSettings, GitSyncStatus } from './git-sync.api';
import { CREDENTIALS_BLANKING_VALUE } from './git-sync.constants';
import SettingsGitSyncView from './SettingsGitSyncView.vue';

const showMessage = vi.fn();
const showError = vi.fn();
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage, showError }),
}));

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext: { baseUrl: '', pushRef: '' } }),
}));

type ApiMock = (...args: unknown[]) => Promise<unknown>;
const getSettingsMock = vi.fn<ApiMock>();
const saveSettingsMock = vi.fn<ApiMock>();
const deleteSettingsMock = vi.fn<ApiMock>();
const testConnectionMock = vi.fn<ApiMock>();
const getProjectsMock = vi.fn<ApiMock>();
const getStatusMock = vi.fn<ApiMock>();
const pushMock = vi.fn<ApiMock>();
const pullMock = vi.fn<ApiMock>();
vi.mock('./git-sync.api', () => ({
	getGitSyncSettings: async (...args: unknown[]) => await getSettingsMock(...args),
	saveGitSyncSettings: async (...args: unknown[]) => await saveSettingsMock(...args),
	deleteGitSyncSettings: async (...args: unknown[]) => await deleteSettingsMock(...args),
	testGitSyncConnection: async (...args: unknown[]) => await testConnectionMock(...args),
	getGitSyncProjects: async (...args: unknown[]) => await getProjectsMock(...args),
	getGitSyncStatus: async (...args: unknown[]) => await getStatusMock(...args),
	pushToGit: async (...args: unknown[]) => await pushMock(...args),
	pullFromGit: async (...args: unknown[]) => await pullMock(...args),
}));

const saved: GitSyncSettings = {
	repositoryUrl: 'https://github.com/acme/flows.git',
	branch: 'main',
	directory: 'n8n',
	projectId: 'project-1',
	projectName: 'Ada Lovelace',
	username: 'x-access-token',
	accessToken: CREDENTIALS_BLANKING_VALUE,
	authorName: 'n8n Git sync',
	authorEmail: 'bot@example.com',
	credentialMatchingMode: 'name-and-type',
};

const status = (overrides: Partial<GitSyncStatus> = {}): GitSyncStatus => ({
	branch: 'main',
	remoteHead: '0123456789abcdef',
	lastSyncedCommit: '0123456789abcdef',
	remoteChanged: false,
	outgoing: [],
	incoming: [],
	conflicts: [],
	lastPush: null,
	lastPull: null,
	...overrides,
});

const render = () =>
	createComponentRenderer(SettingsGitSyncView, {
		pinia: createTestingPinia({ stubActions: false }),
	})();

beforeEach(() => {
	vi.clearAllMocks();
	getProjectsMock.mockResolvedValue([{ id: 'project-1', name: 'Ada Lovelace', type: 'personal' }]);
	getStatusMock.mockResolvedValue(status());
});

describe('SettingsGitSyncView', () => {
	it('saves a new connection and then shows the status', async () => {
		getSettingsMock.mockResolvedValue(null);
		saveSettingsMock.mockResolvedValue(saved);
		getStatusMock.mockResolvedValue(
			status({
				remoteHead: null,
				lastSyncedCommit: null,
				outgoing: [{ id: 'wf1', name: 'Daily report', change: 'created' }],
			}),
		);
		render();

		const url = await screen.findByTestId('git-sync-repository-url');
		expect(screen.queryByTestId('git-sync-push')).not.toBeInTheDocument();
		await userEvent.type(url, saved.repositoryUrl);
		await userEvent.type(screen.getByTestId('git-sync-author-email'), 'bot@example.com');
		await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(saveSettingsMock).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					repositoryUrl: saved.repositoryUrl,
					authorEmail: 'bot@example.com',
				}),
			),
		);
		expect(showMessage).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Git sync settings saved' }),
		);
		expect(await screen.findByText('Daily report')).toBeInTheDocument();
		expect(screen.getByTestId('git-sync-no-remote-branch')).toBeInTheDocument();
	});

	it('shows the changes on both sides', async () => {
		getSettingsMock.mockResolvedValue(saved);
		getStatusMock.mockResolvedValue(
			status({
				remoteChanged: true,
				outgoing: [{ id: 'wf1', name: 'Local edit', change: 'modified' }],
				incoming: [{ id: 'wf2', name: 'From Git', change: 'created' }],
				conflicts: [],
			}),
		);
		render();

		expect(await screen.findByText('Local edit')).toBeInTheDocument();
		expect(screen.getByText('From Git')).toBeInTheDocument();
		expect(screen.getByTestId('git-sync-remote-changed')).toBeInTheDocument();
		expect(screen.getByText('No workflow changed in both places.')).toBeInTheDocument();
	});

	it('keeps the stored token until the user replaces or removes it', async () => {
		getSettingsMock.mockResolvedValue(saved);
		render();

		const token = await screen.findByTestId('git-sync-access-token');
		const input = token.querySelector('input') ?? token;
		expect(input).toHaveValue('');
		expect(input).toHaveAttribute(
			'placeholder',
			'A token is stored. Enter a new token to replace it.',
		);

		await userEvent.click(screen.getByTestId('git-sync-remove-token'));

		expect(await screen.findByText('n8n removes the stored token when you save.')).toBeVisible();
	});

	it('pushes with a commit message', async () => {
		getSettingsMock.mockResolvedValue(saved);
		pushMock.mockResolvedValue({ result: 'pushed', commit: 'abc1234', changedFiles: 3 });
		render();

		await userEvent.type(await screen.findByTestId('git-sync-commit-message'), 'Add reports');
		await userEvent.click(screen.getByTestId('git-sync-push'));

		await waitFor(() =>
			expect(pushMock).toHaveBeenCalledWith(expect.anything(), {
				message: 'Add reports',
				replaceRemoteContent: false,
			}),
		);
		expect(showMessage).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Pushed 3 changed files', type: 'success' }),
		);
	});

	it('tells the user to pull first', async () => {
		getSettingsMock.mockResolvedValue(saved);
		const error = Object.assign(new Error('The branch has changes'), {
			meta: { code: 'GIT_SYNC_PULL_FIRST' },
		});
		pushMock.mockRejectedValue(error);
		render();

		await userEvent.type(await screen.findByTestId('git-sync-commit-message'), 'Add reports');
		await userEvent.click(screen.getByTestId('git-sync-push'));

		await waitFor(() =>
			expect(showError).toHaveBeenCalledWith(error, 'Pull the changes from Git first'),
		);
	});

	it('asks before a pull replaces local changes', async () => {
		getSettingsMock.mockResolvedValue(saved);
		pullMock
			.mockRejectedValueOnce(
				Object.assign(new Error('Some workflows changed'), {
					meta: {
						code: 'GIT_SYNC_LOCAL_CHANGES',
						conflicts: [{ id: 'wf1', name: 'Daily report', change: 'modified' }],
					},
				}),
			)
			.mockResolvedValueOnce({
				result: 'pulled',
				commit: 'abc1234',
				created: [],
				updated: ['Daily report'],
				skipped: [],
				stubbedCredentials: ['Basic auth'],
				publishingBlocked: [],
				removedUpstream: [],
			});
		render();

		await userEvent.click(await screen.findByTestId('git-sync-pull'));

		expect(await screen.findByText('Replace your changes?')).toBeInTheDocument();
		expect(screen.getByTestId('git-sync-conflict-list')).toHaveTextContent('Daily report');

		await userEvent.click(screen.getByRole('button', { name: 'Replace my changes' }));

		await waitFor(() =>
			expect(pullMock).toHaveBeenLastCalledWith(expect.anything(), {
				overwriteLocalChanges: true,
				full: false,
			}),
		);
		expect(
			await screen.findByText('Fill in these new empty credentials: Basic auth'),
		).toBeVisible();
	});

	it('disconnects after a confirmation', async () => {
		getSettingsMock.mockResolvedValue(saved);
		deleteSettingsMock.mockResolvedValue(undefined);
		render();

		await userEvent.click(await screen.findByTestId('git-sync-disconnect'));
		const dialog = await screen.findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

		await waitFor(() => expect(deleteSettingsMock).toHaveBeenCalled());
		expect(screen.queryByTestId('git-sync-push')).not.toBeInTheDocument();
	});
});
