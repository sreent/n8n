// Checks that the deployment options use the same n8n settings:
// - settings.yaml has the values that the VM setup (docker-compose.yml with a .env from
//   .env.example) gives n8n,
// - each setting of the VM setup is in settings.yaml, apart from the settings that each option
//   sets itself (the database, the secrets, the URL and the task runners),
// - the Helm chart has a copy of settings.yaml in its values.yaml.
// Run it with `node --test deploy/settings.test.mjs`. It needs no packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const here = new URL('./', import.meta.url);
const read = (path) => readFileSync(new URL(path, here), 'utf8');

// Settings of docker-compose.yml that each option sets itself.
const PLATFORM_SETTINGS = new Set([
	'DB_TYPE',
	'DB_POSTGRESDB_HOST',
	'DB_POSTGRESDB_DATABASE',
	'DB_POSTGRESDB_USER',
	'DB_POSTGRESDB_PASSWORD',
	'N8N_ENCRYPTION_KEY',
	'N8N_HOST',
	'N8N_PROTOCOL',
	'N8N_LISTEN_ADDRESS',
	'WEBHOOK_URL',
	'N8N_PROXY_HOPS',
	'N8N_RUNNERS_MODE',
	'N8N_RUNNERS_AUTH_TOKEN',
	'N8N_RUNNERS_BROKER_LISTEN_ADDRESS',
	// Secrets: each option keeps them in the secret store of the platform.
	'N8N_SSO_OIDC_CLIENT_SECRET',
	'N8N_COMMUNITY_PACKAGES_AUTH_TOKEN',
	'N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN',
]);

// Settings that the VM does not need: it keeps the community nodes on its disk.
const CONTAINER_ONLY_SETTINGS = new Set(['N8N_REINSTALL_MISSING_PACKAGES']);

/** Reads the `settings:` map of settings.yaml or of the values of the chart. */
export function parseSettingsBlock(text, source) {
	const lines = text.split('\n');
	const start = lines.indexOf('settings:');
	assert.notEqual(start, -1, `${source} has no top-level "settings:" key`);
	const settings = {};
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === '' || /^\s+#/.test(line)) continue;
		if (!line.startsWith('  ')) break;
		const match = /^ {2}([A-Z][A-Z0-9_]*): "([^"\\]*)"$/.exec(line);
		assert.ok(match, `${source}: each setting must be KEY: "value" on one line: ${line}`);
		assert.equal(settings[match[1]], undefined, `${source}: ${match[1]} is set twice`);
		settings[match[1]] = match[2];
	}
	return settings;
}

/** Reads the environment of the n8n service in docker-compose.yml, with the values of .env. */
function composeEnvironment(composeText, env) {
	const lines = composeText.split('\n');
	const service = lines.indexOf('  n8n:');
	assert.notEqual(service, -1, 'docker-compose.yml has no n8n service');
	const block = lines.indexOf('    environment:', service);
	const result = {};
	for (const line of lines.slice(block + 1)) {
		if (line.trim() === '' || /^\s+#/.test(line)) continue;
		if (!line.startsWith('      ')) break;
		const match = /^ {6}([A-Z][A-Z0-9_]*): (.*)$/.exec(line);
		assert.ok(match, `docker-compose.yml: unexpected line in the environment: ${line}`);
		result[match[1]] = interpolate(match[2].replace(/^'(.*)'$/, '$1'), env);
	}
	return result;
}

/** The variable interpolation of Docker Compose: ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?error}. */
function interpolate(value, env) {
	return value.replace(/\$\{([A-Z0-9_]+)(?:(:?)([-?])([^}]*))?\}/g, (_, name, colon, kind, arg) => {
		const set = Object.hasOwn(env, name);
		const empty = !set || (colon === ':' && env[name] === '');
		if (kind === '-') return empty ? arg : env[name];
		if (kind === '?') {
			assert.ok(!empty, `docker-compose.yml needs ${name}`);
			return env[name];
		}
		return set ? env[name] : '';
	});
}

function envExample() {
	const env = {};
	for (const line of read('.env.example').split('\n')) {
		const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
		if (match) env[match[1]] = match[2];
	}
	// The secrets of .env.example are empty: give them a value, as an operator does.
	for (const name of ['POSTGRES_PASSWORD', 'N8N_ENCRYPTION_KEY', 'N8N_RUNNERS_AUTH_TOKEN']) {
		env[name] = 'secret';
	}
	return env;
}

// The VM appends the ranges of .env to 127.0.0.1/32, so an empty list leaves a comma at the end.
const normalize = (name, value) =>
	name === 'N8N_SSRF_ALLOWED_IP_RANGES' ? value.replace(/,+$/, '') : value;

const settings = parseSettingsBlock(read('settings.yaml'), 'settings.yaml');

test('settings.yaml has the values of the VM setup', () => {
	const compose = composeEnvironment(read('docker-compose.yml'), envExample());
	for (const [name, value] of Object.entries(settings)) {
		if (CONTAINER_ONLY_SETTINGS.has(name)) {
			assert.equal(compose[name], undefined, `${name} is in docker-compose.yml now`);
			continue;
		}
		assert.ok(name in compose, `${name} is not in docker-compose.yml`);
		assert.equal(value, normalize(name, compose[name]), `the value of ${name}`);
	}
});

test('each setting of the VM setup is in settings.yaml', () => {
	const compose = composeEnvironment(read('docker-compose.yml'), envExample());
	const missing = Object.keys(compose).filter(
		(name) => !PLATFORM_SETTINGS.has(name) && !(name in settings),
	);
	assert.deepEqual(missing, [], 'add these settings to settings.yaml');
});

test('the Helm chart has a copy of settings.yaml', () => {
	const chart = parseSettingsBlock(read('kubernetes/n8n/values.yaml'), 'values.yaml of the chart');
	assert.deepEqual(chart, settings);
});
