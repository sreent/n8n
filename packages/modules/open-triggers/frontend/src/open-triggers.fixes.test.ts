import {
	CHAT_TRIGGER_NODE_TYPE,
	FORM_TRIGGER_NODE_TYPE,
	MCP_TRIGGER_NODE_TYPE,
	WEBHOOK_NODE_TYPE,
} from 'n8n-workflow';

import { createTriggerToken, openTriggerFixFor } from './open-triggers.fixes';

describe('openTriggerFixFor', () => {
	it.each([
		[WEBHOOK_NODE_TYPE, 2.2, 'headerAuth'],
		[MCP_TRIGGER_NODE_TYPE, 2.1, 'bearerAuth'],
		[CHAT_TRIGGER_NODE_TYPE, 1.1, 'signIn'],
		[FORM_TRIGGER_NODE_TYPE, 2.6, 'signIn'],
		[FORM_TRIGGER_NODE_TYPE, 2.5, null],
		[FORM_TRIGGER_NODE_TYPE, 1, null],
		['n8n-nodes-base.githubTrigger', 1, null],
	])('gives the fix of %s version %s', (type, typeVersion, fix) => {
		expect(openTriggerFixFor({ type, typeVersion })).toBe(fix);
	});
});

describe('createTriggerToken', () => {
	it('gives 32 random bytes in base64url', () => {
		const token = createTriggerToken();

		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(createTriggerToken()).not.toBe(token);
	});
});
