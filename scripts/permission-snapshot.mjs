#!/usr/bin/env node
// Record what a running n8n grants: its scopes, its system roles, the effect of the settings that
// change role scopes, and the scopes that each kind of user gets at login and for API keys.
//
// The fork's permission core (packages/@n8n/permissions) must behave as upstream n8n does. This
// script gets the data black-box, from the API and the database of a running n8n. It never reads
// the enterprise code. See packages/@n8n/permissions/FORK.md.
//
// Usage:
//   node scripts/permission-snapshot.mjs record [--image <image> | --n8n <bin>] --out <file>
//       Start n8n five times on a new SQLite database, and write a snapshot as JSON.
//       --image  An n8n Docker image, for example n8nio/n8n:2.42.0. Needs a running dockerd.
//       --n8n    The n8n start script of a build. Default: packages/cli/bin/n8n.
//   node scripts/permission-snapshot.mjs generate <snapshot> [--check]
//       Write packages/@n8n/permissions/src/permission-data.generated.ts from a snapshot.
//       --check  Do not write. Fail when the file is not the same as the generated text.
//
// Two snapshots of the same n8n version must be the same. To check a change to the permission
// core, record a snapshot before and after the change, and compare them with `diff`.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PERMISSIONS = join(ROOT, 'packages/@n8n/permissions');
const SCOPE_SNAPSHOT = join(
	PERMISSIONS,
	'src/__tests__/__snapshots__/scope-information.test.ts.snap',
);
const DATA_FILE = join(PERMISSIONS, 'src/permission-data.generated.ts');

const PASSWORD = 'Snapshot-Passw0rd';
// The settings that add scopes to system roles or remove scopes from them, and the value that is
// not the default. n8n reads these keys at startup. Each setting gets its own run of n8n.
const SETTINGS = {
	'security.personalSpacePublishing': 'false',
	'security.personalSpaceSharing': 'false',
	'externalSecrets.systemRolesEnabled': 'true',
};
// Custom global roles, to see how n8n treats a role that is not a system role. A role can copy the
// scopes of a system role.
const PROBE_ROLES = {
	'probe:withApiKey': ['apiKey:create', 'user:list', 'workflow:read', 'tag:read'],
	'probe:withoutApiKey': ['user:list', 'workflow:read', 'tag:read'],
	'probe:empty': [],
	'probe:ownerScopes': { copy: 'global:owner' },
	'probe:chatUserScopes': { copy: 'global:chatUser' },
	// All scopes: its API key scopes show which scopes an API key can hold.
	'probe:allScopes': { copy: '*' },
};
const USERS = {
	owner: 'global:owner',
	admin: 'global:admin',
	member: 'global:member',
	chatUser: 'global:chatUser',
	probeWithApiKey: 'probe:withApiKey',
	probeWithoutApiKey: 'probe:withoutApiKey',
	probeEmpty: 'probe:empty',
	probeOwnerScopes: 'probe:ownerScopes',
	probeChatUserScopes: 'probe:chatUserScopes',
	probeAllScopes: 'probe:allScopes',
};

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const options = { _: [] };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === '--check') options.check = true;
		else if (arg.startsWith('--')) options[arg.slice(2)] = rest[++i];
		else options._.push(arg);
	}
	return { command, options };
}

async function freePort() {
	return await new Promise((ok, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => ok(port));
		});
	});
}

const sleep = async (ms) => await new Promise((ok) => setTimeout(ok, ms));

