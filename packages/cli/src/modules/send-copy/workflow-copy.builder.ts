import type { IConnections, INode, IWorkflowGroup, IWorkflowSettings } from 'n8n-workflow';
import { isExpression } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import { SENDER_BOUND_SETTINGS, WORKFLOW_NAME_MAX_LENGTH } from './send-copy.constants';

/** Fields of the original workflow that the copy needs. */
export interface WorkflowCopySource {
	id: string;
	name: string;
	description?: string | null;
	nodes: INode[];
	connections: IConnections;
	settings?: IWorkflowSettings | null;
	nodeGroups?: IWorkflowGroup[] | null;
	tags?: Array<{ id: string }> | null;
}

/** The user who sends the copy. */
export interface CopySender {
	firstName?: string | null;
	lastName?: string | null;
	email: string;
}

/** The data for the new workflow of one recipient. */
export interface WorkflowCopy {
	name: string;
	description: string;
	nodes: INode[];
	connections: IConnections;
	settings: IWorkflowSettings;
	nodeGroups: IWorkflowGroup[];
	tagIds: string[];
}

const ELLIPSIS = '…';

/** Returns the name of the sender, or the email when the user has no name. */
export function senderLabel(sender: CopySender): string {
	const name = [sender.firstName, sender.lastName]
		.map((part) => part?.trim())
		.filter(Boolean)
		.join(' ');
	return name || sender.email;
}

/** Cuts `text` to `max` characters. Counts code points, so emoji stay whole. */
function truncate(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	return chars.slice(0, max - 1).join('') + ELLIPSIS;
}

/**
 * Builds the copy name `<original> (from <sender>)`. Cuts the original part first,
 * so the sender part stays readable, and keeps the result in the column length.
 */
export function buildCopyName(originalName: string, sender: CopySender): string {
	const suffix = ` (from ${senderLabel(sender)})`;
	const suffixLength = Array.from(suffix).length;
	const room = WORKFLOW_NAME_MAX_LENGTH - suffixLength;

	// A very long sender name leaves no room for the original name.
	if (room < 2) return truncate(`${originalName}${suffix}`, WORKFLOW_NAME_MAX_LENGTH);

	return `${truncate(originalName, room)}${suffix}`;
}

function buildDescription(source: WorkflowCopySource, sender: CopySender, sentAt: Date): string {
	const date = sentAt.toISOString().slice(0, 10);
	const origin = `Copy of "${source.name}" (workflow ${source.id}) sent by ${senderLabel(sender)} <${sender.email}> on ${date}.`;
	const original = source.description?.trim();
	return original ? `${origin}\n\n${original}` : origin;
}

/**
 * Copies the nodes without credentials. Gives webhook nodes a new webhook ID, so
 * the copy does not use the same webhook URLs as the original workflow.
 */
function copyNodes(nodes: INode[], newId: () => string): INode[] {
	return structuredClone(nodes).map((node) => {
		delete node.credentials;

		if (node.webhookId) {
			node.webhookId = newId();
			// Some triggers get the path from the node description and have no `path` parameter.
			if ('path' in node.parameters && !isExpression(node.parameters.path)) {
				node.parameters.path = node.webhookId;
			}
		}

		return node;
	});
}

function copySettings(settings: IWorkflowSettings | null | undefined): IWorkflowSettings {
	const copy: IWorkflowSettings = structuredClone(settings ?? {});
	for (const key of SENDER_BOUND_SETTINGS) {
		delete copy[key];
	}
	return copy;
}

/**
 * Builds an independent copy of a workflow for one recipient.
 *
 * The copy keeps only an allow-list of fields. It does not keep credentials, pinned
 * data, static data, metadata, versions, the publish state, the folder, the sharing,
 * or `sourceWorkflowId`. Package import uses `sourceWorkflowId` to match workflows,
 * so a copy must not claim the identity of the original.
 */
export function buildWorkflowCopy(
	source: WorkflowCopySource,
	sender: CopySender,
	sentAt: Date,
	newId: () => string = uuid,
): WorkflowCopy {
	return {
		name: buildCopyName(source.name, sender),
		description: buildDescription(source, sender, sentAt),
		nodes: copyNodes(source.nodes, newId),
		connections: structuredClone(source.connections),
		settings: copySettings(source.settings),
		nodeGroups: structuredClone(source.nodeGroups ?? []),
		tagIds: (source.tags ?? []).map((tag) => tag.id),
	};
}
