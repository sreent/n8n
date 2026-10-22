import {
	CHAT_TRIGGER_NODE_TYPE,
	FORM_TRIGGER_NODE_TYPE,
	MCP_TRIGGER_NODE_TYPE,
	WEBHOOK_NODE_TYPE,
	type INode,
	type INodeParameters,
} from 'n8n-workflow';

import { findOpenTriggers, openTriggerKey } from '../open-trigger.detector';

const node = (
	type: string,
	parameters: INodeParameters = {},
	extra: Partial<INode> = {},
): INode => ({
	id: `${type}-id`,
	name: 'Trigger',
	type,
	typeVersion: 1,
	position: [0, 0],
	parameters,
	...extra,
});

const detect = (nodes: INode[], publicChatDisabled = false) =>
	findOpenTriggers(nodes, { publicChatDisabled });

const kinds = (nodes: INode[], publicChatDisabled = false) =>
	detect(nodes, publicChatDisabled).map((trigger) => trigger.kind);

describe('findOpenTriggers', () => {
	describe('Webhook node', () => {
		it.each(['basicAuth', 'headerAuth', 'jwtAuth', 'bearerAuth', 'n8nOAuth2'])(
			'should not report a webhook with %s',
			(authentication) => {
				expect(kinds([node(WEBHOOK_NODE_TYPE, { authentication })])).toEqual([]);
			},
		);

		it.each([
			['no authentication parameter', {}],
			['authentication none', { authentication: 'none' }],
			['an expression', { authentication: '={{ "headerAuth" }}' }],
			['an unknown value', { authentication: 'apiKey' }],
		])('should report a webhook with %s', (_, parameters: INodeParameters) => {
			expect(kinds([node(WEBHOOK_NODE_TYPE, parameters)])).toEqual(['webhook']);
		});
	});

	describe('Form Trigger node', () => {
		it.each(['basicAuth', 'n8nUserAuth'])('should not report a form with %s', (authentication) => {
			expect(
				kinds([node(FORM_TRIGGER_NODE_TYPE, { authentication }, { typeVersion: 2.6 })]),
			).toEqual([]);
		});

		it('should report a form without authentication', () => {
			expect(
				kinds([node(FORM_TRIGGER_NODE_TYPE, { authentication: 'none' }, { typeVersion: 2.3 })]),
			).toEqual(['form']);
		});

		it('should report a form of version 1, which has no authentication', () => {
			expect(kinds([node(FORM_TRIGGER_NODE_TYPE, { authentication: 'basicAuth' })])).toEqual([
				'form',
			]);
		});
	});

	describe('Chat Trigger node', () => {
		it('should not report a chat that is not public', () => {
			expect(kinds([node(CHAT_TRIGGER_NODE_TYPE, { public: false })])).toEqual([]);
			expect(kinds([node(CHAT_TRIGGER_NODE_TYPE)])).toEqual([]);
		});

		it('should report a public chat without authentication', () => {
			expect(kinds([node(CHAT_TRIGGER_NODE_TYPE, { public: true })])).toEqual(['chat']);
			expect(
				kinds([node(CHAT_TRIGGER_NODE_TYPE, { public: true, authentication: 'none' })]),
			).toEqual(['chat']);
		});

		it('should report a chat whose public parameter is an expression', () => {
			expect(kinds([node(CHAT_TRIGGER_NODE_TYPE, { public: '={{ true }}' })])).toEqual(['chat']);
		});

		it.each(['basicAuth', 'n8nUserAuth'])(
			'should not report a public chat with %s',
			(authentication) => {
				expect(kinds([node(CHAT_TRIGGER_NODE_TYPE, { public: true, authentication })])).toEqual([]);
			},
		);

		it('should not report a chat while the instance turns public chats off', () => {
			expect(kinds([node(CHAT_TRIGGER_NODE_TYPE, { public: true })], true)).toEqual([]);
		});
	});

	describe('MCP Server Trigger node', () => {
		it.each(['bearerAuth', 'headerAuth', 'n8nOAuth2'])(
			'should not report an MCP server with %s',
			(authentication) => {
				expect(kinds([node(MCP_TRIGGER_NODE_TYPE, { authentication })])).toEqual([]);
			},
		);

		it('should report an MCP server without authentication', () => {
			expect(kinds([node(MCP_TRIGGER_NODE_TYPE, { authentication: 'none' })])).toEqual(['mcp']);
		});
	});

	it('should skip disabled nodes and the nodes of other types', () => {
		expect(
			kinds([
				node(WEBHOOK_NODE_TYPE, {}, { disabled: true }),
				node('n8n-nodes-base.githubTrigger'),
				node('n8n-nodes-base.scheduleTrigger'),
			]),
		).toEqual([]);
	});

	it('should give the node, its version and its path', () => {
		expect(
			detect([
				node(WEBHOOK_NODE_TYPE, { path: 'orders' }, { id: 'n1', name: 'Orders', typeVersion: 2 }),
			]),
		).toEqual([
			{
				nodeId: 'n1',
				nodeName: 'Orders',
				nodeType: WEBHOOK_NODE_TYPE,
				typeVersion: 2,
				kind: 'webhook',
				path: 'orders',
			},
		]);
	});

	it('should read the path from the options of a form, then fall back to the webhook id', () => {
		const [fromOptions, fromWebhookId] = detect([
			node(FORM_TRIGGER_NODE_TYPE, { options: { path: 'feedback' } }, { typeVersion: 2.6 }),
			node(CHAT_TRIGGER_NODE_TYPE, { public: true }, { webhookId: 'abc-123' }),
		]);
		expect(fromOptions.path).toBe('feedback');
		expect(fromWebhookId.path).toBe('abc-123');
	});

	it('should give no path for an expression', () => {
		const [trigger] = detect([node(WEBHOOK_NODE_TYPE, { path: '={{ $vars.path }}' })]);
		expect(trigger.path).toBeNull();
	});
});

describe('openTriggerKey', () => {
	it('should join the node id and the node type', () => {
		expect(openTriggerKey({ nodeId: 'n1', nodeType: WEBHOOK_NODE_TYPE })).toBe(
			`n1:${WEBHOOK_NODE_TYPE}`,
		);
	});
});