/** Start n8n on a data folder. Returns a function that stops it. */
async function startN8n(options, dataDir, port) {
	const env = {
		N8N_DIAGNOSTICS_ENABLED: 'false',
		N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
		N8N_PERSONALIZATION_ENABLED: 'false',
		N8N_SECURE_COOKIE: 'false',
		N8N_LOG_LEVEL: process.env.N8N_LOG_LEVEL ?? 'warn',
		DB_TYPE: 'sqlite',
	};
	let child;
	let stop;
	if (options.image) {
		const name = `permission-snapshot-${port}`;
		// The container may have no IPv6, so listen on IPv4 only.
		const envArgs = Object.entries({ ...env, N8N_LISTEN_ADDRESS: '0.0.0.0' }).flatMap(
			([key, value]) => ['-e', `${key}=${value}`],
		);
		child = spawn(
			'docker',
			[
				'run',
				'--rm',
				'--name',
				name,
				'-p',
				`127.0.0.1:${port}:5678`,
				'-v',
				`${dataDir}:/home/node/.n8n`,
			].concat(envArgs, [options.image]),
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		stop = async () => {
			spawnSync('docker', ['stop', name], { stdio: 'ignore' });
			await new Promise((ok) => (child.exitCode === null ? child.on('exit', ok) : ok()));
		};
	} else {
		const bin = resolve(options.n8n ?? join(ROOT, 'packages/cli/bin/n8n'));
		child = spawn(process.execPath, [bin, 'start'], {
			env: {
				...process.env,
				...env,
				N8N_USER_FOLDER: dirname(dataDir),
				N8N_PORT: String(port),
				N8N_LISTEN_ADDRESS: '127.0.0.1',
				N8N_RUNNERS_BROKER_PORT: String(await freePort()),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		stop = async () => {
			if (child.exitCode !== null) return;
			child.kill('SIGTERM');
			await new Promise((ok) => child.on('exit', ok));
		};
	}
	let log = '';
	child.stdout.on('data', (chunk) => (log += chunk));
	child.stderr.on('data', (chunk) => (log += chunk));

	for (let i = 0; i < 300; i++) {
		if (child.exitCode !== null) {
			throw new Error(
				`n8n stopped during startup (exit code ${child.exitCode}):\n${log.slice(-3000)}`,
			);
		}
		try {
			const res = await fetch(`http://127.0.0.1:${port}/healthz/readiness`);
			if (res.ok) return stop;
		} catch {}
		await sleep(1000);
	}
	await stop();
	throw new Error(`n8n did not start in 5 minutes:\n${log.slice(-3000)}`);
}

class Session {
	constructor(base) {
		this.base = base;
		this.cookie = '';
	}

	async request(method, path, body) {
		const res = await fetch(`${this.base}${path}`, {
			method,
			headers: {
				'content-type': 'application/json',
				...(this.cookie && { cookie: this.cookie }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
		const auth = cookies.find((c) => c.startsWith('n8n-auth='));
		if (auth) this.cookie = auth;
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
		return JSON.parse(text).data;
	}
}

function openDb(dataDir) {
	return new DatabaseSync(join(dataDir, 'database.sqlite'));
}

function readRoles(dataDir) {
	const db = openDb(dataDir);
	const roles = {};
	for (const row of db.prepare('SELECT * FROM role ORDER BY slug').all()) {
		roles[row.slug] = {
			displayName: row.displayName,
			description: row.description,
			roleType: row.roleType,
			systemRole: Boolean(row.systemRole),
			scopes: db
				.prepare('SELECT scopeSlug FROM role_scope WHERE roleSlug = ? ORDER BY scopeSlug')
				.all(row.slug)
				.map((r) => r.scopeSlug),
		};
	}
	const scopes = db
		.prepare('SELECT slug, displayName, description FROM scope ORDER BY slug')
		.all()
		.map((row) => ({ ...row }));
	db.close();
	return { roles, scopes };
}

function diffRoles(before, after) {
	const result = {};
	for (const slug of Object.keys(before)) {
		const was = new Set(before[slug].scopes);
		const now = new Set(after[slug]?.scopes ?? []);
		const added = [...now].filter((s) => !was.has(s));
		const removed = [...was].filter((s) => !now.has(s));
		if (added.length || removed.length) result[slug] = { added, removed };
	}
	return result;
}

async function record(options) {
	if (!options.out) fail('give --out <file>');
	const work = mkdtempSync(join(tmpdir(), 'permission-snapshot-'));
	const dataDir = join(work, '.n8n');
	mkdirSync(dataDir);
	// The n8n image runs as another user, which must write to the folder.
	chmodSync(dataDir, 0o777);
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const run = async (fn) => {
		const stop = await startN8n(options, dataDir, port);
		try {
			return await fn();
		} finally {
			await stop();
		}
	};

	try {
		// Run 1: an owner, and one invited member for each other user.
		const ids = await run(async () => {
			const owner = new Session(base);
			for (let i = 0; ; i++) {
				try {
					await owner.request('POST', '/rest/owner/setup', {
						email: 'owner@example.com',
						firstName: 'Snapshot',
						lastName: 'Owner',
						password: PASSWORD,
					});
					break;
				} catch (error) {
					if (i === 30) throw error;
					await sleep(1000);
				}
			}
			const others = Object.keys(USERS).filter((name) => name !== 'owner');
			const invited = await owner.request(
				'POST',
				'/rest/invitations',
				others.map((name) => ({
					email: `${name.toLowerCase()}@example.com`,
					role: 'global:member',
				})),
			);
			const result = {};
			for (const { user } of invited) {
				const token = new URL(user.inviteAcceptUrl).searchParams.get('token');
				await new Session(base).request('POST', '/rest/invitations/accept', {
					token,
					firstName: 'Snapshot',
					lastName: 'User',
					password: PASSWORD,
				});
				result[user.email] = user.id;
			}
			return result;
		});

		// Give the users their roles. Custom roles need a license in the API, so write them to the
		// database while n8n is stopped.
		const db = openDb(dataDir);
		for (const [slug, probe] of Object.entries(PROBE_ROLES)) {
			const scopes = Array.isArray(probe)
				? probe
				: probe.copy === '*'
					? db
							.prepare('SELECT slug FROM scope')
							.all()
							.map((row) => row.slug)
					: db
							.prepare('SELECT scopeSlug FROM role_scope WHERE roleSlug = ?')
							.all(probe.copy)
							.map((row) => row.scopeSlug);
			db.prepare(
				"INSERT INTO role (slug, displayName, description, roleType, systemRole) VALUES (?, ?, NULL, 'global', 0)",
			).run(slug, slug);
			for (const scope of scopes) {
				db.prepare('INSERT INTO role_scope (roleSlug, scopeSlug) VALUES (?, ?)').run(slug, scope);
			}
		}
		for (const [name, role] of Object.entries(USERS)) {
			if (name === 'owner') continue;
			db.prepare('UPDATE user SET roleSlug = ? WHERE id = ?').run(
				role,
				ids[`${name.toLowerCase()}@example.com`],
			);
		}
		db.close();

		// Run 2: what each user gets, with the default settings.
		const users = await run(async () => {
			const result = {};
			for (const [name, role] of Object.entries(USERS)) {
				const session = new Session(base);
				const login = await session.request('POST', '/rest/login', {
					emailOrLdapLoginId: `${name.toLowerCase()}@example.com`,
					password: PASSWORD,
				});
				if (login.role !== role) throw new Error(`${name} has the role ${login.role}, not ${role}`);
				result[name] = {
					role,
					globalScopes: login.globalScopes,
					apiKeyScopes: await session.request('GET', '/rest/api-keys/scopes'),
				};
				if (name === 'owner') {
					const restRoles = await session.request('GET', '/rest/roles');
					for (const list of Object.values(restRoles)) {
						for (const r of list) {
							delete r.createdAt;
							delete r.updatedAt;
							r.scopes = [...r.scopes].sort();
						}
					}
					result[name].restRoles = restRoles;
				}
			}
			return result;
		});
		const { roles, scopes } = readRoles(dataDir);

		// Runs 3 and more: the effect of each setting on the system roles, against the defaults.
		const settings = {};
		for (const [key, value] of Object.entries(SETTINGS)) {
			const settingsDb = openDb(dataDir);
			settingsDb
				.prepare(
					'DELETE FROM settings WHERE key IN (' +
						Object.keys(SETTINGS)
							.map(() => '?')
							.join(', ') +
						')',
				)
				.run(...Object.keys(SETTINGS));
			settingsDb
				.prepare('INSERT INTO settings (key, value, loadOnStartup) VALUES (?, ?, 1)')
				.run(key, value);
			settingsDb.close();
			await run(async () => {});
			const diff = diffRoles(roles, readRoles(dataDir).roles);
			if (Object.keys(diff).length === 0) {
				throw new Error(`${key}=${value} changes no role. Did n8n rename the setting?`);
			}
			settings[`${key}=${value}`] = diff;
		}

		const snapshot = { scopes, roles, settings, users };
		const out = resolve(options.out);
		writeFileSync(out, `${JSON.stringify(snapshot, null, '\t')}\n`);
		// The format check of the package covers JSON files in the repository.
		if (out.startsWith(`${ROOT}/`)) {
			spawnSync(join(ROOT, 'node_modules/.bin/biome'), ['format', '--write', out], {
				stdio: 'ignore',
			});
		}
		console.log(`Wrote ${out}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** ALL_SCOPES in its order, from the snapshot of the ordinary scope-information test. */
function readScopeOrder() {
	const text = readFileSync(SCOPE_SNAPSHOT, 'utf8');
	return [...text.matchAll(/^ {2}"([^"]+)",$/gm)].map((m) => m[1]);
}

/** Group scopes by resource. Resources and operations keep their first position in `scopes`. */
function groupByResource(scopes) {
	const groups = {};
	for (const scope of scopes) {
		const [resource, operation] = scope.split(':');
		(groups[resource] ??= []).push(operation);
	}
	return groups;
}

const unique = (list) => [...new Set(list)];

/** The scopes of an API key for a user, as the fork code computes them. */
function apiKeyScopesFor(user, apiKeyScopes, extraScopes) {
	if (user.role === 'global:chatUser') return [];
	return unique([...user.globalScopes.filter((s) => apiKeyScopes.has(s)), ...extraScopes]);
}

function generateData(snapshot) {
	const scopeOrder = readScopeOrder();
	const recorded = snapshot.scopes.map((s) => s.slug);
	const missing = recorded.filter((s) => !scopeOrder.includes(s));
	const extra = scopeOrder.filter((s) => !recorded.includes(s));
	if (missing.length || extra.length) {
		fail(
			`the scopes of the running n8n are not the scopes in ${SCOPE_SNAPSHOT}.\n` +
				`Only in n8n: ${missing.join(', ') || '-'}\nOnly in the snapshot: ${extra.join(', ') || '-'}`,
		);
	}
	const byScopeOrder = (list) =>
		[...list].sort((a, b) => scopeOrder.indexOf(a) - scopeOrder.indexOf(b));

	const setting = (label, roleSlug, change) => {
		const diff = snapshot.settings[label];
		if (!diff) fail(`the snapshot has no run for ${label}`);
		const other = Object.keys(diff).filter((slug) => !roleSlug.includes(slug));
		if (other.length) fail(`${label} also changes ${other.join(', ')}`);
		return Object.fromEntries(
			roleSlug.map((slug) => [slug, byScopeOrder(diff[slug]?.[change] ?? [])]),
		);
	};
	const publishing = setting(
		'security.personalSpacePublishing=false',
		['project:personalOwner'],
		'removed',
	);
	const sharing = setting(
		'security.personalSpaceSharing=false',
		['project:personalOwner'],
		'removed',
	);
	const externalSecrets = setting(
		'externalSecrets.systemRolesEnabled=true',
		['project:admin', 'project:editor'],
		'added',
	);

	// The scopes of each system role without the scopes that the settings add.
	const roleScopes = {};
	for (const [slug, role] of Object.entries(snapshot.roles)) {
		if (!role.systemRole) continue;
		const added = new Set(
			slug === 'project:personalOwner' ? [...publishing[slug], ...sharing[slug]] : [],
		);
		roleScopes[slug] = byScopeOrder(role.scopes.filter((s) => !added.has(s)));
	}

	// The API key model: the API key scopes of the role, then a fixed list. A chat user gets none.
	const users = snapshot.users;
	const allApiKeyScopes = unique(Object.values(users).flatMap((u) => u.apiKeyScopes));
	const apiKeyScopeSet = new Set(allApiKeyScopes);
	const extraScopes = users.probeEmpty.apiKeyScopes;
	if (users.probeEmpty.globalScopes.length) fail('the user with an empty role has scopes');
	for (const [name, user] of Object.entries(users)) {
		const expected = apiKeyScopesFor(user, apiKeyScopeSet, extraScopes);
		if (JSON.stringify(expected) !== JSON.stringify(user.apiKeyScopes)) {
			fail(
				`the API key model does not give the API key scopes of ${name}.\n` +
					`n8n:   ${user.apiKeyScopes.join(', ')}\nmodel: ${expected.join(', ')}`,
			);
		}
	}
	// API key scopes in the order of ALL_SCOPES, then the scopes that only API keys have.
	const apiKeyResources = groupByResource([
		...scopeOrder.filter((s) => apiKeyScopeSet.has(s)),
		...allApiKeyScopes.filter((s) => !scopeOrder.includes(s)),
	]);

	const literal = (value, indent = '') => {
		const next = `${indent}\t`;
		if (Array.isArray(value)) {
			if (value.length === 0) return '[]';
			return `[\n${value.map((v) => `${next}${literal(v, next)},`).join('\n')}\n${indent}]`;
		}
		if (typeof value === 'object') {
			const entries = Object.entries(value).map(([k, v]) => {
				const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`;
				return `${next}${key}: ${literal(v, next)},`;
			});
			return `{\n${entries.join('\n')}\n${indent}}`;
		}
		return `'${value}'`;
	};
	const constant = (doc, name, value) =>
		`/** ${doc} */\nexport const ${name} = ${literal(value)} as const;\n`;

	return [
		'// Generated by scripts/permission-snapshot.mjs from a snapshot of a running n8n. Do not edit.',
		'// packages/@n8n/permissions/FORK.md tells how to make it again after an upstream update.',
		'',
		constant(
			'The operations of each resource. ALL_SCOPES has this order.',
			'RESOURCES',
			groupByResource(scopeOrder),
		),
		constant(
			'The operations that an API key can hold, for each resource.',
			'API_KEY_RESOURCES',
			apiKeyResources,
		),
		constant(
			'The scopes of each system role, without the scopes that settings add.',
			'SYSTEM_ROLE_SCOPES',
			roleScopes,
		),
		constant(
			'The scopes that an API key gets in addition to the API key scopes of the role.',
			'API_KEY_EXTRA_SCOPES',
			extraScopes,
		),
		constant(
			'The scopes that the personal owner role gets while users can publish in personal spaces.',
			'PERSONAL_SPACE_PUBLISHING_SCOPES',
			publishing['project:personalOwner'],
		),
		constant(
			'The scopes that the personal owner role gets while users can share from personal spaces.',
			'PERSONAL_SPACE_SHARING_SCOPES',
			sharing['project:personalOwner'],
		),
		constant(
			'The scopes that project roles get while external secrets are on for project roles.',
			'EXTERNAL_SECRETS_ROLE_SCOPES',
			externalSecrets,
		),
	].join('\n');
}

function generate(options) {
	const [file] = options._;
	if (!file) fail('give a snapshot file');
	const text = generateData(JSON.parse(readFileSync(file, 'utf8')));
	if (options.check) {
		if (readFileSync(DATA_FILE, 'utf8') !== text)
			fail(`${DATA_FILE} is not the same as the snapshot data`);
		console.log(`${DATA_FILE} is up to date`);
		return;
	}
	writeFileSync(DATA_FILE, text);
	console.log(`Wrote ${DATA_FILE}`);
}

function main() {
	const { command, options } = parseArgs(process.argv.slice(2));
	if (command === 'record') return record(options);
	if (command === 'generate') return generate(options);
	fail(
		'usage: permission-snapshot.mjs record [--image <image> | --n8n <bin>] --out <file>\n' +
			'       permission-snapshot.mjs generate <snapshot> [--check]',
	);
}

try {
	await main();
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
