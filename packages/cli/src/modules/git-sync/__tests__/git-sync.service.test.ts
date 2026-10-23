import type { GitSyncSettingsDto } from '@n8n/api-types';
import { LockAcquisitionTimeoutError, type LockService, type Logger } from '@n8n/backend-common';
import type { EventService } from '@n8n/backend-services';
import type { ProjectRepository, User } from '@n8n/db';
import { mock } from 'vitest-mock-extended';
import type { InstanceSettings } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { GitSyncSettingsService } from '../git-sync-settings.service';
import type { GitSyncConfig } from '../git-sync.config';
import { GitSyncError } from '../git-sync.errors';
import { GitSyncService } from '../git-sync.service';
import type { StoredConnection } from '../git-sync.types';
import type { N8nPackagesAdapter } from '../package/n8n-packages.adapter';

const stored: StoredConnection = {
	version: 1,
	repositoryUrl: 'https://github.com/acme/flows.git',
	branch: 'main',
	directory: 'n8n',
	projectId: 'project-1',
	username: 'x-access-token',
	encryptedToken: 'encrypted:old',
	authorName: 'n8n Git sync',
	authorEmail: 'bot@example.com',
	credentialMatchingMode: 'name-and-type',
};

const form = (overrides: Partial<GitSyncSettingsDto> = {}) =>
	({
		repositoryUrl: stored.repositoryUrl,
		branch: stored.branch,
		directory: stored.directory,
		username: stored.username,
		authorName: stored.authorName,
		authorEmail: stored.authorEmail,
		credentialMatchingMode: stored.credentialMatchingMode,
		...overrides,
	}) as GitSyncSettingsDto;

const user = mock<User>({ id: 'user-1' });
const logger = mock<Logger>();
const settingsService = mock<GitSyncSettingsService>();
const lockService = mock<LockService>();
const projectRepository = mock<ProjectRepository>();
const eventService = mock<EventService>();

let baseDir: string;
let service: GitSyncService;

beforeEach(() => {
	vi.clearAllMocks();
	logger.scoped.mockReturnValue(logger);
	baseDir = mkdtempSync(path.join(tmpdir(), 'git-sync-service-'));
	const config = mock<GitSyncConfig>({
		dir: baseDir,
		allowedProtocols: ['https'],
		allowedHosts: [],
		timeoutSeconds: 5,
	});
	service = new GitSyncService(
		logger,
		config,
		mock<InstanceSettings>(),
		settingsService,
		mock<N8nPackagesAdapter>(),
		lockService,
		projectRepository,
		eventService,
	);

	lockService.withLease.mockImplementation(
		async (_namespace, _key, run) => await run(new AbortController().signal),
	);
	projectRepository.existsBy.mockResolvedValue(true);
	projectRepository.findOneBy.mockResolvedValue(null);
	settingsService.getConnection.mockResolvedValue(stored);
	settingsService.getDecryptedConnection.mockResolvedValue({
		repositoryUrl: stored.repositoryUrl,
		branch: stored.branch,
		directory: stored.directory,
		projectId: stored.projectId,
		username: stored.username,
		authorName: stored.authorName,
		authorEmail: stored.authorEmail,
		credentialMatchingMode: stored.credentialMatchingMode,
		token: 'old',
	});
	settingsService.encryptToken.mockImplementation(async (token) => `encrypted:${token}`);
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

const savedConnection = () => settingsService.saveConnection.mock.calls[0][0];

describe('GitSyncService.saveSettings', () => {
	it('sends an audit event without the token', async () => {
		await service.saveSettings(user, form({ accessToken: 'new-token' }));

		expect(eventService.emit).toHaveBeenCalledWith('git-sync-settings-saved', {
			user,
			projectId: stored.projectId,
			repositoryUrl: stored.repositoryUrl,
			branch: stored.branch,
			directory: stored.directory,
			isNew: false,
			tokenChanged: true,
		});
		expect(JSON.stringify(eventService.emit.mock.calls)).not.toContain('new-token');
	});

	it('keeps the stored token when the form sends the blanking value or nothing', async () => {
		await service.saveSettings(user, form({ accessToken: CREDENTIAL_BLANKING_VALUE }));
		expect(savedConnection().encryptedToken).toBe('encrypted:old');

		vi.clearAllMocks();
		await service.saveSettings(user, form());
		expect(savedConnection().encryptedToken).toBe('encrypted:old');
	});

	it('encrypts a new token and removes the token for an empty value', async () => {
		await service.saveSettings(user, form({ accessToken: ' new-token ' }));
		expect(savedConnection().encryptedToken).toBe('encrypted:new-token');

		vi.clearAllMocks();
		await service.saveSettings(user, form({ accessToken: '' }));
		expect(savedConnection().encryptedToken).toBeNull();
	});

	it('does not send the stored token to another server', async () => {
		const otherServer = form({ repositoryUrl: 'https://git.example.com/acme/flows.git' });

		await expect(service.saveSettings(user, otherServer)).rejects.toThrow(
			'Enter the access token again',
		);
		await expect(service.testConnection(user, otherServer)).rejects.toThrow(
			'Enter the access token again',
		);

		await service.saveSettings(user, { ...otherServer, accessToken: 'token-for-new-server' });
		expect(savedConnection().encryptedToken).toBe('encrypted:token-for-new-server');
	});

	it('starts again with a clean state when the branch changes', async () => {
		const repoDir = path.join(baseDir, 'repo');
		mkdirSync(repoDir);

		await service.saveSettings(user, form({ branch: 'prod' }));

		expect(settingsService.deleteState).toHaveBeenCalled();
		expect(existsSync(repoDir)).toBe(false);
	});

	it('keeps the state when only the author changes', async () => {
		const repoDir = path.join(baseDir, 'repo');
		mkdirSync(repoDir);

		await service.saveSettings(user, form({ authorName: 'Release bot' }));

		expect(settingsService.deleteState).not.toHaveBeenCalled();
		expect(existsSync(repoDir)).toBe(true);
	});

	it('uses the personal project of the user for a new connection', async () => {
		settingsService.getConnection.mockResolvedValueOnce(null);
		projectRepository.getPersonalProjectForUserOrFail.mockResolvedValue(mock({ id: 'personal-1' }));

		await service.saveSettings(user, form());

		expect(projectRepository.getPersonalProjectForUserOrFail).toHaveBeenCalledWith('user-1');
		expect(savedConnection().projectId).toBe('personal-1');
	});

	it('refuses a project that does not exist', async () => {
		projectRepository.existsBy.mockResolvedValue(false);

		await expect(service.saveSettings(user, form({ projectId: 'missing' }))).rejects.toThrow(
			'The project does not exist.',
		);
	});
});

describe('GitSyncService operations', () => {
	it('reports a busy lock as a conflict', async () => {
		lockService.withLease.mockRejectedValue(new LockAcquisitionTimeoutError('timed out'));

		const error = await service.getStatus(user).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(GitSyncError);
		expect((error as GitSyncError).httpStatusCode).toBe(409);
		expect((error as GitSyncError).meta.code).toBe('GIT_SYNC_BUSY');
	});

	it('asks for the settings first', async () => {
		settingsService.getDecryptedConnection.mockResolvedValue(null);

		const error = await service.pull(user, false, false).catch((caught: unknown) => caught);

		expect((error as GitSyncError).meta.code).toBe('GIT_SYNC_NOT_CONFIGURED');
	});
});
