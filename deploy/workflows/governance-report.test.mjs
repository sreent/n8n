// Tests governance-report.json: the connections of the nodes, and the code of the node
// "Build report" with made-up answers of the public API.
// Run: node --test deploy/workflows/governance-report.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const workflow = JSON.parse(
	fs.readFileSync(new URL('./governance-report.json', import.meta.url), 'utf8'),
);
const nodeNamed = (name) => workflow.nodes.find((node) => node.name === name);

const DAY = 24 * 60 * 60 * 1000;
const old = '2026-01-01T00:00:00.000Z';
const recent = new Date(Date.now() - 2 * DAY).toISOString();

/** Runs the code of "Build report" with the given outputs of the other nodes. */
function buildReport(outputs) {
	const $ = (name) => ({ all: () => outputs[name], first: () => outputs[name][0] });
	const run = new Function('$', nodeNamed('Build report').parameters.jsCode);
	return run($)[0].json;
}

const settings = [
	{
		json: {
			baseUrl: 'https://n8n.example.com/api/v1/',
			inactiveDays: 90,
			unusedKeyDays: 90,
			pendingInviteDays: 14,
		},
	},
];

const workflowItem = (fields) => ({
	status: 'published',
	hasUnpublishedChanges: false,
	homeProject: { type: 'team', name: 'Finance' },
	owner: null,
	recentExecutions: [],
	...fields,
});

const outputs = {
	Settings: settings,
	// Two pages.
	'Get workflows': [
		{
			json: {
				data: [
					workflowItem({
						id: 'w1',
						name: 'Mine <b>',
						homeProject: { type: 'personal', name: 'Mia' },
						owner: { email: 'mia@example.com' },
					}),
					workflowItem({
						id: 'w2',
						name: 'Invoices',
						hasUnpublishedChanges: true,
						recentExecutions: [{ status: 'error' }, { status: 'crashed' }, { status: 'success' }],
					}),
				],
				nextCursor: 'next',
			},
		},
		{
			json: {
				data: [
					workflowItem({
						id: 'w3',
						name: 'Draft',
						status: 'unpublished',
						recentExecutions: [{ status: 'error' }],
					}),
				],
				nextCursor: null,
			},
		},
	],
	'Get API keys': [
		{
			json: {
				data: [
					{ label: 'Old', user: { email: 'olive@example.com' }, expired: true, expiresAt: old, lastUsedAt: null, createdAt: old },
					{ label: 'Unused', user: { email: 'olive@example.com' }, expired: false, expiresAt: null, lastUsedAt: null, createdAt: old },
					{ label: 'New', user: { email: 'mia@example.com' }, expired: false, expiresAt: null, lastUsedAt: null, createdAt: recent },
					{ label: 'Used', user: { email: 'mia@example.com' }, expired: false, expiresAt: null, lastUsedAt: recent, createdAt: old },
				],
				nextCursor: null,
			},
		},
	],
	'Get users': [
		{
			json: {
				data: [
					{ email: 'gone@example.com', isPending: false, lastActiveAt: '2026-02-01', createdAt: old },
					{ email: 'new@example.com', isPending: false, lastActiveAt: null, createdAt: recent },
					{ email: 'active@example.com', isPending: false, lastActiveAt: recent.slice(0, 10), createdAt: old },
					{ email: 'invited@example.com', isPending: true, lastActiveAt: null, createdAt: old },
					{ email: 'just-invited@example.com', isPending: true, lastActiveAt: null, createdAt: recent },
				],
				nextCursor: null,
			},
		},
	],
};

test('the nodes run in order, and the API nodes read all pages with an n8n API credential', () => {
	const next = (name) => workflow.connections[name].main[0].map((link) => link.node);
	assert.deepEqual(next('Every Monday at 08:00'), ['Settings']);
	assert.deepEqual(next('Settings'), ['Get workflows']);
	assert.deepEqual(next('Get workflows'), ['Get API keys']);
	assert.deepEqual(next('Get API keys'), ['Get users']);
	assert.deepEqual(next('Get users'), ['Build report']);
	assert.deepEqual(next('Build report'), ['Send email']);

	for (const name of ['Get workflows', 'Get API keys', 'Get users']) {
		const { parameters } = nodeNamed(name);
		assert.equal(parameters.nodeCredentialType, 'n8nApi', name);
		assert.equal(parameters.options.pagination.pagination.completeExpression, '={{ !$response.body.nextCursor }}', name);
	}
	// The later API nodes run once, not once for each page of the node before them.
	assert.equal(nodeNamed('Get API keys').executeOnce, true);
	assert.equal(nodeNamed('Get users').executeOnce, true);
	// The template holds no credentials.
	assert.ok(workflow.nodes.every((node) => node.credentials === undefined));
});

test('lists each finding in its section', () => {
	const report = buildReport(outputs);
	const sections = Object.fromEntries(
		report.sections.map((section) => [section.title, section.entries.map((entry) => entry.text)]),
	);

	assert.deepEqual(sections, {
		'Published workflows in personal spaces': ['Mine <b> (personal space of mia@example.com)'],
		'Published workflows with failed executions': [
			'Invoices (project Finance, 2 of the last 3 executions failed)',
		],
		'Published workflows with unpublished changes': ['Invoices (project Finance)'],
		'Expired API keys': ['Old of olive@example.com (expired 2026-01-01)'],
		'API keys not used for 90 days': ['Unused of olive@example.com (last use never)'],
		'Users not active for 90 days': ['gone@example.com (last active 2026-02-01)'],
		'Invitations open for more than 14 days': ['invited@example.com (invited 2026-01-01)'],
	});
	assert.equal(report.findings, 7);
	assert.deepEqual(report.summary, {
		workflows: 3,
		publishedWorkflows: 2,
		workflowsInPersonalSpaces: 1,
		apiKeys: 4,
		users: 3,
		pendingInvitations: 2,
	});
	assert.match(report.subject, /^n8n governance report \d{4}-\d{2}-\d{2}: 7 findings$/);
});

test('escapes HTML, and links to the workflows without /api/v1', () => {
	const report = buildReport(outputs);

	assert.ok(report.html.includes('Mine &lt;b&gt;'));
	assert.ok(!report.html.includes('Mine <b>'));
	assert.ok(report.html.includes('<a href="https://n8n.example.com/workflow/w1">'));
	assert.ok(report.text.includes('- Invoices (project Finance) https://n8n.example.com/workflow/w2'));
});

test('shows at most 50 entries of a section in the email', () => {
	const many = Array.from({ length: 60 }, (_, i) =>
		workflowItem({ id: `p${i}`, name: `Flow ${i}`, homeProject: { type: 'personal' } }),
	);
	const report = buildReport({
		...outputs,
		'Get workflows': [{ json: { data: many, nextCursor: null } }],
	});

	assert.equal(report.sections[0].entries.length, 60);
	assert.ok(report.text.includes('- and 10 more'));
	assert.ok(report.html.includes('<li>and 10 more</li>'));
});

test('uses one and many in the overview', () => {
	const report = buildReport({
		...outputs,
		'Get API keys': [{ json: { data: [outputs['Get API keys'][0].json.data[3]], nextCursor: null } }],
	});

	assert.ok(report.text.includes('\n1 API key\n'));
	assert.ok(report.text.includes('3 users and 2 open invitations'));
});
