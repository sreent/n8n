import type { INode } from 'n8n-workflow';

import { WORKFLOW_NAME_MAX_LENGTH } from '../send-copy.constants';
import {
	buildCopyName,
	buildWorkflowCopy,
	senderLabel,
	type WorkflowCopySource,
} from '../workflow-copy.builder';

const sender = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };
const sentAt = new Date('2026-10-01T12:00:00.000Z');

const makeNode = (overrides: Partial<INode> = {}): INode => ({
	id: 'node-1',
	name: 'Node',
	type: 'n8n-nodes-base.set',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
	...overrides,
});

const makeSource = (overrides: Partial<WorkflowCopySource> = {}): WorkflowCopySource => ({
	id: 'wf-1',
	name: 'Daily report',
	description: null,
	nodes: [makeNode()],
	connections: {},
	settings: {},
	nodeGroups: [],
	tags: [],
	...overrides,
});

let idCounter = 0;
const nextId = () => `new-id-${++idCounter}`;

beforeEach(() => {
	idCounter = 0;
});

describe('senderLabel', () => {
	it('uses the first and last name', () => {
		expect(senderLabel(sender)).toBe('Ada Lovelace');
	});

	it('uses the email when the user has no name', () => {
		expect(senderLabel({ firstName: '', lastName: null, email: 'x@example.com' })).toBe(
			'x@example.com',
		);
	});
});

describe('buildCopyName', () => {
	it('adds the sender to the name', () => {
		expect(buildCopyName('Daily report', sender)).toBe('Daily report (from Ada Lovelace)');
	});

	it('cuts a long original name and keeps the sender part', () => {
		const name = buildCopyName('x'.repeat(200), sender);
		expect(Array.from(name)).toHaveLength(WORKFLOW_NAME_MAX_LENGTH);
		expect(name.endsWith('… (from Ada Lovelace)')).toBe(true);
	});

	it('counts emoji as one character', () => {
		const name = buildCopyName('🚀'.repeat(200), sender);
		expect(Array.from(name)).toHaveLength(WORKFLOW_NAME_MAX_LENGTH);
		// No emoji is cut in half.
		expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it('stays in the column length when the sender name is very long', () => {
		const name = buildCopyName('Report', { firstName: 'y'.repeat(300), email: 'y@example.com' });
		expect(Array.from(name)).toHaveLength(WORKFLOW_NAME_MAX_LENGTH);
	});
});

describe('buildWorkflowCopy', () => {
	it('removes credentials from the nodes and keeps the original intact', () => {
		const source = makeSource({
			nodes: [
				makeNode({
					credentials: { httpBasicAuth: { id: 'cred-1', name: 'Secret' } },
					parameters: { url: 'https://example.com' },
				}),
			],
		});

		const copy = buildWorkflowCopy(source, sender, sentAt, nextId);

		expect(copy.nodes[0].credentials).toBeUndefined();
		expect(copy.nodes[0].parameters).toEqual({ url: 'https://example.com' });
		expect(source.nodes[0].credentials).toEqual({
			httpBasicAuth: { id: 'cred-1', name: 'Secret' },
		});
	});

	it('gives webhook nodes a new webhook ID and a new static path', () => {
		const source = makeSource({
			nodes: [makeNode({ name: 'Webhook', webhookId: 'old-id', parameters: { path: 'my-hook' } })],
		});

		const [node] = buildWorkflowCopy(source, sender, sentAt, nextId).nodes;

		expect(node.webhookId).toBe('new-id-1');
		expect(node.parameters.path).toBe('new-id-1');
	});

	it('keeps a webhook path that is an expression', () => {
		const source = makeSource({
			nodes: [
				makeNode({
					webhookId: 'old-id',
					parameters: { path: '={{ $env.HOOK_PATH }}' },
				}),
			],
		});

		const [node] = buildWorkflowCopy(source, sender, sentAt, nextId).nodes;

		expect(node.webhookId).toBe('new-id-1');
		expect(node.parameters.path).toBe('={{ $env.HOOK_PATH }}');
	});

	it('does not add a path to a trigger that has no path parameter', () => {
		const source = makeSource({
			nodes: [makeNode({ webhookId: 'old-id', parameters: { event: 'card.created' } })],
		});

		const [node] = buildWorkflowCopy(source, sender, sentAt, nextId).nodes;

		expect(node.parameters).toEqual({ event: 'card.created' });
	});

	it('removes the settings that point to resources of the sender', () => {
		const source = makeSource({
			settings: {
				timezone: 'Europe/Berlin',
				executionTimeout: 60,
				errorWorkflow: 'wf-error',
				callerIds: 'a,b',
				callerPolicy: 'workflowsFromAList',
				credentialResolverId: 'resolver-1',
				availableInMCP: true,
			},
		});

		const copy = buildWorkflowCopy(source, sender, sentAt, nextId);

		expect(copy.settings).toEqual({ timezone: 'Europe/Berlin', executionTimeout: 60 });
	});

	it('keeps the tags and the connections', () => {
		const connections = {
			Node: { main: [[{ node: 'Other', type: 'main' as const, index: 0 }]] },
		};
		const source = makeSource({ connections, tags: [{ id: 'tag-1' }, { id: 'tag-2' }] });

		const copy = buildWorkflowCopy(source, sender, sentAt, nextId);

		expect(copy.tagIds).toEqual(['tag-1', 'tag-2']);
		expect(copy.connections).toEqual(connections);
		expect(copy.connections).not.toBe(connections);
	});

	it('records the origin in the description and keeps the original description', () => {
		const copy = buildWorkflowCopy(
			makeSource({ description: 'Sends the report.' }),
			sender,
			sentAt,
			nextId,
		);

		expect(copy.description).toBe(
			'Copy of "Daily report" (workflow wf-1) sent by Ada Lovelace <ada@example.com> on 2026-10-01.\n\nSends the report.',
		);
	});

	it('copies only the allowed fields', () => {
		const source = {
			...makeSource(),
			pinData: { Node: [{ json: { secret: true } }] },
			staticData: { lastId: 5 },
			meta: { templateId: 't-1' },
			sourceWorkflowId: 'origin',
			versionId: 'v-1',
			active: true,
		};

		const copy = buildWorkflowCopy(source, sender, sentAt, nextId);

		expect(Object.keys(copy).sort()).toEqual(
			['connections', 'description', 'name', 'nodeGroups', 'nodes', 'settings', 'tagIds'].sort(),
		);
	});
});
