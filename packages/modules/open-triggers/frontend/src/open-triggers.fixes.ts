import type { BaseTextKey } from '@n8n/i18n';
import {
	CHAT_TRIGGER_NODE_TYPE,
	FORM_TRIGGER_NODE_TYPE,
	MCP_TRIGGER_NODE_TYPE,
	WEBHOOK_NODE_TYPE,
} from 'n8n-workflow';

/**
 * The one-click fix of an open trigger:
 *
 * - `signIn`: the n8n User Auth of forms and chats. Users sign in to n8n.
 * - `headerAuth`: a new Header Auth credential with a random token for a webhook.
 * - `bearerAuth`: a new Bearer Auth credential with a random token for an MCP server.
 */
export type OpenTriggerFix = 'signIn' | 'headerAuth' | 'bearerAuth';

/** The label of the button of each fix. */
export const OPEN_TRIGGER_FIX_LABEL_KEYS: Record<OpenTriggerFix, BaseTextKey> = {
	signIn: 'openTriggers.fixes.signIn',
	headerAuth: 'openTriggers.fixes.headerAuth',
	bearerAuth: 'openTriggers.fixes.bearerAuth',
};

/** The token of a new credential. The editor shows it once. */
export interface OpenTriggerSecret {
	header: string;
	value: string;
}

export interface OpenTriggerFixResult {
	secret?: OpenTriggerSecret;
}

/** An open trigger in the modal, made from a policy violation and the node on the canvas. */
export interface OpenTriggerFixItem {
	nodeId: string;
	nodeName: string;
	message: string;
	/** Null when the node has no one-click fix, for example a Form Trigger before version 2.6. */
	fix: OpenTriggerFix | null;
}

/** The data of the modal of the fixes. */
export type OpenTriggerFixesModalData = {
	workflowId: string;
	items: OpenTriggerFixItem[];
	/** The messages of the other policy violations of the same publish. */
	otherMessages: string[];
	/** Whether workflow reviews are on, so that a review can approve the open triggers. */
	canRequestApproval: boolean;
};

/** The first version of the Form Trigger with n8n User Auth. */
const FORM_SIGN_IN_VERSION = 2.6;

/** The fix that the editor can apply to a node, or null. */
export function openTriggerFixFor(node: {
	type: string;
	typeVersion: number;
}): OpenTriggerFix | null {
	switch (node.type) {
		case WEBHOOK_NODE_TYPE:
			return 'headerAuth';
		case FORM_TRIGGER_NODE_TYPE:
			return node.typeVersion >= FORM_SIGN_IN_VERSION ? 'signIn' : null;
		case CHAT_TRIGGER_NODE_TYPE:
			return 'signIn';
		case MCP_TRIGGER_NODE_TYPE:
			return 'bearerAuth';
		default:
			return null;
	}
}

/** A random token of 32 bytes in base64url, for a new credential. */
export function createTriggerToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
