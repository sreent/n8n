// Fork code (not in upstream n8n): the rule of the open-triggers module, shared by the backend
// check and the editor. See packages/cli/src/modules/open-triggers/README.md.
import {
	CHAT_TRIGGER_NODE_TYPE,
	FORM_TRIGGER_NODE_TYPE,
	MCP_TRIGGER_NODE_TYPE,
	WEBHOOK_NODE_TYPE,
	type INode,
} from 'n8n-workflow';

import type { OpenTriggerKind } from '../dto/workflows/open-trigger.dto';

export interface OpenTriggerKindOptions {
	/** `N8N_DISABLE_PUBLIC_CHAT_TRIGGER`: no chat is public on this instance. */
	publicChatDisabled: boolean;
}

/**
 * The values of `authentication` that the shared webhook check of n8n-nodes-base verifies. It
 * lets each other value through without a check, so only these values close a trigger.
 */
const SHARED_AUTHENTICATION = ['basicAuth', 'bearerAuth', 'headerAuth', 'jwtAuth'];

const WEBHOOK_AUTHENTICATION = new Set([...SHARED_AUTHENTICATION, 'n8nOAuth2']);
const FORM_AUTHENTICATION = new Set([...SHARED_AUTHENTICATION, 'n8nUserAuth']);
const CHAT_AUTHENTICATION = new Set(['basicAuth', 'n8nUserAuth']);
const MCP_AUTHENTICATION = new Set([...SHARED_AUTHENTICATION, 'n8nOAuth2']);

type TriggerNode = Pick<INode, 'type' | 'typeVersion' | 'parameters'>;

const isExpression = (value: unknown): value is string =>
	typeof value === 'string' && value.startsWith('=');

/** A missing value is the default of the node, `none`. An expression is never a known value. */
function hasAuthentication(node: TriggerNode, known: ReadonlySet<string>): boolean {
	const value = node.parameters?.authentication;
	return typeof value === 'string' && known.has(value);
}

function isPublicChat(node: TriggerNode): boolean {
	const value = node.parameters?.public;
	// An expression can resolve to true, so it counts as public.
	return value === true || isExpression(value);
}

/**
 * The kind of a Webhook, Form Trigger, public Chat Trigger or MCP Server Trigger node that accepts
 * calls without authentication or sign-in, or null for any other node.
 */
export function openTriggerKindOf(
	node: TriggerNode,
	options: OpenTriggerKindOptions,
): OpenTriggerKind | null {
	switch (node.type) {
		case WEBHOOK_NODE_TYPE:
			return hasAuthentication(node, WEBHOOK_AUTHENTICATION) ? null : 'webhook';
		case FORM_TRIGGER_NODE_TYPE:
			// Version 1 has no authentication.
			return node.typeVersion > 1 && hasAuthentication(node, FORM_AUTHENTICATION) ? null : 'form';
		case CHAT_TRIGGER_NODE_TYPE:
			// A chat that is not public answers 404 to each call outside the editor.
			if (options.publicChatDisabled || !isPublicChat(node)) return null;
			return hasAuthentication(node, CHAT_AUTHENTICATION) ? null : 'chat';
		case MCP_TRIGGER_NODE_TYPE:
			return hasAuthentication(node, MCP_AUTHENTICATION) ? null : 'mcp';
		default:
			return null;
	}
}
