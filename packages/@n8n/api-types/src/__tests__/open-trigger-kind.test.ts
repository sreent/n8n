import { openTriggerKindOf } from '../utils/open-trigger-kind';

const options = { publicChatDisabled: false };

describe('openTriggerKindOf', () => {
	it.each([
		['a webhook without authentication', 'n8n-nodes-base.webhook', 2, {}, 'webhook'],
		[
			'a webhook with header authentication',
			'n8n-nodes-base.webhook',
			2,
			{ authentication: 'headerAuth' },
			null,
		],
		[
			'a webhook with an expression as authentication',
			'n8n-nodes-base.webhook',
			2,
			{ authentication: '={{ $json.auth }}' },
			'webhook',
		],
		[
			'a form of version 1',
			'n8n-nodes-base.formTrigger',
			1,
			{ authentication: 'basicAuth' },
			'form',
		],
		[
			'a form with n8n sign-in',
			'n8n-nodes-base.formTrigger',
			2.6,
			{ authentication: 'n8nUserAuth' },
			null,
		],
		['a public chat', '@n8n/n8n-nodes-langchain.chatTrigger', 1.1, { public: true }, 'chat'],
		['a chat that is not public', '@n8n/n8n-nodes-langchain.chatTrigger', 1.1, {}, null],
		['an MCP server without authentication', '@n8n/n8n-nodes-langchain.mcpTrigger', 2, {}, 'mcp'],
		['another node', 'n8n-nodes-base.set', 3, {}, null],
	])('gives the kind of %s', (_label, type, typeVersion, parameters, kind) => {
		expect(openTriggerKindOf({ type, typeVersion, parameters }, options)).toBe(kind);
	});

	it('finds no public chat when the instance turns public chats off', () => {
		expect(
			openTriggerKindOf(
				{
					type: '@n8n/n8n-nodes-langchain.chatTrigger',
					typeVersion: 1.1,
					parameters: { public: true },
				},
				{ publicChatDisabled: true },
			),
		).toBeNull();
	});
});
