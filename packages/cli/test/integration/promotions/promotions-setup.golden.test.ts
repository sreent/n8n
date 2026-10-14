// Fork test (not in upstream n8n): a golden test of the set-up of Git connections (promotions)
// through the public API: the providers, the connections, the configurations, the project links
// and the local checkouts, with a local Git server over HTTPS and a fake `ssh`. It records the
// status and the body of each answer, the rows of the promotion tables, the local checkouts, the
// Git requests and the ssh calls of each step. The snapshot was recorded against the original
// module, and the fork module gives the same snapshot. See
// `packages/cli/src/modules/promotions/README.md`.
import { createTeamProject, getPersonalProject, mockInstance } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstanceSettings } from 'n8n-core';
import { deepCopy } from 'n8n-workflow';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import {
	createAdminWithApiKey,
	createMemberWithApiKey,
	createOwnerWithApiKey,
} from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import { LocalGitHttpServer } from '../source-control/git-http-server';
import { LocalGitRemote } from '../source-control/git-remote';

// Git must reach the local server directly. The cloud session sets proxy variables.
for (const name of Object.keys(process.env)) {
	if (/proxy/i.test(name)) delete process.env[name];
}

mockInstance(ActiveWorkflowManager);

const remote = new LocalGitRemote();
remote.install();
const server = new LocalGitHttpServer(remote.repos);

const testServer = utils.setupTestServer({
	endpointGroups: ['publicApi'],
	enabledFeatures: ['feat:gitConnections', 'feat:sharing'],
	quotas: { 'quota:maxTeamProjects': -1 },
	modules: ['promotions'],
});

const rec = new GoldenRecorder();

type Who = 'owner' | 'admin' | 'member';
const users = {} as Record<Who, User>;
const agents = {} as Record<Who, SuperAgentTest>;

let transcript: unknown[] = [];

/** Public keys get a number in the order in which they come, so that a snapshot shows a new key. */
const keyLabels = new Map<string, string>();
function keyLabel(key: string) {
	let label = keyLabels.get(key);
	if (!label) {
		label = `<key ${keyLabels.size + 1}, ${key.length} characters>`;
		keyLabels.set(key, label);
	}
	return label;
}

/** Masks the parts of a text that change from run to run: ports, paths, keys and hashes. */
function mask(text: string): string {
	return text
		.split(remote.root)
		.join('<remote>')
		.split(Container.get(InstanceSettings).n8nFolder)
		.join('<n8n>')
		.replace(/\/tmp\/[^\s'"]+/g, '<tmp>')
		.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
		.replace(
			/(ssh-(?:ed25519|rsa)) ([A-Za-z0-9+/=]+)/g,
			(_match, type: string, key: string) => `${type} ${keyLabel(key)}`,
		)
		.replace(/\b[0-9a-f]{40}\b/g, '<sha>')
		.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----\n?/g, '<private key>');
}

function maskDeep(value: unknown): unknown {
	if (typeof value === 'string') return mask(value);
	if (Array.isArray(value)) return value.map(maskDeep);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskDeep(entry)]));
	}
	return value;
}

function normalize(value: unknown): unknown {
	return rec.normalize(maskDeep(deepCopy(value as object)));
}

/** Gives each new id of the promotion tables a label: its table and its name or direction. */
async function labelNewIds() {
	const manager = Container.get(ProjectRepository).manager;
	const tables: Array<[string, string]> = [
		['promotion_provider', 'name'],
		['promotion_connection', 'name'],
		['promotion_config', 'direction'],
	];
	for (const [table, column] of tables) {
		const rows = await manager.query<Array<Record<string, string>>>(`SELECT * FROM "${table}"`);
		for (const row of rows) {
			if (rec.labels.has(row.id)) continue;
			const owner =
				table === 'promotion_config' ? ` of ${rec.labels.get(row.connectionId) ?? '?'}` : '';
			rec.label(row.id, `${table.replace('promotion_', '')} ${row[column]}${owner}`);
		}
	}
}

