import { Logger } from '@n8n/backend-common';
import { resolveProxyUrl } from '@n8n/backend-network/proxy';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { UserError } from 'n8n-workflow';

import {
	SOURCE_CONTROL_DEFAULT_BRANCH,
	SOURCE_CONTROL_DEFAULT_EMAIL,
	SOURCE_CONTROL_DEFAULT_NAME,
	SOURCE_CONTROL_ORIGIN,
	SOURCE_CONTROL_README,
	SOURCE_CONTROL_README_CONTENT,
} from './constants';
import { SourceControlPreferencesService } from './source-control-preferences.service';

const execFileAsync = promisify(execFile);

/** Git runs with this `PATH` only, as in the original. The Docker image has Git and ssh there. */
const GIT_PATH = '/usr/bin:/bin';

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Variables that name a private certificate authority for Git over HTTPS. */
const CA_VARIABLES = ['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH'];

const USERNAME_VARIABLE = 'N8N_SOURCE_CONTROL_GIT_USERNAME';
const PASSWORD_VARIABLE = 'N8N_SOURCE_CONTROL_GIT_PASSWORD';

/** A credential helper that gives Git the HTTPS credentials from the environment. */
const CREDENTIAL_HELPER = `!f() { echo "username=\${${USERNAME_VARIABLE}}"; echo "password=\${${PASSWORD_VARIABLE}}"; }; f`;

export interface GitCommitResult {
	hash: string;
	message: string;
	branch: string;
}

interface GitCall {
	env: NodeJS.ProcessEnv;
	config: string[];
}

/**
 * Fork code (not in upstream n8n): runs Git in the work folder of source control. Git gets a
 * fixed environment: `PATH=/usr/bin:/bin`, no prompts, and for SSH a `GIT_SSH_COMMAND` with the
 * key pair of the preferences. Over HTTPS, a credential helper gives the stored user name and
 * password, and the proxy of the environment applies. An error is the message of Git.
 */
@Service()
export class SourceControlGitService {
	constructor(
		private readonly logger: Logger,
		private readonly preferencesService: SourceControlPreferencesService,
	) {
		this.logger = logger.scoped('source-control');
	}

	get folder() {
		return this.preferencesService.gitFolder;
	}

	isRepository() {
		return existsSync(path.join(this.folder, '.git'));
	}

	/** Runs `ssh -V`, as the original does before each set-up. A missing program is no error here. */
	async checkSshBinary() {
		try {
			await execFileAsync('ssh', ['-V'], { env: process.env });
			return true;
		} catch (error) {
			this.logger.debug('No ssh program found', { error });
			return false;
		}
	}

	/** Checks that Git is installed, with the `PATH` of n8n. */
	async checkGitBinary() {
		try {
			await execFileAsync('git', ['--version'], { env: process.env });
			return true;
		} catch {
			return false;
		}
	}

	// #region Set-up

	/**
	 * Makes the work folder a clone of the repository, and returns the branch. An empty
	 * repository gets a first commit with a README on the default branch. The user of the work
	 * folder is the user who connects.
	 */
	async initRepository(user?: User): Promise<string> {
		const call = await this.prepareCall();
		await mkdir(this.folder, { recursive: true });
		if (!this.isRepository()) await this.run(call, ['init']);
		const url = String(this.preferencesService.getPreferences().repositoryUrl);
		const remotes = (await this.run(call, ['remote'])).split('\n').filter(Boolean);
		// `--` ends the options of Git before the URL.
		if (remotes.includes(SOURCE_CONTROL_ORIGIN)) {
			await this.run(call, ['remote', 'set-url', '--', SOURCE_CONTROL_ORIGIN, url]);
		} else {
			await this.run(call, ['remote', 'add', '--', SOURCE_CONTROL_ORIGIN, url]);
		}
		await this.setUserConfig(call, user);
		await this.run(call, ['fetch', SOURCE_CONTROL_ORIGIN]);
		const defaultBranch = await this.getRemoteDefaultBranch(call);
		const branches = await this.getRemoteBranches(call);

		let branch = defaultBranch ?? branches[0];
		if (!branch) {
			branch = this.preferencesService.getBranchName() || SOURCE_CONTROL_DEFAULT_BRANCH;
			await this.run(call, ['checkout', '-b', branch]);
			await writeFile(path.join(this.folder, SOURCE_CONTROL_README), SOURCE_CONTROL_README_CONTENT);
			await this.run(call, ['add', SOURCE_CONTROL_README]);
			await this.run(call, ['commit', '-m', 'Initial commit']);
			await this.run(call, ['push', '-u', SOURCE_CONTROL_ORIGIN, branch]);
		} else {
			await this.checkoutTracking(call, branch);
		}
		await this.run(call, ['pull']);
		await this.run(call, ['fetch', SOURCE_CONTROL_ORIGIN]);
		return branch;
	}

