// Checks the files that the Helm chart renders, for each mode, and its error messages.
// Run it with `node --test deploy/kubernetes/chart.test.mjs`. It needs helm (HELM, or helm on the
// PATH), and skips the tests without it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const chart = fileURLToPath(new URL('./n8n', import.meta.url));
const helm = process.env.HELM ?? 'helm';
const hasHelm = spawnSync(helm, ['version', '--short']).status === 0;

const required = { host: 'n8n.example.com', existingSecret: 'n8n-secrets', 'database.host': 'pg' };

function render(values = {}) {
	const args = ['template', 'n8n', chart];
	for (const [name, value] of Object.entries({ ...required, ...values })) {
		// Settings and extra variables are text. Other values keep their type (true, 2).
		const text = /^(settings|extraEnv)\./.test(name);
		const flag = text ? '--set-string' : '--set';
		args.push(flag, `${name}=${Array.isArray(value) ? `{${value.join(',')}}` : value}`);
	}
	const result = spawnSync(helm, args, { encoding: 'utf8' });
	return { ok: result.status === 0, out: result.stdout, err: result.stderr };
}

/** The documents of the output, by "Kind/name". */
function documents(out) {
	const result = {};
	for (const doc of out.split(/^---$/m)) {
		const kind = /^kind: (\S+)/m.exec(doc)?.[1];
		const name = /^ {2}name: (\S+)/m.exec(doc)?.[1];
		if (kind && name) result[`${kind}/${name}`] = doc;
	}
	return result;
}

/** The data of the ConfigMap with the environment of n8n. */
function env(out) {
	const doc = documents(out)['ConfigMap/n8n-env'];
	assert.ok(doc, 'no ConfigMap n8n-env');
	return Object.fromEntries([...doc.matchAll(/^ {2}([A-Z][A-Z0-9_]*): "(.*)"$/gm)].map((m) => [m[1], m[2]]));
}

const options = { skip: !hasHelm && 'helm is not installed' };

test('single mode: one instance that stops before the new one starts', options, () => {
	const { ok, out, err } = render();
	assert.ok(ok, err);
	const docs = documents(out);
	assert.match(docs['Deployment/n8n-main'], /replicas: 1\n/);
	assert.match(docs['Deployment/n8n-main'], /type: Recreate/);
	assert.equal(docs['Deployment/n8n-worker'], undefined);
	const vars = env(out);
	assert.equal(vars.N8N_OPEN_TRIGGERS_NEED_APPROVAL, 'true');
	assert.equal(vars.N8N_DEFAULT_BINARY_DATA_MODE, 'database');
	assert.equal(vars.N8N_LISTEN_ADDRESS, '0.0.0.0');
	assert.equal(vars.N8N_RUNNERS_BROKER_LISTEN_ADDRESS, '127.0.0.1');
	assert.equal(vars.WEBHOOK_URL, 'https://n8n.example.com/');
	assert.equal(vars.EXECUTIONS_MODE, undefined);
	// The secrets come from the Secret, not from the ConfigMap.
	assert.equal(vars.N8N_ENCRYPTION_KEY, undefined);
	assert.match(docs['Deployment/n8n-main'], /name: N8N_ENCRYPTION_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: n8n-secrets\n\s+key: N8N_ENCRYPTION_KEY\n(?!\s+optional)/);
});

test('queue mode: main instances with the leader election, and workers', options, () => {
	const { ok, out, err } = render({ mode: 'queue', 'redis.host': 'redis', 'main.replicas': '2' });
	assert.ok(ok, err);
	const docs = documents(out);
	assert.match(docs['Deployment/n8n-main'], /replicas: 2\n/);
	assert.match(docs['Deployment/n8n-main'], /type: RollingUpdate/);
	assert.match(docs['Deployment/n8n-worker'], /args: \["worker", "--concurrency=10"\]/);
	const vars = env(out);
	assert.equal(vars.EXECUTIONS_MODE, 'queue');
	assert.equal(vars.N8N_MULTI_MAIN_SETUP_ENABLED, 'true');
	assert.equal(vars.N8N_WORKER_SERVER_ADDRESS, '0.0.0.0');
	assert.equal(vars.N8N_AI_GATEWAY_BASE_URL, 'http://n8n/ai-gateway');
	assert.equal(vars.N8N_SSRF_ALLOWED_HOSTNAMES, 'n8n');
});

