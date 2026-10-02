import type { ExecFileException } from 'node:child_process';
import { devNull } from 'node:os';

import { GitSyncError } from '../git-sync.errors';
import { GitClient, type GitClientOptions } from '../git/git-client';

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

interface RecordedCall {
	args: string[];
	options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number };
	input: string | undefined;
}

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const TOKEN = 'ghp_secretTokenValue123';

const calls: RecordedCall[] = [];

/** Makes the next Git commands finish with these results, in order. */
function respondWith(
	...results: Array<{ stdout?: string; stderr?: string; error?: Partial<ExecFileException> }>
) {
	const queue = [...results];
	execFileMock.mockImplementation(
		(
			_file: string,
			args: string[],
			options: RecordedCall['options'],
			callback: ExecFileCallback,
		) => {
			const call: RecordedCall = { args, options, input: undefined };
			calls.push(call);
			const result = queue.shift() ?? {};
			process.nextTick(() => {
				const error = result.error
					? Object.assign(new Error(result.error.message ?? 'git failed'), result.error)
					: null;
				callback(error, result.stdout ?? '', result.stderr ?? '');
			});
			return {
				stdin: {
					on: vi.fn(),
					end: (input: string) => {
						call.input = input;
					},
				},
			};
		},
	);
}

const options = (overrides: Partial<GitClientOptions> = {}): GitClientOptions => ({
	repoDir: '/data/git-sync/repo',
	homeDir: '/data/git-sync/home',
	timeoutMs: 5_000,
	allowedProtocols: ['https'],
	auth: {
		url: new URL('https://github.com/acme/flows.git'),
		username: 'x-access-token',
		token: TOKEN,
	},
	...overrides,
});

const basicCredentials = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

beforeEach(() => {
	calls.length = 0;
	execFileMock.mockReset();
});

describe('GitClient environment', () => {
	it('builds a minimal environment that does not inherit the n8n environment', () => {
		process.env.N8N_ENCRYPTION_KEY = 'do-not-pass';
		try {
			const env = new GitClient(options()).buildEnv();

			expect(env).toMatchObject({
				HOME: '/data/git-sync/home',
				LC_ALL: 'C',
				GIT_TERMINAL_PROMPT: '0',
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: devNull,
				GIT_ALLOW_PROTOCOL: 'https',
				GIT_CEILING_DIRECTORIES: '/data/git-sync',
			});
			expect(env.N8N_ENCRYPTION_KEY).toBeUndefined();
		} finally {
			delete process.env.N8N_ENCRYPTION_KEY;
		}
	});

	it('sends the token as a header for the repository origin only', () => {
		const env = new GitClient(options()).buildEnv();

		expect(env.GIT_CONFIG_COUNT).toBe('1');
		expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
		expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basicCredentials}`);
	});

	it('sets no header without credentials', () => {
		const env = new GitClient(options({ auth: undefined })).buildEnv();

		expect(env.GIT_CONFIG_COUNT).toBeUndefined();
		expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
	});
});

describe('GitClient.run', () => {
	it('adds the hardened settings and never puts the token in the arguments', async () => {
		respondWith({ stdout: 'abc\trefs/heads/main\n' });
		const client = new GitClient(options());

		await client.remoteBranchHead('https://github.com/acme/flows.git', 'main');

		const [call] = calls;
		expect(call.args).toEqual(
			expect.arrayContaining([
				'-c',
				`core.hooksPath=${devNull}`,
				'credential.helper=',
				'http.followRedirects=false',
				'core.symlinks=false',
				'ls-remote',
			]),
		);
		expect(call.args.join(' ')).not.toContain(TOKEN);
		expect(call.args.join(' ')).not.toContain(basicCredentials);
		expect(call.options.cwd).toBe('/data/git-sync/home');
		expect(call.options.timeout).toBe(5_000);
	});

	it('sends the commit message on the standard input and the identities in the environment', async () => {
		respondWith({}, { stdout: 'c0ffee\n' });
		const client = new GitClient(options());

		const commit = await client.commit({
			message: 'Update workflows',
			author: { name: 'Ada Lovelace', email: 'ada@example.com' },
			committer: { name: 'n8n Git sync', email: 'bot@example.com' },
		});

		expect(commit).toBe('c0ffee');
		expect(calls[0].args).toEqual(expect.arrayContaining(['commit', '--file=-']));
		expect(calls[0].input).toBe('Update workflows');
		expect(calls[0].options.env).toMatchObject({
			GIT_AUTHOR_NAME: 'Ada Lovelace',
			GIT_AUTHOR_EMAIL: 'ada@example.com',
			GIT_COMMITTER_NAME: 'n8n Git sync',
			GIT_COMMITTER_EMAIL: 'bot@example.com',
		});
	});

	it('reports a rejected push with a redacted reason', async () => {
		respondWith({
			error: { code: 1 },
			stdout: `To https://x-access-token:${TOKEN}@github.com/acme/flows.git\n!\tHEAD:refs/heads/main\t[rejected] (fetch first)`,
		});
		const client = new GitClient(options());

		const result = await client.push('main');

		expect(result.pushed).toBe(false);
		expect(result.pushed ? '' : result.detail).toContain('[rejected]');
		expect(result.pushed ? '' : result.detail).not.toContain(TOKEN);
		expect(calls[0].args).not.toContain('--force');
	});

	it.each([
		[{ code: 'ENOENT' }, '', 503, 'GIT_SYNC_GIT_MISSING'],
		[{ killed: true, signal: 'SIGTERM' as const }, '', 504, 'GIT_SYNC_REMOTE_UNREACHABLE'],
		[
			{ code: 128 },
			'fatal: Authentication failed for https://github.com/acme/flows.git',
			400,
			'GIT_SYNC_AUTH_FAILED',
		],
		[
			{ code: 128 },
			'fatal: unable to access: Could not resolve host: github.com',
			400,
			'GIT_SYNC_REMOTE_UNREACHABLE',
		],
		[
			{ code: 128 },
			'fatal: mismatched algorithms: client sha1; server sha256',
			400,
			'GIT_SYNC_UNSUPPORTED_REPOSITORY',
		],
		[{ code: 128 }, 'fatal: something else', 500, 'GIT_SYNC_GIT_FAILED'],
	])('maps a failure to a Git sync error (%j)', async (error, stderr, status, code) => {
		respondWith({ error, stderr });
		const client = new GitClient(options());

		const failure = await client.headCommit().catch((caught: unknown) => caught);

		expect(failure).toBeInstanceOf(GitSyncError);
		expect((failure as GitSyncError).httpStatusCode).toBe(status);
		expect((failure as GitSyncError).meta.code).toBe(code);
	});
});