/** The rows of the promotion tables, with the encrypted credentials masked. */
async function promotionRows() {
	const manager = Container.get(ProjectRepository).manager;
	const result: Record<string, string[]> = {};
	for (const table of [
		'promotion_provider',
		'promotion_connection',
		'promotion_connection_project',
		'promotion_config',
	]) {
		const rows = await manager.query<Array<Record<string, unknown>>>(`SELECT * FROM "${table}"`);
		result[table] = rows
			.map((row) => {
				const copy: Record<string, unknown> = { ...row };
				if (typeof copy.auth === 'string') {
					const auth = copy.auth;
					copy.auth = `<${auth.length > 0 ? 'set' : 'empty'}${
						/PRIVATE KEY|secret|git-token|password/i.test(auth) ? ', PLAIN TEXT' : ''
					}>`;
				}
				for (const key of ['config', 'target', 'settings']) {
					if (typeof copy[key] === 'string') {
						try {
							copy[key] = JSON.parse(copy[key] as string);
						} catch {}
					}
				}
				return JSON.stringify(normalize(copy));
			})
			.sort();
	}
	return result;
}

/** The Git work folders below the n8n folder: their branch, their last commit and their remote. */
function checkouts() {
	const root = Container.get(InstanceSettings).n8nFolder;
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 4 || !existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			if (entry === '.git') {
				found.push(dir);
				continue;
			}
			if (entry === 'node_modules') continue;
			walk(full, depth + 1);
		}
	};
	walk(root, 0);
	const result = found.map((dir) => {
		const run = (...args: string[]) => {
			try {
				return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
			} catch (error) {
				return `<error: ${(error as Error).message.split('\n')[0]}>`;
			}
		};
		const files = run('ls-files').split('\n').filter(Boolean);
		return normalize({
			dir: rec.labelString(mask(dir)),
			branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
			head: run('log', '-1', '--format=%s'),
			remotes: run('remote', '-v'),
			config: run('config', '--local', '--list')
				.split('\n')
				.filter((line) => !line.startsWith('core.')),
			files: files.length > 20 ? `${files.length} files` : files,
			status: run('status', '--porcelain'),
		}) as { dir: string };
	});
	// The folders have the random ids of the configurations: sort them by their labels.
	return result.sort((left, right) => left.dir.localeCompare(right.dir));
}

type Row = { id: string; name: string; createdAt: string };

/** The order of the rows of a list: by id, by creation, by name, or another order. */
function detectOrder(rows: Row[]) {
	// Code unit order, as the database sorts text.
	const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
	const sorted = (key: (row: Row) => string, direction: 1 | -1) =>
		rows.every(
			(row, index) => index === 0 || compare(key(rows[index - 1]), key(row)) * direction <= 0,
		);
	if (rows.length < 2) return 'any';
	if (sorted((row) => row.id, 1)) return 'id asc';
	if (sorted((row) => row.id, -1)) return 'id desc';
	if (sorted((row) => row.createdAt, 1)) return 'createdAt asc';
	if (sorted((row) => row.createdAt, -1)) return 'createdAt desc';
	if (sorted((row) => row.name, 1)) return 'name asc';
	return 'other';
}

/**
 * A list answer with its rows sorted by name: the ids are random, so their order changes from run
 * to run. The record keeps the order that the server used, and whether a page is the right slice
 * of the whole list.
 */
async function describeList(who: Who, url: string, body: { data: Row[]; nextCursor: unknown }) {
	const [pathname, query = ''] = url.split('?');
	const params = new URLSearchParams(query);
	let offset = 0;
	const cursor = params.get('cursor');
	if (cursor) {
		try {
			offset = (JSON.parse(Buffer.from(cursor, 'base64').toString()) as { offset: number }).offset;
		} catch {}
	}
	params.delete('cursor');
	params.set('limit', '250');
	const full = (await agents[who].get(`${pathname}?${params.toString()}`)).body as { data?: Row[] };
	const slice = (full.data ?? []).slice(offset, offset + body.data.length).map((row) => row.id);
	const rows = full.data?.length ?? 0;
	return {
		// The rows of a page depend on the random ids: a page shows only its size.
		data:
			body.data.length < rows
				? `${body.data.length} of ${rows} rows`
				: [...body.data].sort((left, right) => left.name.localeCompare(right.name)),
		nextCursor: body.nextCursor,
		'<order>': detectOrder(full.data ?? []),
		'<page is the slice of the order>': body.data.every((row, index) => row.id === slice[index]),
	};
}

