// Fork test (not in upstream n8n) of setup.mjs, with a fake public API of n8n.
// Run it with: node --test deploy/platform/setup.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
	DEFAULT_RULE_EXPRESSION,
	groupExpression,
	main,
	readConfig,
	resolveData,
} from './setup.mjs';

const KEY = 'test-api-key';
const SECRET = 'token-that-must-not-show';

/** A fake n8n with the routes of the public API that setup.mjs calls. */
class FakeN8n {
	constructor({ projects = [], credentials = [], rules = [], policy = {}, method = 'oidc' } = {}) {
		this.nextId = 1;
		this.projects = [{ id: 'personal-1', name: 'Olive Owner', type: 'personal' }, ...projects];
		this.credentials = credentials;
		this.rules = rules;
		this.created = [];
		this.policy = {
			personalSpacePublishing: false,
			personalSpaceSharing: false,
			publishedPersonalWorkflowsCount: 0,
			sharedPersonalWorkflowsCount: 0,
			sharedPersonalCredentialsCount: 0,
			...policy,
		};
		this.method = method;
		this.openTriggers = [];
		this.users = [
			{ id: 'u1', email: 'owner@example.com', role: 'global:owner' },
			{ id: 'u2', email: 'ada@example.com', role: 'global:admin' },
			{ id: 'u3', email: 'mia@example.com', role: 'global:member' },
		];
		this.fetch = this.fetch.bind(this);
	}

	id(prefix) {
		return `${prefix}-${this.nextId++}`;
	}

	renumber(type) {
		this.rules
			.filter((rule) => rule.type === type)
			.sort((a, b) => a.order - b.order)
			.forEach((rule, index) => {
				rule.order = index;
			});
	}

	page(items) {
		return { status: 200, body: { data: items, nextCursor: null } };
	}

	route(method, path, query, body) {
		if (method === 'GET' && path === '/rest/settings') {
			return {
				status: 200,
				body: { data: { userManagement: { authenticationMethod: this.method } } },
			};
		}
		if (method === 'GET' && path === '/api/v1/projects') return this.page(this.projects);
		if (method === 'POST' && path === '/api/v1/projects') {
			const project = { id: this.id('project'), name: body.name, type: 'team' };
			this.projects.push(project);
			this.created.push(['project', body]);
			return { status: 201, body: project };
		}
		if (method === 'GET' && path === '/api/v1/credentials') return this.page(this.credentials);
		if (method === 'POST' && path === '/api/v1/credentials') {
			const provider = JSON.stringify(body.data).match(/\$secrets\.(\w+)/);
			if (provider) {
				return {
					status: 400,
					body: {
						message: `The secret provider "${provider[1]}" used in "password" does not exist in this project`,
					},
				};
			}
			const project = this.projects.find((candidate) => candidate.id === body.projectId);
			const credential = {
				id: this.id('credential'),
				name: body.name,
				type: body.type,
				shared: [{ id: project.id, name: project.name, role: 'credential:owner' }],
			};
			this.credentials.push(credential);
			this.created.push(['credential', body]);
			return { status: 200, body: credential };
		}
		const schema = path.match(/^\/api\/v1\/credentials\/schema\/(.+)$/);
		if (method === 'GET' && schema) {
			const required = { httpHeaderAuth: ['name', 'value'], httpBasicAuth: ['user', 'password'] };
			const type = decodeURIComponent(schema[1]);
			if (!(type in required)) return { status: 404, body: { message: 'Not found' } };
			return { status: 200, body: { type: 'object', required: required[type] } };
		}
		if (method === 'GET' && path === '/api/v1/roles') {
			return {
				status: 200,
				body: {
					global: ['global:owner', 'global:admin', 'global:member', 'global:chatUser'].map(
						(slug) => ({ slug }),
					),
					project: ['project:admin', 'project:editor', 'project:viewer'].map((slug) => ({ slug })),
				},
			};
		}
		if (method === 'GET' && path === '/api/v1/role-mapping-rules') {
			const type = query.get('type');
			return this.page(
				this.rules
					.filter((rule) => !type || rule.type === type)
					.sort((a, b) => a.type.localeCompare(b.type) || a.order - b.order)
					.map((rule) => ({ ...rule, projectIds: [...rule.projectIds] })),
			);
		}
		if (method === 'POST' && path === '/api/v1/role-mapping-rules') {
			const order = this.rules.filter((rule) => rule.type === body.type).length;
			const rule = {
				id: this.id('rule'),
				expression: body.expression,
				role: body.role,
				type: body.type,
				order,
				projectIds: body.projectIds ?? [],
			};
			this.rules.push(rule);
			this.created.push(['rule', body]);
			return { status: 201, body: rule };
		}
		const move = path.match(/^\/api\/v1\/role-mapping-rules\/([^/]+)\/move$/);
		if (method === 'POST' && move) {
			const rule = this.rules.find((candidate) => candidate.id === move[1]);
			const others = this.rules
				.filter((candidate) => candidate.type === rule.type && candidate !== rule)
				.sort((a, b) => a.order - b.order);
			others.splice(body.targetIndex, 0, rule);
			others.forEach((candidate, index) => {
				candidate.order = index;
			});
			return { status: 200, body: rule };
		}
		const remove = path.match(/^\/api\/v1\/role-mapping-rules\/([^/]+)$/);
		if (method === 'DELETE' && remove) {
			const rule = this.rules.find((candidate) => candidate.id === remove[1]);
			this.rules = this.rules.filter((candidate) => candidate !== rule);
			this.renumber(rule.type);
			return { status: 200, body: rule };
		}
		if (method === 'GET' && path === '/api/v1/settings/security-policy') {
			return { status: 200, body: this.policy };
		}
		if (method === 'GET' && path === '/api/v1/inventory/open-triggers') {
			return this.page(this.openTriggers);
		}
		if (method === 'GET' && path === '/api/v1/users') {
			assert.equal(query.get('includeRole'), 'true');
			return this.page(this.users);
		}
		return { status: 404, body: { message: `No route ${method} ${path}` } };
	}

