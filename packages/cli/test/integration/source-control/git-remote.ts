import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Fork test helper (not in upstream n8n): a local Git remote for the golden tests of source
 * control. A fake `ssh` program on the PATH logs how it is called and runs the Git command of the
 * remote side on a local bare repository, so `ssh://git@remote.test/<owner>/<repo>.git` and
 * `git@remote.test:<owner>/<repo>.git` work without an SSH server.
 */
export class LocalGitRemote {
	/** `SC_REMOTE_ROOT` lets the runner put the fake ssh on the PATH before n8n starts. */
	readonly root = process.env.SC_REMOTE_ROOT ?? mkdtempSync(path.join(tmpdir(), 'n8n-sc-remote-'));

	readonly binDir = path.join(this.root, 'bin');

	readonly repos = path.join(this.root, 'repos');

	readonly sshLog = path.join(this.root, 'ssh.log');

	private savedPath = process.env.PATH ?? '';

	install() {
		mkdirSync(this.binDir, { recursive: true });
		mkdirSync(this.repos, { recursive: true });
		const script = `#!/bin/bash
# Fake ssh of the source control golden tests.
printf '%s\\n' "$*" >> '${this.sshLog}'
if [ "$1" = "-V" ]; then echo 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024' >&2; exit 0; fi
if [ "$1" = "-G" ]; then exit 0; fi
cmd="\${@: -1}"
prog="\${cmd%% *}"
target="\${cmd#* }"
target="\${target//\\'/}"
target="\${target#/}"
exec "$prog" '${this.repos}/'"$target"
`;
		const ssh = path.join(this.binDir, 'ssh');
		writeFileSync(ssh, script);
		chmodSync(ssh, 0o755);
		process.env.PATH = `${this.binDir}:${this.savedPath}`;
	}

	uninstall() {
		process.env.PATH = this.savedPath;
		if (!process.env.SC_REMOTE_ROOT) rmSync(this.root, { recursive: true, force: true });
	}

	/** Makes an empty bare repository `<owner>/<name>.git` with `main` as its default branch. */
	createRepo(owner: string, name: string) {
		const dir = path.join(this.repos, owner, `${name}.git`);
		mkdirSync(dir, { recursive: true });
		execFileSync('git', ['init', '--bare', '--initial-branch=main', dir], { stdio: 'ignore' });
		return dir;
	}

	/** Adds a commit with `files` to `branch` (made from the default branch when missing), as another instance. */
	seed(
		owner: string,
		name: string,
		branch: string,
		files: Record<string, string | null>,
		message: string,
	) {
		const dir = path.join(this.repos, owner, `${name}.git`);
		const work = mkdtempSync(path.join(tmpdir(), 'n8n-sc-seed-'));
		try {
			this.git(work, 'clone', '--quiet', dir, '.');
			const exists =
				execFileSync('git', ['ls-remote', '--heads', 'origin', branch], {
					cwd: work,
					encoding: 'utf-8',
				}).trim().length > 0;
			if (exists) this.git(work, 'checkout', '--quiet', branch);
			else this.git(work, 'checkout', '--quiet', '-b', branch);
			for (const [file, content] of Object.entries(files)) {
				const target = path.join(work, file);
				if (content === null) {
					rmSync(target, { force: true });
				} else {
					mkdirSync(path.dirname(target), { recursive: true });
					writeFileSync(target, content);
				}
			}
			this.git(work, 'add', '--all');
			this.git(work, 'commit', '--quiet', '-m', message);
			this.git(work, 'push', '--quiet', 'origin', `HEAD:${branch}`);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	/** The SSH calls since the last read, without the paths of the test machine. */
	takeSshCalls() {
		let text = '';
		try {
			text = readFileSync(this.sshLog, 'utf-8');
		} catch {
			return [];
		}
		writeFileSync(this.sshLog, '');
		return text
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) =>
				line
					.split(this.root)
					.join('<remote>')
					.replace(/\/tmp\/[^\s']+/g, '<tmp>'),
			);
	}

	/** Runs Git in a clone of the remote, for example to change the remote as another instance. */
	git(cwd: string, ...args: string[]) {
		return execFileSync('git', args, {
			cwd,
			encoding: 'utf-8',
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_AUTHOR_NAME: 'Remote User',
				GIT_AUTHOR_EMAIL: 'remote@example.com',
				GIT_COMMITTER_NAME: 'Remote User',
				GIT_COMMITTER_EMAIL: 'remote@example.com',
			},
		});
	}

	/** The files of a branch, with their content, by path. */
	readBranch(owner: string, name: string, branch: string) {
		const dir = path.join(this.repos, owner, `${name}.git`);
		const files: Record<string, string> = {};
		let list = '';
		try {
			list = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
				cwd: dir,
				encoding: 'utf-8',
			});
		} catch {
			return null;
		}
		for (const file of list.split('\n').filter(Boolean)) {
			files[file] = execFileSync('git', ['show', `${branch}:${file}`], {
				cwd: dir,
				encoding: 'utf-8',
			});
		}
		return files;
	}

	/** The commits of a branch: subject, author and committer, newest first. */
	log(owner: string, name: string, branch: string) {
		const dir = path.join(this.repos, owner, `${name}.git`);
		try {
			return execFileSync('git', ['log', '--format=%s|%an <%ae>|%cn <%ce>', branch], {
				cwd: dir,
				encoding: 'utf-8',
			})
				.split('\n')
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	branches(owner: string, name: string) {
		const dir = path.join(this.repos, owner, `${name}.git`);
		return execFileSync('git', ['branch', '--format=%(refname:short)'], {
			cwd: dir,
			encoding: 'utf-8',
		})
			.split('\n')
			.filter(Boolean)
			.sort();
	}
}