	/** Sets the remote URL and the user of the work folder, when it is a repository. */
	async refreshRepositorySettings(user?: User) {
		if (!this.isRepository()) return;
		const call = await this.prepareCall();
		const url = String(this.preferencesService.getPreferences().repositoryUrl);
		await this.run(call, ['remote', 'set-url', '--', SOURCE_CONTROL_ORIGIN, url]);
		if (user) await this.setUserConfig(call, user);
	}

	async deleteRepository() {
		await rm(this.folder, { recursive: true, force: true });
	}

	// #endregion

	// #region Branches

	/** The branches of the remote, and the branch of the work folder. */
	async getBranches(): Promise<{ branches: string[]; currentBranch: string }> {
		const call = await this.prepareCall();
		if (!this.isRepository()) return { branches: [], currentBranch: '' };
		await this.run(call, ['fetch', SOURCE_CONTROL_ORIGIN]);
		return {
			branches: await this.getRemoteBranches(call),
			currentBranch: await this.getCurrentBranch(call),
		};
	}

	/** Checks out `branch` of the remote. A branch that the remote does not have is an error. */
	async setBranch(branch: string) {
		const call = await this.prepareCall();
		await this.run(call, ['fetch', SOURCE_CONTROL_ORIGIN]);
		await this.run(call, ['rev-parse', '--verify', `${SOURCE_CONTROL_ORIGIN}/${branch}`]);
		await this.checkoutTracking(call, branch);
	}

	async getCurrentBranchName() {
		if (!this.isRepository()) return '';
		return await this.getCurrentBranch(await this.prepareCall());
	}

	// #endregion

	// #region Sync

	async fetch() {
		await this.run(await this.prepareCall(), ['fetch', SOURCE_CONTROL_ORIGIN]);
	}

	/** Fetches and moves the branch of the work folder to the branch of the remote. */
	async pull() {
		const call = await this.prepareCall();
		const branch = this.preferencesService.getBranchName();
		await this.run(call, ['fetch', SOURCE_CONTROL_ORIGIN]);
		await this.run(call, ['reset', '--hard', `${SOURCE_CONTROL_ORIGIN}/${branch}`]);
	}

	/** Moves the work folder to the branch of the remote without a fetch. */
	async resetToRemote() {
		const call = await this.prepareCall();
		const branch = this.preferencesService.getBranchName();
		await this.run(call, ['reset', '--hard', `${SOURCE_CONTROL_ORIGIN}/${branch}`]);
		await this.run(call, ['clean', '-fd']);
	}

	/** Stages all changes of the work folder and commits them as `user`. No change, no commit. */
	async commit(message: string, user: User): Promise<string | undefined> {
		const call = await this.prepareCall();
		await this.run(call, ['add', '--all']);
		const staged = await this.run(call, ['diff', '--cached', '--name-only']);
		if (!staged.trim()) return undefined;
		const name = this.userName(user);
		await this.run(call, [
			'-c',
			`user.name=${name}`,
			'-c',
			`user.email=${user.email ?? SOURCE_CONTROL_DEFAULT_EMAIL}`,
			'commit',
			'-m',
			message,
		]);
		return (await this.run(call, ['rev-parse', '--short', 'HEAD'])).trim();
	}