describe('GitClient.redact', () => {
	it('removes the token, the encoded credentials and URL credentials', () => {
		const client = new GitClient(options());

		const text = [
			`token ${TOKEN}`,
			`header ${basicCredentials}`,
			'Authorization: Basic abc',
			'remote https://someone:hunter2@example.com/repo.git',
		].join('\n');

		const redacted = client.redact(text);

		expect(redacted).not.toContain(TOKEN);
		expect(redacted).not.toContain(basicCredentials);
		expect(redacted).not.toContain('hunter2');
		expect(redacted).toContain('Authorization: ***');
		expect(redacted).toContain('https://***@example.com/repo.git');
	});
});

describe('GitClient parsers', () => {
	it('lists the blobs of a tree with their hashes', async () => {
		respondWith({
			stdout: [
				'100644 blob 1111111111111111111111111111111111111111\tn8n/manifest.json',
				'100644 blob 2222222222222222222222222222222222222222\tn8n/workflows/a-1/workflow.json',
				'160000 commit 3333333333333333333333333333333333333333\tn8n/vendor',
				'',
			].join('\0'),
		});
		const client = new GitClient(options());

		await expect(client.listTree('HEAD', 'n8n')).resolves.toEqual([
			{ path: 'n8n/manifest.json', blobSha: '1111111111111111111111111111111111111111' },
			{
				path: 'n8n/workflows/a-1/workflow.json',
				blobSha: '2222222222222222222222222222222222222222',
			},
		]);
	});

	it('reads name-status output', async () => {
		respondWith({ stdout: ['M', 'n8n/a.json', 'D', 'n8n/b.json', ''].join('\0') });
		const client = new GitClient(options());

		await expect(client.diffNames('a', 'b', 'n8n')).resolves.toEqual([
			{ status: 'M', path: 'n8n/a.json' },
			{ status: 'D', path: 'n8n/b.json' },
		]);
	});
});
