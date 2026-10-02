import type { Logger } from '@n8n/backend-common';
import type { Settings, SettingsRepository } from '@n8n/db';
import { mock } from 'vitest-mock-extended';
import type { Cipher } from 'n8n-core';

import {
	GitSyncSettingsService,
	connectionFingerprint,
	emptyState,
} from '../git-sync-settings.service';
import type { StoredConnection, StoredState } from '../git-sync.types';

const connection: StoredConnection = {
	version: 1,
	repositoryUrl: 'https://github.com/acme/flows.git',
	branch: 'main',
	directory: 'n8n',
	projectId: 'project-1',
	username: 'x-access-token',
	encryptedToken: 'encrypted:token',
	authorName: 'n8n Git sync',
	authorEmail: 'bot@example.com',
	credentialMatchingMode: 'name-and-type',
};

const settingsRepository = mock<SettingsRepository>();
const cipher = mock<Cipher>();
const logger = mock<Logger>();
logger.scoped.mockReturnValue(logger);

const service = new GitSyncSettingsService(settingsRepository, cipher, logger);

const row = (value: string) => mock<Settings>({ value });

beforeEach(() => {
	vi.clearAllMocks();
	logger.scoped.mockReturnValue(logger);
});

describe('connectionFingerprint', () => {
	it('changes when the content source changes, not when the author changes', () => {
		const fingerprint = connectionFingerprint(connection);
		const otherAuthor: StoredConnection = { ...connection, authorName: 'Someone else' };

		expect(connectionFingerprint(otherAuthor)).toBe(fingerprint);
		expect(connectionFingerprint({ ...connection, branch: 'prod' })).not.toBe(fingerprint);
		expect(connectionFingerprint({ ...connection, directory: 'flows' })).not.toBe(fingerprint);
		expect(connectionFingerprint({ ...connection, projectId: 'project-2' })).not.toBe(fingerprint);
		expect(
			connectionFingerprint({ ...connection, repositoryUrl: 'https://github.com/acme/other.git' }),
		).not.toBe(fingerprint);
	});
});

describe('GitSyncSettingsService', () => {
	it('decrypts the token only for the Git client', async () => {
		settingsRepository.findByKey.mockResolvedValue(row(JSON.stringify(connection)));
		cipher.decryptV2.mockResolvedValue('plain-token');

		const decrypted = await service.getDecryptedConnection();

		expect(cipher.decryptV2).toHaveBeenCalledWith('encrypted:token');
		expect(decrypted).toMatchObject({ token: 'plain-token', branch: 'main' });
		expect(decrypted).not.toHaveProperty('encryptedToken');
	});

	it('stores the connection without loading it at startup', async () => {
		await service.saveConnection(connection);

		expect(settingsRepository.upsertByKey).toHaveBeenCalledWith(
			'features.gitSync.connection',
			JSON.stringify(connection),
			false,
			{},
		);
	});

	it('ignores a row that is not valid', async () => {
		settingsRepository.findByKey.mockResolvedValue(row('{"version":2}'));

		await expect(service.getConnection()).resolves.toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});

	it('returns an empty state when the stored state belongs to another connection', async () => {
		const state: StoredState = {
			...emptyState('old-fingerprint'),
			lastSyncedCommit: 'abc',
			baseline: { wf1: { workflow: 'w1' } },
		};
		settingsRepository.findByKey.mockResolvedValue(row(JSON.stringify(state)));

		await expect(service.getState('old-fingerprint')).resolves.toEqual(state);
		await expect(service.getState('new-fingerprint')).resolves.toEqual(
			emptyState('new-fingerprint'),
		);
	});
});
