import { execFile, type ExecFileException } from 'node:child_process';
import { devNull } from 'node:os';
import path from 'node:path';

import { GIT_CA_VARIABLES, GIT_MAX_OUTPUT_BYTES } from '@/utils/git-process';

import { GIT_SYNC_ERROR_CODES } from '../git-sync.constants';
import { GitSyncError } from '../git-sync.errors';

/** Settings that turn off Git features that could run code or read outside the repository. */
const HARDENED_CONFIG = [
	`core.hooksPath=${devNull}`,
	'safe.bareRepository=explicit',
	'credential.helper=',
	'core.fsmonitor=false',
	'core.pager=cat',
	'core.symlinks=false',
	'core.autocrlf=false',
	'submodule.recurse=false',
	'fetch.recurseSubmodules=false',
	'commit.gpgSign=false',
	'tag.gpgSign=false',
	'advice.detachedHead=false',
	'init.templateDir=',
	// A redirect would send the next requests, with the token header, to the other host.
	'http.followRedirects=false',
	'gc.auto=0',
	'maintenance.auto=false',
];

/** Variables that Git may need to reach the remote through a proxy or a private CA. */
const PASSTHROUGH_ENV = [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	...GIT_CA_VARIABLES,
];

export interface GitIdentity {
	name: string;
	email: string;
}

export interface GitCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface GitClientOptions {
	/** Working copy. Commands run here unless they give their own `cwd`. */
	repoDir: string;
	/** Empty home folder, so Git reads no user configuration. */
	homeDir: string;
	timeoutMs: number;
	allowedProtocols: readonly string[];
	/** HTTPS credentials. Git gets them as a request header for the repository origin only. */
	auth?: { url: URL; username: string; token: string };
}

export interface TreeEntry {
	path: string;
	blobSha: string;
}

export interface NameStatusEntry {
	status: string;
	path: string;
}

/** Runs Git with a fixed, minimal environment. Never runs a shell. */
export class GitClient {
	constructor(private readonly options: GitClientOptions) {}

	private authHeaderValue(): string | undefined {
		const { auth } = this.options;
		if (!auth) return undefined;
		const basic = Buffer.from(`${auth.username}:${auth.token}`).toString('base64');
		return `Authorization: Basic ${basic}`;
	}