/** The files below `<n8n>/promotions`, without the content of the work folders. */
function promotionFiles() {
	const root = path.join(Container.get(InstanceSettings).n8nFolder, 'promotions');
	const found: string[] = [];
	const walk = (dir: string, relative: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir).sort()) {
			const full = path.join(dir, entry);
			const name = `${relative}/${entry}`;
			if (statSync(full).isDirectory()) {
				found.push(`${name}/`);
				if (entry !== 'repository') walk(full, name);
			} else if (entry === 'cache.json') {
				// The cache of a checkout: what the checkout holds.
				found.push(`${name} ${mask(readFileSync(full, 'utf-8'))}`);
			} else {
				found.push(name);
			}
		}
	};
	walk(root, '<n8n>/promotions');
	return found.map((file) => rec.labelString(file)).sort();
}

/** The temporary folders of private keys that are left after a call. */
function tempKeyFolders() {
	return readdirSync(tmpdir()).filter((entry) => entry.startsWith('n8n-promotions-')).length;
}

let lastFiles: unknown;
let lastRows: unknown;
let lastCheckouts: unknown;

/** One request: the answer, and what changed in the tables, the checkouts, Git and ssh. */
async function step(
	name: string,
	who: Who,
	method: 'get' | 'post' | 'put' | 'delete',
	url: string,
	body?: unknown,
) {
	// Rows that come one after the other get different creation times: lists sort by them.
	await new Promise((resolve) => setTimeout(resolve, 20));
	const agent = agents[who];
	let request = agent[method](url);
	if (body !== undefined) request = request.send(body as object);
	const response = await request;
	await labelNewIds();
	const entry: Record<string, unknown> = {
		step: name,
		request: `${who} ${method.toUpperCase()} ${rec.labelString(url)}`,
		...(body !== undefined ? { body: normalize(body) } : {}),
		status: response.status,
		response: normalize(
			method === 'get' &&
				/^\/promotions\/(providers|connections)(\?|$)/.test(url) &&
				Array.isArray(response.body?.data)
				? await describeList(who, url, response.body)
				: response.body,
		),
	};
	const rows = await promotionRows();
	if (JSON.stringify(rows) !== JSON.stringify(lastRows)) {
		entry.rows = rows;
		lastRows = rows;
	}
	const work = checkouts();
	if (JSON.stringify(work) !== JSON.stringify(lastCheckouts)) {
		entry.checkouts = work;
		lastCheckouts = work;
	}
	const files = promotionFiles();
	if (JSON.stringify(files) !== JSON.stringify(lastFiles)) {
		entry.files = files;
		lastFiles = files;
	}
	const keyFolders = tempKeyFolders();
	if (keyFolders > 0) entry.tempKeyFolders = keyFolders;
	const requests = server.takeRequests();
	if (requests.length) entry.git = requests;
	const ssh = remote.takeSshCalls();
	if (ssh.length) entry.ssh = ssh.map(mask);
	transcript.push(entry);
	return response;
}

const id = (label: string) => {
	for (const [value, name] of rec.labels) if (name === label) return value;
	throw new Error(`No id with the label ${label}`);
};

beforeAll(async () => {
	await server.start();
	process.env.GIT_SSL_CAINFO = server.certFile;
	users.owner = await createOwnerWithApiKey();
	users.admin = await createAdminWithApiKey();
	users.member = await createMemberWithApiKey();
	for (const who of ['owner', 'admin', 'member'] as const) {
		rec.label(users[who].id, who);
		agents[who] = testServer.publicApiAgentFor(users[who]);
	}
	remote.createRepo('acme', 'flows');
	remote.seed('acme', 'flows', 'main', { 'README.md': '# Flows\n' }, 'Initial commit');
	remote.seed('acme', 'flows', 'dev', { 'dev.txt': 'dev\n' }, 'Dev branch');
	server.takeRequests();
	lastRows = await promotionRows();
	lastCheckouts = checkouts();
	lastFiles = promotionFiles();
});

