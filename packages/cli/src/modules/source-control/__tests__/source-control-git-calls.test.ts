import type { InstanceSettings } from 'n8n-core';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';

import { SOURCE_CONTROL_ORIGIN } from '../constants';
import { SourceControlGitService } from '../source-control-git.service';
import { SourceControlPreferencesService } from '../source-control-preferences.service';
import { SourceControlService } from '../source-control.service';
import type { SourceControlPreferences } from '../types/source-control-preferences';

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const REPOSITORY_URL = 'https://git.example.com/acme/flows.git';

describe('source control', () => {
	describe('the preferences', () => {
		const service = new SourceControlPreferencesService(
			mock<InstanceSettings>({ n8nFolder: '/tmp/n8n' }),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
		);

		it('accepts a repository URL', () => {
			expect(service.parseSourceControlPreferences({ repositoryUrl: REPOSITORY_URL })).toEqual({
				repositoryUrl: REPOSITORY_URL,
			});
		});

		it('refuses a repository URL that starts with `-`', () => {
			expect(() =>
				service.parseSourceControlPreferences({ repositoryUrl: '--upload-pack=x' }),
			).toThrow('Invalid source control preferences');
		});
	});

	describe('the Git calls', () => {
		let folder: string;

		beforeEach(async () => {
			folder = await mkdtemp(path.join(tmpdir(), 'source-control-'));
			await mkdir(path.join(folder, '.git'));
			execFileMock.mockReset();
			execFileMock.mockImplementation((...args: unknown[]) => {
				const callback = args[args.length - 1] as ExecFileCallback;
				callback(null, { stdout: '', stderr: '' });
			});
		});

		afterEach(async () => {
			await rm(folder, { recursive: true, force: true });
		});

		it('gives Git the URL after `--`, without the `ext` transport', async () => {
			const preferencesService = mock<SourceControlPreferencesService>({ gitFolder: folder });
			preferencesService.getPreferences.mockReturnValue({
				connectionType: 'https',
				repositoryUrl: REPOSITORY_URL,
			});
			preferencesService.getDecryptedHttpsCredentials.mockResolvedValue({
				username: 'user',
				password: 'token',
			});
			const gitService = new SourceControlGitService(mock(), preferencesService);

			await gitService.refreshRepositorySettings();

			expect(execFileMock).toHaveBeenCalledTimes(1);
			const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
			expect(file).toBe('git');
			expect(args.slice(0, 2)).toEqual(['-c', 'protocol.ext.allow=never']);
			expect(args.slice(-5)).toEqual([
				'remote',
				'set-url',
				'--',
				SOURCE_CONTROL_ORIGIN,
				REPOSITORY_URL,
			]);
		});
	});

	describe('the work folder', () => {
		const setup = () => {
			const preferencesService = mock<SourceControlPreferencesService>();
			preferencesService.getPreferences.mockReturnValue(
				mock<SourceControlPreferences>({ connectionType: 'ssh' }),
			);
			const gitService = mock<SourceControlGitService>();
			const service = new SourceControlService(
				mock(),
				mock(),
				mock(),
				preferencesService,
				gitService,
				mock(),
				mock(),
				mock(),
				mock(),
			);
			return { gitService, service };
		};

		it('runs one operation at a time', async () => {
			const { gitService, service } = setup();
			const order: string[] = [];
			let finishBranches: (() => void) | undefined;
			gitService.getBranches.mockImplementation(async () => {
				order.push('branches: start');
				await new Promise<void>((resolve) => {
					finishBranches = resolve;
				});
				order.push('branches: end');
				return { branches: ['main'], currentBranch: 'main' };
			});
			gitService.pull.mockImplementation(async () => {
				order.push('reset');
			});

			const branches = service.getBranches();
			const reset = service.resetWorkfolder();
			await vi.waitFor(() => expect(order).toEqual(['branches: start']));
			finishBranches?.();
			await Promise.all([branches, reset]);

			expect(order).toEqual(['branches: start', 'branches: end', 'reset']);
		});

		it('runs the next operation after an operation fails', async () => {
			const { gitService, service } = setup();
			gitService.getBranches.mockRejectedValue(new Error('The remote is gone'));

			const branches = service.getBranches();
			const reset = service.resetWorkfolder();

			await expect(branches).rejects.toThrow('The remote is gone');
			await expect(reset).resolves.toBeUndefined();
			expect(gitService.pull).toHaveBeenCalledTimes(1);
		});
	});
});