	/** Builds the process environment. It does not inherit the n8n environment. */
	buildEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			HOME: this.options.homeDir,
			LC_ALL: 'C',
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: devNull,
			GIT_ALLOW_PROTOCOL: this.options.allowedProtocols.join(':'),
			// Stop the repository search at the Git sync folder, so Git never uses a repository above it.
			GIT_CEILING_DIRECTORIES: path.dirname(this.options.repoDir),
		};

		for (const name of PASSTHROUGH_ENV) {
			if (process.env[name]) env[name] = process.env[name];
		}

		const header = this.authHeaderValue();
		if (header && this.options.auth) {
			// Scope the header to the repository origin, so a redirect to another host gets no token.
			env.GIT_CONFIG_COUNT = '1';
			env.GIT_CONFIG_KEY_0 = `http.${this.options.auth.url.origin}/.extraHeader`;
			env.GIT_CONFIG_VALUE_0 = header;
		}

		return env;
	}

	/** Removes the token and other credentials from Git output. */
	redact(text: string): string {
		let result = text;
		const { auth } = this.options;
		const header = this.authHeaderValue();
		for (const secret of [auth?.token, header?.slice('Authorization: Basic '.length)]) {
			if (secret) result = result.split(secret).join('***');
		}
		return result
			.replace(/Authorization:[^\r\n]*/gi, 'Authorization: ***')
			.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');
	}

	async run(
		args: string[],
		options: {
			cwd?: string;
			allowedExitCodes?: number[];
			env?: NodeJS.ProcessEnv;
			/** Text for the standard input. Git gets an empty input when this is not set. */
			input?: string;
		} = {},
	): Promise<GitCommandResult> {
		const fullArgs = [...HARDENED_CONFIG.flatMap((setting) => ['-c', setting]), ...args];

		return await new Promise((resolve, reject) => {
			const child = execFile(
				'git',
				fullArgs,
				{
					cwd: options.cwd ?? this.options.repoDir,
					env: { ...this.buildEnv(), ...options.env },
					timeout: this.options.timeoutMs,
					maxBuffer: GIT_MAX_OUTPUT_BYTES,
					encoding: 'utf8',
					windowsHide: true,
				},
				(error: ExecFileException | null, stdout: string, stderr: string) => {
					if (!error) {
						resolve({ stdout, stderr, exitCode: 0 });
						return;
					}

					const exitCode = typeof error.code === 'number' ? error.code : -1;
					if (options.allowedExitCodes?.includes(exitCode)) {
						resolve({ stdout, stderr, exitCode });
						return;
					}

					reject(this.toError(args[0] ?? 'git', error, stderr));
				},
			);
			child.stdin?.on('error', () => {
				// The process can exit before it reads the input. The exit callback reports the result.
			});
			child.stdin?.end(options.input ?? '');
		});
	}

	private toError(command: string, error: ExecFileException, stderr: string): GitSyncError {
		const detail = this.redact((stderr || error.message).trim());

		if (error.code === 'ENOENT') {
			return new GitSyncError(
				'Git is not installed on this n8n instance.',
				503,
				GIT_SYNC_ERROR_CODES.gitMissing,
			);
		}
		if (error.killed) {
			return new GitSyncError(
				`The Git command "${command}" took too long and was stopped.`,
				504,
				GIT_SYNC_ERROR_CODES.remoteUnreachable,
				{ detail },
			);
		}
		if (/mismatched algorithms|object.format/i.test(detail)) {
			return new GitSyncError(
				'The repository uses the SHA-256 object format. Git sync supports SHA-1 repositories only.',
				400,
				GIT_SYNC_ERROR_CODES.unsupportedRepository,
				{ detail },
			);
		}
		if (
			/authentication failed|could not read username|terminal prompts disabled|invalid username or password|returned error: 40[13]|permission denied|access denied/i.test(
				detail,
			)
		) {
			return new GitSyncError(
				'The Git server refused the credentials. Check the user name and the access token.',
				400,
				GIT_SYNC_ERROR_CODES.authFailed,
				{ detail },
			);
		}
		if (
			/could not resolve host|failed to connect|connection refused|connection timed out|not found|does not appear to be a git repository|unable to access|no such file or directory/i.test(
				detail,
			)
		) {
			return new GitSyncError(
				'Could not reach the repository. Check the URL and the network access of the n8n instance.',
				400,
				GIT_SYNC_ERROR_CODES.remoteUnreachable,
				{ detail },
			);
		}

		return new GitSyncError(
			`Git command "${command}" failed.`,
			500,
			GIT_SYNC_ERROR_CODES.gitFailed,
			{
				detail,
			},
		);
	}

	// ── Read operations ────────────────────────────────────────────────────

	async version(): Promise<[number, number]> {
		const { stdout } = await this.run(['--version'], { cwd: this.options.homeDir });
		const match = /(\d+)\.(\d+)/.exec(stdout);
		if (!match) return [0, 0];
		return [Number(match[1]), Number(match[2])];
	}

	/** Returns the commit of a branch on the remote, or null when the branch does not exist. */
	async remoteBranchHead(url: string, branch: string): Promise<string | null> {
		const { stdout } = await this.run(['ls-remote', '--heads', url, `refs/heads/${branch}`], {
			cwd: this.options.homeDir,
		});
		const line = stdout.split('\n').find((row) => row.endsWith(`\trefs/heads/${branch}`));
		return line ? line.split('\t')[0] : null;
	}

	/** Returns the default branch of the remote, or null when the remote has none (empty repository). */
	async remoteDefaultBranch(url: string): Promise<string | null> {
		const { stdout } = await this.run(['ls-remote', '--symref', url, 'HEAD'], {
			cwd: this.options.homeDir,
		});
		const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout);
		return match ? match[1] : null;
	}

	async isRepository(): Promise<boolean> {
		const result = await this.run(['rev-parse', '--git-dir'], { allowedExitCodes: [128] });
		return result.exitCode === 0 && result.stdout.trim() === '.git';
	}

	/** Returns the commit of the remote-tracking branch, or null when it does not exist. */
	async trackingHead(branch: string): Promise<string | null> {
		const result = await this.run(
			['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`],
			{ allowedExitCodes: [1] },
		);
		return result.exitCode === 0 ? result.stdout.trim() : null;
	}

	async headCommit(): Promise<string> {
		const { stdout } = await this.run(['rev-parse', 'HEAD']);
		return stdout.trim();
	}

	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		const result = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], {
			allowedExitCodes: [1, 128],
		});
		return result.exitCode === 0;
	}

	/** Lists the files of a commit under `directory`, with their blob hashes. */
	async listTree(commit: string, directory: string): Promise<TreeEntry[]> {
		const args = ['ls-tree', '-r', '-z', '--full-tree', commit];
		if (directory) args.push('--', directory);
		const { stdout } = await this.run(args);
		return stdout
			.split('\0')
			.filter(Boolean)
			.flatMap((row) => {
				// Format: <mode> SP <type> SP <object> TAB <path>
				const tab = row.indexOf('\t');
				const [, type, blobSha] = row.slice(0, tab).split(' ');
				return type === 'blob' ? [{ path: row.slice(tab + 1), blobSha }] : [];
			});
	}

	/** Lists the files that changed between two commits under `directory`. */
	async diffNames(from: string, to: string, directory: string): Promise<NameStatusEntry[]> {
		const args = ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--no-renames'];
		args.push(from, to);
		if (directory) args.push('--', directory);
		const { stdout } = await this.run(args);
		return parseNameStatus(stdout);
	}

	async stagedChanges(): Promise<NameStatusEntry[]> {
		const { stdout } = await this.run([
			'diff',
			'--cached',
			'--no-ext-diff',
			'--no-textconv',
			'--name-status',
			'-z',
			'--no-renames',
		]);
		return parseNameStatus(stdout);
	}

	/** Reads one text file of a commit. Returns null when the commit has no such file. */
	async readTextFile(commit: string, filePath: string): Promise<string | null> {
		const result = await this.run(['cat-file', 'blob', `${commit}:${filePath}`], {
			allowedExitCodes: [128],
		});
		return result.exitCode === 0 ? result.stdout : null;
	}

	// ── Write operations (working copy only, except `push`) ─────────────────

	/** Creates the working copy, or points its `origin` to `url`. */
	async ensureRepository(url: string): Promise<void> {
		if (!(await this.isRepository())) {
			await this.run(['init', '--quiet']);
		}
		const remote = await this.run(['remote', 'get-url', 'origin'], { allowedExitCodes: [2, 128] });
		if (remote.exitCode !== 0) {
			await this.run(['remote', 'add', 'origin', url]);
		} else if (remote.stdout.trim() !== url) {
			await this.run(['remote', 'set-url', 'origin', url]);
		}
	}

	/** Fetches one branch. Returns its commit, or null when the remote has no such branch. */
	async fetchBranch(url: string, branch: string): Promise<string | null> {
		const head = await this.remoteBranchHead(url, branch);
		if (!head) return null;
		await this.run([
			'fetch',
			'--quiet',
			'--no-tags',
			'--prune',
			'--no-recurse-submodules',
			'origin',
			`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
		]);
		return await this.trackingHead(branch);
	}

	/** Sets the working copy to exactly `commit`, or to an empty branch when `commit` is null. */
	async resetTo(branch: string, commit: string | null): Promise<void> {
		if (commit) {
			await this.run(['checkout', '--quiet', '--force', '-B', branch, commit]);
		} else {
			// Start the branch with no history, so an old local branch cannot reach the remote.
			await this.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
			await this.run(['update-ref', '-d', `refs/heads/${branch}`]);
			await this.run(['read-tree', '--empty']);
		}
		await this.run(['clean', '-ffdx', '--quiet']);
	}

	async stageAll(directory: string): Promise<void> {
		await this.run(['add', '--all', '--', directory || '.']);
	}

	/** Commits the staged changes. Identities go through the environment, so Git does not parse them. */
	async commit(options: {
		message: string;
		author: GitIdentity;
		committer: GitIdentity;
	}): Promise<string> {
		await this.run(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--file=-'], {
			env: {
				GIT_AUTHOR_NAME: options.author.name,
				GIT_AUTHOR_EMAIL: options.author.email,
				GIT_COMMITTER_NAME: options.committer.name,
				GIT_COMMITTER_EMAIL: options.committer.email,
			},
			input: options.message,
		});
		return await this.headCommit();
	}

	/** Pushes HEAD to the branch without force. When the remote rejects the push, returns its reason. */
	async push(branch: string): Promise<{ pushed: true } | { pushed: false; detail: string }> {
		const result = await this.run(
			['push', '--porcelain', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`],
			{ allowedExitCodes: [1] },
		);
		if (result.exitCode === 0) return { pushed: true };
		return { pushed: false, detail: this.redact(`${result.stdout}\n${result.stderr}`.trim()) };
	}
}

function parseNameStatus(stdout: string): NameStatusEntry[] {
	const parts = stdout.split('\0').filter(Boolean);
	const entries: NameStatusEntry[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		entries.push({ status: parts[i], path: parts[i + 1] });
	}
	return entries;
}