afterAll(async () => {
	await server.stop();
	remote.uninstall();
});

test('the set-up of Git connections', async () => {
	const https = `${server.origin}/acme/flows.git`;
	const credentials = server.credentials;

	// #region Providers
	await step('create a token provider', 'owner', 'post', '/promotions/providers', {
		name: 'Bot user',
		type: 'git',
		auth: { authType: 'token', ...credentials },
	});
	await step('create an SSH provider', 'owner', 'post', '/promotions/providers', {
		name: 'Deploy key',
		type: 'git',
		auth: { authType: 'ssh-key' },
	});
	await step('create an RSA provider', 'admin', 'post', '/promotions/providers', {
		name: 'RSA key',
		type: 'git',
		auth: { authType: 'ssh-key', keyType: 'rsa' },
	});
	await step('create without a name', 'owner', 'post', '/promotions/providers', {
		name: '  ',
		type: 'git',
		auth: { authType: 'ssh-key' },
	});
	await step('create a gitlab provider', 'owner', 'post', '/promotions/providers', {
		name: 'GitLab',
		type: 'gitlab',
		auth: { authType: 'ssh-key' },
	});
	await step('list the providers', 'owner', 'get', '/promotions/providers');
	const page = await step('list one provider', 'owner', 'get', '/promotions/providers?limit=1');
	await step(
		'list the next provider',
		'owner',
		'get',
		`/promotions/providers?limit=1&cursor=${encodeURIComponent(String(page.body.nextCursor))}`,
	);
	await step('list no provider', 'owner', 'get', '/promotions/providers?limit=0');
	await step('list with a bad cursor', 'owner', 'get', '/promotions/providers?cursor=nope');
	await step('list with a bad limit', 'owner', 'get', '/promotions/providers?limit=-1');
	await step(
		'get the SSH provider',
		'owner',
		'get',
		`/promotions/providers/${id('provider Deploy key')}`,
	);
	await step(
		'get the token provider',
		'owner',
		'get',
		`/promotions/providers/${id('provider Bot user')}`,
	);
	await step('get an unknown provider', 'owner', 'get', '/promotions/providers/unknown1');
	await step(
		'rename the SSH provider',
		'owner',
		'put',
		`/promotions/providers/${id('provider Deploy key')}`,
		{
			name: 'Deploy key 2',
		},
	);
	await step(
		'rotate the SSH key',
		'owner',
		'put',
		`/promotions/providers/${id('provider Deploy key')}`,
		{
			auth: { authType: 'ssh-key' },
		},
	);
	await step(
		'change the RSA key to ed25519',
		'owner',
		'put',
		`/promotions/providers/${id('provider RSA key')}`,
		{
			auth: { authType: 'ssh-key', keyType: 'ed25519' },
		},
	);
	await step(
		'change the token',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{
			auth: { authType: 'token', username: 'other', password: 'other-token' },
		},
	);
	await step(
		'give half a token',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{
			auth: { authType: 'token', username: 'only-a-name' },
		},
	);
	await step(
		'change the method',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{
			auth: { authType: 'ssh-key' },
		},
	);
	await step(
		'update nothing',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{},
	);
	await step(
		'update the type',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{
			type: 'git',
		},
	);
	await step(
		'restore the token',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{
			name: 'Bot user',
			auth: { authType: 'token', ...credentials },
		},
	);
	await step(
		'delete the RSA provider',
		'owner',
		'delete',
		`/promotions/providers/${id('provider RSA key')}`,
	);
	await step('delete an unknown provider', 'owner', 'delete', '/promotions/providers/unknown1');
	// #endregion

	// #region Connections and remote URLs
	await step('create the instance connection', 'owner', 'post', '/promotions/connections', {
		name: 'Deployments',
		scope: 'instance',
		providerId: id('provider Bot user'),
		target: { schemaVersion: 1, remoteUrl: https },
	});
	await step('create a second instance connection', 'owner', 'post', '/promotions/connections', {
		name: 'Second',
		scope: 'instance',
		providerId: id('provider Deploy key'),
		target: { schemaVersion: 1, remoteUrl: 'git@remote.test:acme/flows.git' },
	});
	const urls: Array<[string, string]> = [
		['provider Bot user', 'http://example.com/acme/flows.git'],
		['provider Bot user', 'https://example.com/acme/flows'],
		['provider Bot user', ' https://example.com/acme/flows.git '],
		['provider Bot user', 'https://user:pass@example.com/acme/flows.git'],
		['provider Bot user', 'https://user@example.com/acme/flows.git'],
		['provider Bot user', 'git://example.com/acme/flows.git'],
		['provider Bot user', 'file:///tmp/flows.git'],
		['provider Bot user', 'ssh://git@example.com/acme/flows.git'],
		['provider Bot user', 'git@example.com:acme/flows.git'],
		['provider Bot user', 'example.com/acme/flows.git'],
		['provider Bot user', '-uhttps://example.com/acme/flows.git'],
		['provider Bot user', 'https://example.com'],
		['provider Deploy key', 'git@remote.test:acme/flows.git'],
		['provider Deploy key', 'ssh://git@remote.test/acme/flows.git'],
		['provider Deploy key', 'ssh://git@remote.test:2222/acme/flows.git'],
		['provider Deploy key', 'remote.test:acme/flows.git'],
		['provider Deploy key', 'git@remote.test:'],
		['provider Deploy key', 'https://example.com/acme/flows.git'],
		['provider Deploy key', 'ssh://git:secret@remote.test/acme/flows.git'],
		['provider Deploy key', 'ext::ssh -o x remote.test %S acme/flows.git'],
	];
	for (const [provider, remoteUrl] of urls) {
		const response = await step(
			`check the URL ${remoteUrl}`,
			'owner',
			'post',
			'/promotions/connections',
			{
				name: 'URL check',
				scope: 'projects',
				providerId: id(provider),
				target: { schemaVersion: 1, remoteUrl },
			},
		);
		if (response.status === 201) {
			await step(
				'delete the URL check',
				'owner',
				'delete',
				`/promotions/connections/${response.body.id}`,
			);
		}
	}
	await step('create the team connection', 'owner', 'post', '/promotions/connections', {
		name: 'Team connection',
		scope: 'projects',
		providerId: id('provider Deploy key'),
		target: { schemaVersion: 1, remoteUrl: 'git@remote.test:acme/flows.git' },
		configs: { apply: { name: 'From main', settings: { schemaVersion: 1, branchName: 'main' } } },
	});
	await step('create with an unknown provider', 'owner', 'post', '/promotions/connections', {
		name: 'Unknown',
		scope: 'projects',
		providerId: 'unknown1',
		target: { schemaVersion: 1, remoteUrl: https },
	});
	await step('create with a sync config', 'owner', 'post', '/promotions/connections', {
		name: 'Sync',
		scope: 'projects',
		providerId: id('provider Bot user'),
		target: { schemaVersion: 1, remoteUrl: https },
		configs: { sync: {} },
	});
	await step('list the connections', 'owner', 'get', '/promotions/connections');
	await step(
		'list the instance connection',
		'owner',
		'get',
		'/promotions/connections?scope=instance',
	);
	await step(
		'list the connections of the SSH provider',
		'owner',
		'get',
		`/promotions/connections?providerId=${id('provider Deploy key')}`,
	);
	await step('list one connection', 'owner', 'get', '/promotions/connections?limit=1');
	await step('list a bad scope', 'owner', 'get', '/promotions/connections?scope=team');
	await step(
		'get the instance connection',
		'owner',
		'get',
		`/promotions/connections/${id('connection Deployments')}`,
	);
	await step('get an unknown connection', 'owner', 'get', '/promotions/connections/unknown1');
	await step(
		'rename the team connection',
		'owner',
		'put',
		`/promotions/connections/${id('connection Team connection')}`,
		{
			name: 'Team connection 2',
		},
	);
	await step(
		'move the team connection to the token provider',
		'owner',
		'put',
		`/promotions/connections/${id('connection Team connection')}`,
		{
			providerId: id('provider Bot user'),
		},
	);
	await step(
		'change the scope',
		'owner',
		'put',
		`/promotions/connections/${id('connection Team connection')}`,
		{
			scope: 'instance',
		},
	);
	await step(
		'change the target',
		'owner',
		'put',
		`/promotions/connections/${id('connection Team connection')}`,
		{
			name: 'Team connection',
			target: { schemaVersion: 1, remoteUrl: 'ssh://git@remote.test/acme/flows.git' },
		},
	);
	await step(
		'delete the SSH provider in use',
		'owner',
		'delete',
		`/promotions/providers/${id('provider Deploy key')}`,
	);
	// #endregion

	// #region Configurations
	const instance = id('connection Deployments');
	await step(
		'set the apply config',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/apply`,
		{
			settings: { schemaVersion: 1, branchName: 'main' },
		},
	);
	await step(
		'set the promote config',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/promote`,
		{
			name: 'To production',
			settings: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion: false },
		},
	);
	for (const branchName of [
		'bad..name',
		'feature/x',
		'-dash',
		'a b',
		'refs/heads/main',
		'end.lock',
		'HEAD',
		'@',
		'x~1',
	]) {
		await step(
			`set the apply branch ${branchName}`,
			'owner',
			'put',
			`/promotions/connections/${instance}/configs/apply`,
			{
				name: 'Apply',
				settings: { schemaVersion: 1, branchName },
			},
		);
	}
	await step(
		'set the apply config again',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/apply`,
		{
			settings: { schemaVersion: 1, branchName: 'main' },
		},
	);
	await step(
		'set a promote config without the flag',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/promote`,
		{
			settings: { schemaVersion: 1, baseBranchName: 'main' },
		},
	);
	await step(
		'delete the promote config',
		'owner',
		'delete',
		`/promotions/connections/${instance}/configs/promote`,
	);
	await step(
		'delete a sideways config',
		'owner',
		'delete',
		`/promotions/connections/${instance}/configs/sideways`,
	);
	await step(
		'set the promote config again',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/promote`,
		{
			settings: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion: true },
		},
	);
	// #endregion

	// #region Project links
	const teamA = await createTeamProject('Team A', users.owner);
	const teamB = await createTeamProject('Team B', users.owner);
	const personal = await getPersonalProject(users.owner);
	rec.label(teamA.id, 'Team A');
	rec.label(teamB.id, 'Team B');
	rec.label(personal.id, 'personal owner');
	const team = id('connection Team connection');
	await step(
		'link Team A',
		'owner',
		'post',
		`/promotions/connections/${team}/projects/${teamA.id}`,
	);
	await step(
		'link Team A again',
		'owner',
		'post',
		`/promotions/connections/${team}/projects/${teamA.id}`,
	);
	await step(
		'list the linked projects',
		'owner',
		'get',
		`/promotions/connections/${team}/projects`,
	);
	await step(
		'link Team B to the instance connection',
		'owner',
		'post',
		`/promotions/connections/${instance}/projects/${teamB.id}`,
	);
	await step(
		'link the personal project',
		'owner',
		'post',
		`/promotions/connections/${team}/projects/${personal.id}`,
	);
	await step(
		'link an unknown project',
		'owner',
		'post',
		`/promotions/connections/${team}/projects/unknown1`,
	);
	await step(
		'unlink Team A through the instance connection',
		'owner',
		'delete',
		`/promotions/connections/${instance}/projects/${teamA.id}`,
	);
	await step(
		'unlink Team A',
		'owner',
		'delete',
		`/promotions/connections/${team}/projects/${teamA.id}`,
	);
	await step(
		'unlink Team A again',
		'owner',
		'delete',
		`/promotions/connections/${team}/projects/${teamA.id}`,
	);
	await step(
		'link Team B',
		'owner',
		'post',
		`/promotions/connections/${team}/projects/${teamB.id}`,
	);
	// #endregion

	// #region Checkouts
	await step(
		'disconnect before a clone',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/disconnect`,
	);
	await step(
		'clone the apply branch',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/clone`,
	);
	await step(
		'get the connection after the clone',
		'owner',
		'get',
		`/promotions/connections/${instance}`,
	);
	await step(
		'clone the apply branch again',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/clone`,
	);
	await step(
		'clone the promote branch',
		'owner',
		'post',
		`/promotions/connections/${instance}/promote/clone`,
	);
	await step(
		'clone a sideways direction',
		'owner',
		'post',
		`/promotions/connections/${instance}/sideways/clone`,
	);
	await step(
		'move the apply branch to dev',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/apply`,
		{
			settings: { schemaVersion: 1, branchName: 'dev' },
		},
	);
	await step(
		'get the connection after the branch change',
		'owner',
		'get',
		`/promotions/connections/${instance}`,
	);
	await step(
		'clone the dev branch',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/clone`,
	);
	await step(
		'move the apply branch to a missing branch',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/apply`,
		{
			settings: { schemaVersion: 1, branchName: 'missing' },
		},
	);
	await step(
		'clone the missing branch',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/clone`,
	);
	await step(
		'move the apply branch back to main',
		'owner',
		'put',
		`/promotions/connections/${instance}/configs/apply`,
		{
			settings: { schemaVersion: 1, branchName: 'main' },
		},
	);
	await step(
		'give a wrong token',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{
			auth: { authType: 'token', username: credentials.username, password: 'wrong' },
		},
	);
	await step(
		'clone with the wrong token',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/clone`,
	);
	await step(
		'restore the right token',
		'owner',
		'put',
		`/promotions/providers/${id('provider Bot user')}`,
		{
			auth: { authType: 'token', ...credentials },
		},
	);
	await step(
		'clone the main branch',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/clone`,
	);
	await step(
		'point the instance connection at another repository',
		'owner',
		'put',
		`/promotions/connections/${instance}`,
		{
			target: { schemaVersion: 1, remoteUrl: `${server.origin}/acme/other.git` },
		},
	);
	await step(
		'get the connection after the target change',
		'owner',
		'get',
		`/promotions/connections/${instance}`,
	);
	await step(
		'point the instance connection back',
		'owner',
		'put',
		`/promotions/connections/${instance}`,
		{
			target: { schemaVersion: 1, remoteUrl: https },
		},
	);
	await step(
		'clone the team apply branch over SSH',
		'owner',
		'post',
		`/promotions/connections/${team}/apply/clone`,
	);
	await step(
		'move the team connection to the SSH provider',
		'owner',
		'put',
		`/promotions/connections/${team}`,
		{
			providerId: id('provider Deploy key'),
		},
	);
	await step(
		'clone the team apply branch over SSH again',
		'owner',
		'post',
		`/promotions/connections/${team}/apply/clone`,
	);
	await step(
		'disconnect the apply checkout',
		'owner',
		'post',
		`/promotions/connections/${instance}/apply/disconnect`,
	);
	await step(
		'delete the promote config with its checkout',
		'owner',
		'delete',
		`/promotions/connections/${instance}/configs/promote`,
	);
	// #endregion

	// #region Access
	await step('list the connections as admin', 'admin', 'get', '/promotions/connections');
	await step('list the connections as member', 'member', 'get', '/promotions/connections');
	await step('create a provider as member', 'member', 'post', '/promotions/providers', {
		name: 'Member',
		type: 'git',
		auth: { authType: 'ssh-key' },
	});
	testServer.license.disable('feat:gitConnections');
	await step('list the connections without the licence', 'owner', 'get', '/promotions/connections');
	testServer.license.enable('feat:gitConnections');
	// #endregion

	// #region Deletion
	await step('delete the team connection', 'owner', 'delete', `/promotions/connections/${team}`);
	await step(
		'delete the instance connection',
		'owner',
		'delete',
		`/promotions/connections/${instance}`,
	);
	await step(
		'delete the token provider',
		'owner',
		'delete',
		`/promotions/providers/${id('provider Bot user')}`,
	);
	await step('list the providers at the end', 'owner', 'get', '/promotions/providers');
	// #endregion

	expect(transcript).toMatchSnapshot();
}, 600_000);
