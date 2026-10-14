import { Logger } from '@n8n/backend-common';
import { resolveProxyUrl } from '@n8n/backend-network/proxy';
import { Service } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PromotionCredentials } from './promotion-providers.service';
import { GIT_OPERATION_FAILED } from './promotions.constants';

const execFileAsync = promisify(execFile);

/** Git runs with this `PATH` only, as in source control. The Docker image has Git and ssh there. */
const GIT_PATH = '/usr/bin:/bin';

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Variables that name a private certificate authority for Git over HTTPS. */
const CA_VARIABLES = ['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH'];

const USERNAME_VARIABLE = 'N8N_PROMOTIONS_GIT_USERNAME';
const PASSWORD_VARIABLE = 'N8N_PROMOTIONS_GIT_PASSWORD';

/** A credential helper that gives Git the HTTPS credentials from the environment. */
const CREDENTIAL_HELPER = `!f() { echo "username=\${${USERNAME_VARIABLE}}"; echo "password=\${${PASSWORD_VARIABLE}}"; }; f`;

/** The settings of every Git call. Promotions use only the SSH and HTTPS transports of Git. */
const BASE_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'protocol.ext.allow=never'];

/** What a Git call needs to reach the remote of a configuration. */
export interface PromotionRemoteAccess {
	remoteUrl: string;
	credentials: PromotionCredentials;
	/** The known hosts of the configuration, for SSH. */
	knownHostsFile: string;
}

/** Runs one Git command. The arguments come after the settings of the call. */
export type PromotionGitCommand = (cwd: string, args: string[]) => Promise<string>;

/**
 * Fork code (not in upstream n8n): runs Git for Git connections. Git gets a fixed environment:
 * `PATH=/usr/bin:/bin` and no prompts. Over HTTPS, a credential helper gives the username and the
 * password of the provider, and the proxy of the environment applies. Over SSH, the private key is
 * in a temporary folder during the call, and `ssh` accepts a new host key and keeps it in the
 * known hosts of the configuration. A failure is a `BadRequestError` with a fixed message, and the
 * log has the message of Git.
 */
@Service()
export class PromotionGitRunner {
	constructor(private readonly logger: Logger) {}

	/** Checks a branch name with `git check-ref-format --branch`. */
	async isValidBranchName(name: string) {
		try {
			await execFileAsync('git', ['check-ref-format', '--branch', name], {
				cwd: tmpdir(),
				env: { PATH: GIT_PATH, GIT_TERMINAL_PROMPT: '0' },
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Runs Git in a checkout, without the remote. */
	async run(cwd: string, args: string[]) {
		return await this.exec(cwd, args, { PATH: GIT_PATH, GIT_TERMINAL_PROMPT: '0' }, []);
	}

	/**
	 * Gives `action` a command that can reach the remote. For SSH, the temporary private key exists
	 * until `action` ends.
	 */
	async withRemote<T>(
		access: PromotionRemoteAccess,
		action: (git: PromotionGitCommand) => Promise<T>,
	): Promise<T> {
		const env: NodeJS.ProcessEnv = { PATH: GIT_PATH, GIT_TERMINAL_PROMPT: '0' };
		const config: string[] = [];
		const { credentials } = access;
		if (credentials.authType === 'token') {
			env[USERNAME_VARIABLE] = credentials.username;
			env[PASSWORD_VARIABLE] = credentials.password;
			for (const name of CA_VARIABLES) {
				if (process.env[name]) env[name] = process.env[name];
			}
			config.push('-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`);
			const proxy = resolveProxyUrl(access.remoteUrl);
			if (proxy) config.push('-c', `http.proxy=${proxy}`);
			return await action(async (cwd, args) => await this.exec(cwd, args, env, config));
		}

		await mkdir(path.dirname(access.knownHostsFile), { recursive: true });
		const keyFolder = await mkdtemp(path.join(tmpdir(), 'n8n-promotions-'));
		try {
			const privateKey = path.join(keyFolder, 'private-key');
			await writeFile(privateKey, credentials.privateKey, { mode: 0o600 });
			await chmod(privateKey, 0o600);
			env.GIT_SSH_COMMAND =
				'ssh -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 ' +
				`-o UserKnownHostsFile='${access.knownHostsFile}' -o StrictHostKeyChecking=accept-new ` +
				`-i '${privateKey}'`;
			return await action(async (cwd, args) => await this.exec(cwd, args, env, config));
		} finally {
			await rm(keyFolder, { recursive: true, force: true });
		}
	}

	private async exec(cwd: string, args: string[], env: NodeJS.ProcessEnv, config: string[]) {
		try {
			const { stdout } = await execFileAsync('git', [...BASE_CONFIG, ...config, ...args], {
				cwd,
				env,
				maxBuffer: MAX_OUTPUT_BYTES,
			});
			return stdout;
		} catch (error) {
			const stderr =
				typeof error === 'object' && error !== null && 'stderr' in error
					? String(error.stderr)
					: '';
			this.logger.warn('A Git call of a promotion failed', {
				command: args[0],
				error: stderr || (error instanceof Error ? error.message : String(error)),
			});
			throw new BadRequestError(GIT_OPERATION_FAILED);
		}
	}
}