	async fetch(url, init) {
		const { pathname, searchParams } = new URL(url);
		if (pathname.startsWith('/api/v1/')) {
			assert.equal(init.headers['x-n8n-api-key'], KEY);
		} else {
			assert.equal(init.headers['x-n8n-api-key'], undefined, 'no key outside the public API');
		}
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		const { status, body: answer } = this.route(init.method, pathname, searchParams, body);
		return new Response(JSON.stringify(answer), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	}
}

const exampleConfig = {
	groupsClaim: 'groups',
	instanceRoles: [
		{ group: 'n8n-admins', role: 'global:admin' },
		{ group: 'n8n-users', role: 'global:member' },
	],
	projects: [
		{
			name: 'Sales',
			description: 'Workflows of the sales team',
			roles: [
				{ group: 'sales-admins', role: 'project:admin' },
				{ group: 'sales-builders', role: 'project:editor' },
			],
			credentials: [
				{
					name: 'Sales CRM',
					type: 'httpHeaderAuth',
					data: { name: 'Authorization', value: { env: 'SALES_CRM_TOKEN' } },
				},
			],
		},
		{ name: 'Finance', roles: [{ group: 'finance-viewers', role: 'project:viewer' }] },
	],
};

async function configFile(config) {
	const folder = await mkdtemp(join(tmpdir(), 'platform-setup-'));
	const path = join(folder, 'platform.json');
	await writeFile(path, JSON.stringify(config));
	return path;
}

async function run(fake, command, config = exampleConfig, extra = [], env = {}) {
	const lines = [];
	const code = await main(
		[command, '--config', await configFile(config), ...extra],
		{ N8N_URL: 'https://n8n.example.com/', N8N_API_KEY: KEY, SALES_CRM_TOKEN: SECRET, ...env },
		{ log: (line) => lines.push(line), fetchImpl: fake.fetch },
	);
	const output = lines.join('\n');
	assert.ok(!output.includes(SECRET), 'the output shows no secret');
	assert.ok(!output.includes(KEY), 'the output shows no API key');
	return { code, output };
}

describe('readConfig', () => {
	it('gives the defaults', () => {
		const { config, problems } = readConfig({ projects: [{ name: 'Ops' }] });
		assert.deepEqual(problems, []);
		assert.deepEqual(config, {
			groupsClaim: 'groups',
			instanceRoles: [],
			defaultInstanceRole: undefined,
			projects: [{ name: 'Ops', description: undefined, roles: [], credentials: [] }],
		});
	});

	it('refuses a default role that n8n cannot give', () => {
		assert.deepEqual(readConfig({ defaultInstanceRole: 'block:access' }).problems, [
			'defaultInstanceRole: block:access is not a role. Give the n8n application only to the groups of n8n in the identity provider.',
		]);
		assert.deepEqual(readConfig({ defaultInstanceRole: 'global:owner' }).problems, [
			'defaultInstanceRole must be a global role, for example "global:chatUser".',
		]);
	});

	it('lists the problems of a config', () => {
		const { config, problems } = readConfig({
			instanceRoles: [
				{ group: 'a', role: 'global:owner' },
				{ group: 'a', role: 'project:editor' },
				{ group: '{{ x }}', role: 'global:member' },
			],
			projects: [
				{ name: 'Ops', roles: [{ group: 'b', role: 'project:personalOwner' }] },
				{ name: 'Ops', credentials: [{ name: 'x', type: 'httpHeaderAuth' }] },
			],
		});
		assert.equal(config, null);
		assert.deepEqual(problems, [
			'instanceRoles[0]: SSO cannot give the role global:owner.',
			'instanceRoles[1]: role must be a global role, for example "global:member".',
			'instanceRoles[1]: the group "a" is in instanceRoles twice.',
			'instanceRoles[2]: group must not contain {{ or }}.',
			'projects[0].roles[0]: a team project has no role project:personalOwner.',
			'projects[1]: the project "Ops" is in the config twice.',
			'projects[1].credentials[0] must be an object with a name, a type and data.',
		]);
	});
});

describe('groupExpression', () => {
	const evaluate = (expression, claims) =>
		// The body of the template, as n8n evaluates it, without the template braces.
		new Function('$claims', `return ${expression.slice(3, -3)}`)(claims);

	it('matches a group in a list, in a single value, and not without the claim', () => {
		const expression = groupExpression('groups', 'sales-builders');
		assert.equal(expression, '{{ [].concat($claims["groups"] || []).includes("sales-builders") }}');
		assert.equal(evaluate(expression, { groups: ['x', 'sales-builders'] }), true);
		assert.equal(evaluate(expression, { groups: 'sales-builders' }), true);
		assert.equal(evaluate(expression, { groups: ['sales-builders-2'] }), false);
		assert.equal(evaluate(expression, {}), false);
	});

	it('quotes claim names and groups', () => {
		const claim = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups';
		const expression = groupExpression(claim, 'Team "A"');
		assert.equal(evaluate(expression, { [claim]: ['Team "A"'] }), true);
	});
});

describe('resolveData', () => {
	it('reads the environment variables and lists the missing ones', () => {
		const missing = [];
		const data = resolveData(
			{ user: 'svc', password: { env: 'PASS' }, nested: { token: { env: 'GONE' } }, port: 5432 },
			{ PASS: 'p' },
			missing,
		);
		assert.deepEqual(data, { user: 'svc', password: 'p', nested: { token: '' }, port: 5432 });
		assert.deepEqual(missing, ['GONE']);
	});
});

describe('plan', () => {
	it('lists the changes on an empty n8n and changes nothing', async () => {
		const fake = new FakeN8n();
		const { code, output } = await run(fake, 'plan');

		assert.equal(code, 0);
		assert.deepEqual(fake.created, []);
		assert.match(output, /\+ create {2}Sales\n/);
		assert.match(output, /\+ create {2}Sales \/ Sales CRM \(httpHeaderAuth\)/);
		assert.match(output, /\+ create {2}instance {2}n8n-admins → global:admin/);
		assert.match(output, /\+ create {2}project {2}sales-builders → project:editor in Sales/);
		assert.match(output, /8 changes, 0 problems\. Run apply to make the changes\./);
	});

	it('stops at the problems', async () => {
		const fake = new FakeN8n({
			projects: [
				{ id: 'p1', name: 'Finance', type: 'team' },
				{ id: 'p2', name: 'Finance', type: 'team' },
			],
		});
		const config = structuredClone(exampleConfig);
		config.projects[0].credentials.push(
			{ name: 'Ledger', type: 'httpBasicAuth', data: { user: 'svc' } },
			{ name: 'Mystery', type: 'noSuchType', data: {} },
		);
		config.projects[0].roles.push({ group: 'sales-operators', role: 'project:operator' });

		const { code, output } = await run(fake, 'apply', config, [], { SALES_CRM_TOKEN: '' });

		assert.equal(code, 1);
		assert.deepEqual(fake.created, []);
		for (const problem of [
			'Two team projects have the name "Finance". Rename one of them in n8n.',
			'Sales / Sales CRM (httpHeaderAuth): set the environment variable SALES_CRM_TOKEN.',
			'Sales / Ledger (httpBasicAuth): data needs password.',
			'Sales / Mystery (noSuchType): n8n has no credential type noSuchType.',
			'n8n has no role project:operator. Create it first.',
		]) {
			assert.ok(output.includes(`! ${problem}`), problem);
		}
		assert.match(output, /Fix the problems before apply\./);
	});
});

describe('apply', () => {
	it('creates the projects, the credentials and the rules once', async () => {
		const fake = new FakeN8n();
		const first = await run(fake, 'apply');

		assert.equal(first.code, 0, first.output);
		assert.match(first.output, /Done\. n8n matches the config\./);
		const sales = fake.projects.find((project) => project.name === 'Sales');
		const finance = fake.projects.find((project) => project.name === 'Finance');
		assert.deepEqual(fake.created, [
			['project', { name: 'Sales', description: 'Workflows of the sales team' }],
			['project', { name: 'Finance' }],
			[
				'credential',
				{
					name: 'Sales CRM',
					type: 'httpHeaderAuth',
					data: { name: 'Authorization', value: SECRET },
					projectId: sales.id,
				},
			],
			[
				'rule',
				{
					expression: groupExpression('groups', 'n8n-admins'),
					role: 'global:admin',
					type: 'instance',
				},
			],
			[
				'rule',
				{
					expression: groupExpression('groups', 'n8n-users'),
					role: 'global:member',
					type: 'instance',
				},
			],
			[
				'rule',
				{
					expression: groupExpression('groups', 'sales-admins'),
					role: 'project:admin',
					type: 'project',
					projectIds: [sales.id],
				},
			],
			[
				'rule',
				{
					expression: groupExpression('groups', 'sales-builders'),
					role: 'project:editor',
					type: 'project',
					projectIds: [sales.id],
				},
			],
			[
				'rule',
				{
					expression: groupExpression('groups', 'finance-viewers'),
					role: 'project:viewer',
					type: 'project',
					projectIds: [finance.id],
				},
			],
		]);

		fake.created = [];
		const second = await run(fake, 'apply');
		assert.equal(second.code, 0);
		assert.deepEqual(fake.created, []);
		assert.match(second.output, /0 changes, 0 problems\./);
	});

	it('puts the rules in the order of the config, before the other rules', async () => {
		const fake = new FakeN8n();
		await run(fake, 'apply');
		const handMade = {
			id: 'hand-1',
			expression: "{{ $claims.department === 'it' }}",
			role: 'global:admin',
			type: 'instance',
			order: 0,
			projectIds: [],
		};
		for (const rule of fake.rules.filter((candidate) => candidate.type === 'instance')) {
			rule.order = rule.role === 'global:member' ? 1 : 2;
		}
		fake.rules.push(handMade);

		const planned = await run(fake, 'plan');
		assert.match(
			planned.output,
			/~ order {3}instance {2}move the rules to the order of the config/,
		);
		assert.match(
			planned.output,
			/\? keep {4}instance {2}\{\{ \$claims\.department === 'it' \}\} → global:admin \(not in the config; --prune-rules deletes it\)/,
		);

		const applied = await run(fake, 'apply');
		assert.equal(applied.code, 0, applied.output);
		const order = fake.rules
			.filter((rule) => rule.type === 'instance')
			.sort((a, b) => a.order - b.order)
			.map((rule) => (rule.id === 'hand-1' ? 'hand-made' : rule.role));
		assert.deepEqual(order, ['global:admin', 'global:member', 'hand-made']);

		const pruned = await run(fake, 'apply', exampleConfig, ['--prune-rules']);
		assert.equal(pruned.code, 0, pruned.output);
		assert.match(
			pruned.output,
			/- deleted {2}instance rule \{\{ \$claims\.department === 'it' \}\} → global:admin/,
		);
		assert.equal(
			fake.rules.some((rule) => rule.id === 'hand-1'),
			false,
		);
	});
});

describe('the default role and the warnings', () => {
	it('gives the default role with a last instance rule that always matches', async () => {
		const fake = new FakeN8n();
		const config = { ...structuredClone(exampleConfig), defaultInstanceRole: 'global:member' };
		config.instanceRoles = [{ group: 'n8n-admins', role: 'global:admin' }];

		const { code, output } = await run(fake, 'apply', config);

		assert.equal(code, 0, output);
		assert.match(output, /\+ create {2}instance {2}everyone else → global:member/);
		const instance = fake.rules
			.filter((rule) => rule.type === 'instance')
			.sort((a, b) => a.order - b.order)
			.map((rule) => [rule.expression, rule.role]);
		assert.deepEqual(instance, [
			[groupExpression('groups', 'n8n-admins'), 'global:admin'],
			[DEFAULT_RULE_EXPRESSION, 'global:member'],
		]);
	});

	it('warns about the team projects without rules and the rules after the default rule', async () => {
		const fake = new FakeN8n({
			projects: [{ id: 'ops', name: 'Operations', type: 'team' }],
			rules: [
				{
					id: 'hand-1',
					expression: "{{ $claims.department === 'it' }}",
					role: 'global:admin',
					type: 'instance',
					order: 0,
					projectIds: [],
				},
			],
		});
		const config = { ...structuredClone(exampleConfig), defaultInstanceRole: 'global:chatUser' };
		config.projects[1].roles = [];

		const { code, output } = await run(fake, 'plan', config);

		assert.equal(code, 0, output);
		assert.match(
			output,
			/Warning: These team projects have no SSO group rule, so SSO users lose their roles in them at the next sign-in: Finance, Operations\./,
		);
		assert.match(
			output,
			/Warning: These instance rules come after the rule of the default role, so they never match: \{\{ \$claims\.department === 'it' \}\} → global:admin\./,
		);

		const pruned = await run(fake, 'plan', config, ['--prune-rules']);
		assert.doesNotMatch(pruned.output, /never match/);
	});

	it('gives no project warning without project rules', async () => {
		const fake = new FakeN8n({ projects: [{ id: 'ops', name: 'Operations', type: 'team' }] });
		const config = structuredClone(exampleConfig);
		for (const project of config.projects) project.roles = [];

		const { output } = await run(fake, 'plan', config);

		assert.doesNotMatch(output, /Warning:/);
	});
});

describe('external secrets', () => {
	const config = structuredClone(exampleConfig);
	config.projects[1].credentials = [
		{
			name: 'Ledger',
			type: 'httpBasicAuth',
			data: { user: 'svc', password: '={{ $secrets.vault.ledger }}' },
		},
	];

	it('warns about the providers of external secrets that a credential uses', async () => {
		const { code, output } = await run(new FakeN8n(), 'plan', config);

		assert.equal(code, 0, output);
		assert.match(
			output,
			/Warning: Finance \/ Ledger \(httpBasicAuth\) uses the external secrets of vault\. n8n refuses the credential when the project cannot use them/,
		);
	});

	it('makes the other changes when n8n refuses a credential, and fails', async () => {
		const fake = new FakeN8n();

		const { code, output } = await run(fake, 'apply', config);

		assert.equal(code, 1);
		assert.match(
			output,
			/! failed {3}credential Finance \/ Ledger: POST \/api\/v1\/credentials answered 400: The secret provider "vault" used in "password" does not exist in this project/,
		);
		assert.match(output, /1 credential failed\. Fix them, then run apply again\./);
		assert.equal(fake.rules.length, 5);
		assert.ok(fake.credentials.some((credential) => credential.name === 'Sales CRM'));
	});
});

describe('check', () => {
	it('passes on a set-up n8n with the limits on', async () => {
		const fake = new FakeN8n();
		await run(fake, 'apply');
		fake.openTriggers = [{ workflowName: 'Partner feed', approved: true }];

		const { code, output } = await run(fake, 'check');

		assert.equal(code, 0, output);
		assert.equal(
			output,
			[
				'Check of https://n8n.example.com/\n',
				'PASS  Users sign in with OIDC.',
				'PASS  Personal spaces cannot publish workflows.',
				'PASS  Personal spaces cannot share workflows and credentials.',
				'PASS  The team projects of the config exist (2).',
				'PASS  The team credentials of the config exist (1).',
				'PASS  The SSO group rules of the config exist (5).',
				'PASS  No open trigger without an approval (1 approved open trigger).',
				'INFO  Owners and admins (2): owner@example.com, ada@example.com.',
			].join('\n'),
		);
	});

	it('fails when the limits are off or the setup is missing', async () => {
		const fake = new FakeN8n({
			method: 'email',
			policy: { personalSpacePublishing: true, sharedPersonalWorkflowsCount: 2 },
		});
		fake.openTriggers = [
			{ workflowName: 'Shop', approved: false },
			{ workflowName: 'Shop', approved: false },
		];

		const { code, output } = await run(fake, 'check');

		assert.equal(code, 1);
		assert.match(output, /WARN {2}Users sign in with email\. Set up SSO \(README\.md\)\./);
		assert.match(output, /FAIL {2}Users can publish workflows from their personal spaces\./);
		assert.match(
			output,
			/WARN {2}2 workflows and 0 credentials shared from personal spaces before the limit\./,
		);
		assert.match(output, /FAIL {2}Missing team projects: Sales; Finance\. Run apply\./);
		assert.match(output, /WARN {2}2 open triggers without an approval, in Shop\./);
	});
});

describe('main', () => {
	it('shows the usage for an unknown command', async () => {
		const lines = [];
		const code = await main(['deploy'], {}, { log: (line) => lines.push(line) });
		assert.equal(code, 2);
		assert.match(lines.join('\n'), /^Usage: node setup\.mjs <plan\|apply\|check>/);
	});

	it('needs the address and the API key', async () => {
		const lines = [];
		const code = await main(
			['plan'],
			{ N8N_URL: 'https://n8n.example.com' },
			{
				log: (line) => lines.push(line),
			},
		);
		assert.equal(code, 2);
		assert.deepEqual(lines, ['Set N8N_URL and N8N_API_KEY.']);
	});

	it('names the route and the status of an API error', async () => {
		const fake = new FakeN8n();
		const failing = async (url, init) =>
			new URL(url).pathname === '/api/v1/role-mapping-rules'
				? new Response(JSON.stringify({ message: 'Provisioning is not licensed' }), { status: 403 })
				: await fake.fetch(url, init);
		const lines = [];
		const code = await main(
			['plan', '--config', await configFile(exampleConfig)],
			{ N8N_URL: 'https://n8n.example.com', N8N_API_KEY: KEY },
			{ log: (line) => lines.push(line), fetchImpl: failing },
		);
		assert.equal(code, 1);
		assert.deepEqual(lines, [
			'Stopped: GET /api/v1/role-mapping-rules answered 403: Provisioning is not licensed',
		]);
	});
});
