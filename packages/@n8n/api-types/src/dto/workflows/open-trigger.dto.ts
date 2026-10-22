// Fork code (not in upstream n8n): the open triggers of published workflows, in the REST API
// (`/rest/open-triggers`) and in the public API (`/api/v1/inventory/open-triggers`), and the
// violation of the publish check. See packages/cli/src/modules/open-triggers/README.md.
import '../../openapi-extend';

import { z } from 'zod';

import { openTriggerFieldDocs, openTriggerQueryFieldDocs } from './open-trigger.openapi';
import { Z } from '../../zod-class';

/** The `kind` of the policy violation for a trigger without authentication. */
export const OPEN_TRIGGER_VIOLATION_KIND = 'open-trigger';

/** The id of the policy check of open triggers. */
export const OPEN_TRIGGER_CHECK_ID = 'open-triggers';

/** The triggers that the check reads: the Webhook, Form, Chat and MCP Server Trigger nodes. */
export const OPEN_TRIGGER_KINDS = ['webhook', 'form', 'chat', 'mcp'] as const;

export type OpenTriggerKind = (typeof OPEN_TRIGGER_KINDS)[number];

export const MAX_OPEN_TRIGGER_PAGE_SIZE = 250;

export class OpenTriggerQueryPublicDto extends Z.class({
	projectId: z
		.string()
		.trim()
		.min(1)
		.max(36)
		.optional()
		.openapi(openTriggerQueryFieldDocs.projectId),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_OPEN_TRIGGER_PAGE_SIZE)
		.default(100)
		.openapi(openTriggerQueryFieldDocs.limit),
	cursor: z.string().optional(),
}) {}

const docs = openTriggerFieldDocs;

export const openTriggerItemSchema = z.object({
	workflowId: z.string(),
	workflowName: z.string(),
	homeProject: z
		.object({
			id: z.string(),
			name: z.string(),
			type: z.string().openapi({ example: 'team' }),
		})
		.nullable()
		.openapi(docs.homeProject),
	owner: z
		.object({
			id: z.string(),
			email: z.string().nullable(),
			firstName: z.string().nullable(),
			lastName: z.string().nullable(),
		})
		.nullable()
		.openapi(docs.owner),
	nodeId: z.string(),
	nodeName: z.string(),
	nodeType: z.string().openapi({ example: 'n8n-nodes-base.webhook' }),
	typeVersion: z.number(),
	kind: z.enum(OPEN_TRIGGER_KINDS).openapi(docs.kind),
	path: z.string().nullable().openapi(docs.path),
	approved: z.boolean().openapi(docs.approved),
});

export type OpenTriggerItem = z.infer<typeof openTriggerItemSchema>;

export class OpenTriggerListPublicDto extends Z.class({
	data: z.array(openTriggerItemSchema),
	nextCursor: z.string().nullable().openapi(docs.nextCursor),
}) {}