	async push(force: boolean): Promise<string> {
		const call = await this.prepareCall();
		const branch = this.preferencesService.getBranchName();
		const args = ['push', SOURCE_CONTROL_ORIGIN, `HEAD:refs/heads/${branch}`];
		if (force) args.push('--force');
		await this.run(call, args);
		return `refs/heads/${branch}`;
	}

	/** The content of a file of the work folder at `HEAD`. */
	async getFileContent(filePath: string): Promise<string> {
		const call = await this.prepareCall();
		try {
			return await this.run(call, ['show', `HEAD:${filePath}`]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new UserError(`Could not get content for file: ${filePath}: ${message}`);
		}
	}

	// #endregion

	private async setUserConfig(call: GitCall, user?: User) {
		await this.run(call, ['config', 'user.email', user?.email ?? SOURCE_CONTROL_DEFAULT_EMAIL]);
		await this.run(call, ['config', 'user.name', this.userName(user)]);
	}

	private userName(user?: User) {
		const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ');
		return name || SOURCE_CONTROL_DEFAULT_NAME;
	}

	private async checkoutTracking(call: GitCall, branch: string) {
		const local = (await this.run(call, ['branch', '--list', branch])).trim();
		if (local) {
			await this.run(call, ['checkout', branch]);
			await this.run(call, ['reset', '--hard', `${SOURCE_CONTROL_ORIGIN}/${branch}`]);
		} else {
			await this.run(call, [
				'checkout',
				'-b',
				branch,
				'--track',
				`${SOURCE_CONTROL_ORIGIN}/${branch}`,
			]);
		}
	}

	private async getCurrentBranch(call: GitCall) {
		try {
			return (await this.run(call, ['branch', '--show-current'])).trim();
		} catch {
			return '';
		}
	}

	private async getRemoteBranches(call: GitCall) {
		const output = await this.run(call, ['branch', '-r', '--format=%(refname:lstrip=3)']);
		return output
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && line !== 'HEAD')
			.sort();
	}

	/** The branch that `HEAD` of the remote points to, when the remote has one. */
	private async getRemoteDefaultBranch(call: GitCall) {
		const output = await this.run(call, ['ls-remote', '--symref', SOURCE_CONTROL_ORIGIN, 'HEAD']);
		const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output);
		return match?.[1];
	}

	/**
	 * The environment and the configuration of one Git call. Over HTTPS, a missing user name or
	 * password is an error, also before the work folder exists.
	 */
	private async prepareCall(): Promise<GitCall> {
		const preferences = this.preferencesService.getPreferences();
		const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', PATH: GIT_PATH };
		// Source control uses only the SSH and HTTPS transports of Git.
		const config: string[] = ['-c', 'protocol.ext.allow=never'];
		if (preferences.connectionType === 'https') {
			const { username, password } = await this.preferencesService.getDecryptedHttpsCredentials();
			env[USERNAME_VARIABLE] = username;
			env[PASSWORD_VARIABLE] = password;
			for (const name of CA_VARIABLES) {
				if (process.env[name]) env[name] = process.env[name];
			}
			config.push('-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`);
			const proxy = resolveProxyUrl(preferences.repositoryUrl);
			if (proxy) config.push('-c', `http.proxy=${proxy}`);
		} else {
			await this.preferencesService.ensureSshFolder();
			const privateKey = await this.preferencesService.getPrivateKeyPath();
			const knownHosts = this.preferencesService.knownHostsFile;
			env.GIT_SSH_COMMAND =
				'ssh -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 ' +
				`-o UserKnownHostsFile='${knownHosts}' -o StrictHostKeyChecking=accept-new -i '${privateKey}'`;
		}
		return { env, config };
	}

	private async run(call: GitCall, args: string[]): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', [...call.config, ...args], {
				cwd: this.folder,
				env: call.env,
				maxBuffer: MAX_OUTPUT_BYTES,
			});
			return stdout;
		} catch (error) {
			const stderr =
				typeof error === 'object' && error !== null && 'stderr' in error
					? String(error.stderr)
					: '';
			const message = stderr || (error instanceof Error ? error.message : String(error));
			this.logger.debug('Git failed', { args: args[0], message });
			throw new UserError(message);
		}
	}
}
