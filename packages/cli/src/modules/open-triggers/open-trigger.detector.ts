import type { OpenTriggerKind } from '@n8n/api-types';
import { isRecord } from '@n8n/utils/is-record';
import {
	CHAT_TRIGGER_NODE_TYPE,
	FORM_TRIGGER_NODE_TYPE,
	MCP_TRIGGER_NODE_TYPE,
	WEBHOOK_NODE_TYPE,
	type INode,
} from 'n8n-workflow';

/** A trigger node that accepts calls from anyone, without authentication or sign-in. */
export interface OpenTrigger {
	nodeId: string;
	nodeName: string;
	nodeType: string;
	typeVersion: number;
	kind: OpenTriggerKind;
	/** The path of the URL, the webhook id when the path is empty, or null for an expression. */
	path: string | null;
}

export interface OpenTriggerDetectorOptions {
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

const isExpression = (value: unknown): value is string =>
	typeof value === 'string' && value.startsWith('=');

/** A missing value is the default of the node, `none`. An expression is never a known value. */
function hasAuthentication(node: INode, known: ReadonlySet<string>): boolean {
	const value = node.parameters?.authentication;
	return typeof value === 'string' && known.has(value);
}

function isPublicChat(node: INode): boolean {
	const value = node.parameters?.public;
	// An expression can resolve to true, so it counts as public.
	return value === true || isExpression(value);
}

function kindOf(node: INode, options: OpenTriggerDetectorOptions): OpenTriggerKind | null {
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

function pathOf(node: INode): string | null {
	const options: unknown = node.parameters?.options;
	const optionPath = isRecord(options) ? options.path : undefined;
	const path = [node.parameters?.path, optionPath].find(
		(value) => typeof value === 'string' && value !== '',
	);
	if (path === undefined) return node.webhookId ?? null;
	return isExpression(path) ? null : String(path);
}

/**
 * The enabled triggers of the Webhook, Form Trigger, public Chat Trigger and MCP Server Trigger
 * nodes that accept calls without authentication or sign-in. Other trigger nodes register their
 * webhook with their own service, and the check does not read them.
 */
export function findOpenTriggers(
	nodes: readonly INode[],
	options: OpenTriggerDetectorOptions,
): OpenTrigger[] {
	const open: OpenTrigger[] = [];
	for (const node of nodes) {
		if (node.disabled === true) continue;
		const kind = kindOf(node, options);
		if (kind === null) continue;
		open.push({
			nodeId: node.id,
			nodeName: node.name,
			nodeType: node.type,
			typeVersion: node.typeVersion,
			kind,
			path: pathOf(node),
		});
	}
	return open;
}

/**
 * The key of an open trigger for an approval. An approval covers the node while it keeps its id
 * and its type, and while it stays open: a change of its path or of the rest of the workflow does
 * not need a new approval.
 */
export const openTriggerKey = (trigger: Pick<OpenTrigger, 'nodeId' | 'nodeType'>) =>
	`${trigger.nodeId}:${trigger.nodeType}`;