test('edge: Caddy is the only way to n8n, with the IP limits', options, () => {
	const { ok, out, err } = render({
		'edge.enabled': 'true',
		'edge.trustedProxies': ['10.244.0.0/16'],
		'edge.webhookAllowedRanges': ['10.99.0.0/16'],
	});
	assert.ok(ok, err);
	const docs = documents(out);
	const vars = env(out);
	assert.equal(vars.N8N_LISTEN_ADDRESS, '127.0.0.1');
	assert.equal(vars.N8N_PROXY_HOPS, '2');
	assert.match(docs['Service/n8n'], /targetPort: edge/);
	assert.match(docs['Deployment/n8n-main'], /path: \/healthz\n\s+port: 8080/);
	const caddyfile = docs['ConfigMap/n8n-edge'];
	assert.match(caddyfile, /trusted_proxies static 10\.244\.0\.0\/16/);
	assert.match(caddyfile, /not client_ip 10\.99\.0\.0\/16/);
	assert.match(caddyfile, /not client_ip 0\.0\.0\.0\/0 ::\/0/);
});

test('settings: a value of the values file replaces the default', options, () => {
	const { ok, out, err } = render({ 'settings.N8N_MFA_ENFORCED_ENABLED': 'false', 'extraEnv.N8N_LOG_LEVEL': 'debug' });
	assert.ok(ok, err);
	const vars = env(out);
	assert.equal(vars.N8N_MFA_ENFORCED_ENABLED, 'false');
	assert.equal(vars.N8N_SSRF_PROTECTION_ENABLED, 'true');
	assert.equal(vars.N8N_LOG_LEVEL, 'debug');
});

test('extra volumes: a certificate authority for NODE_EXTRA_CA_CERTS', options, () => {
	const { ok, out, err } = render({
		mode: 'queue',
		'redis.host': 'redis',
		'extraVolumes[0].name': 'redis-ca',
		'extraVolumes[0].secret.secretName': 'redis-ca',
		'extraVolumeMounts[0].name': 'redis-ca',
		'extraVolumeMounts[0].mountPath': '/etc/n8n-redis-ca',
		'extraVolumeMounts[0].readOnly': 'true',
		'extraEnv.NODE_EXTRA_CA_CERTS': '/etc/n8n-redis-ca/ca.crt',
	});
	assert.ok(ok, err);
	const docs = documents(out);
	for (const name of ['Deployment/n8n-main', 'Deployment/n8n-worker']) {
		assert.match(docs[name], /- mountPath: \/etc\/n8n-redis-ca\n\s+name: redis-ca\n\s+readOnly: true/, name);
		assert.match(docs[name], /- name: redis-ca\n\s+secret:\n\s+secretName: redis-ca/, name);
	}
	assert.equal(env(out).NODE_EXTRA_CA_CERTS, '/etc/n8n-redis-ca/ca.crt');
});

test('ingress: annotations of webhooks move their paths to an Ingress of their own', options, () => {
	const { ok, out, err } = render({ 'ingress.enabled': 'true', 'ingress.webhooks.annotations.example\\.com/allowlist': '10.0.0.0/8' });
	assert.ok(ok, err);
	const docs = documents(out);
	assert.match(docs['Ingress/n8n-webhooks'], /path: \/webhook-test/);
	assert.match(docs['Ingress/n8n-webhooks'], /example\.com\/allowlist: 10\.0\.0\.0\/8/);
	assert.equal(docs['Ingress/n8n-forms'], undefined);
	assert.match(docs['Ingress/n8n'], /path: \/\n/);
});

test('errors: the chart stops with a clear message', options, () => {
	const cases = [
		[{ host: '' }, /Set host/],
		[{ existingSecret: '' }, /Set existingSecret/],
		[{ 'database.host': '' }, /Set database.host/],
		[{ mode: 'cluster' }, /Set mode to single or queue/],
		[{ 'main.replicas': '2' }, /mode single runs one n8n instance/],
		[{ mode: 'queue' }, /mode queue needs redis.host/],
		[{ 'edge.enabled': 'true' }, /Set edge.trustedProxies/],
		[{ 'ingress.enabled': 'true', 'httpRoute.enabled': 'true' }, /Turn on ingress or httpRoute/],
	];
	for (const [values, message] of cases) {
		const { ok, err } = render(values);
		assert.equal(ok, false, JSON.stringify(values));
		assert.match(err, message);
	}
});
