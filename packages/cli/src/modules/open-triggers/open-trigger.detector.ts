import {
	openTriggerKindOf,
	type OpenTriggerKind,
	type OpenTriggerKindOptions,
} from '@n8n/api-types';
import { isRecord } from '@n8n/utils/is-record';
import type { INode } from 'n8n-workflow';

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

/** The rule itself is in `@n8n/api-types`, so the editor uses the same one. */
export type OpenTriggerDetectorOptions = OpenTriggerKindOptions;

const isExpression = (value: unknown): value is string =>
	typeof value === 'string' && value.startsWith('=');

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
		const kind = openTriggerKindOf(node, options);
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
