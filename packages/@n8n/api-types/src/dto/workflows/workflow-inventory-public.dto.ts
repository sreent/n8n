// Fork code (not in upstream n8n): the inventory of workflows in the public API
// (`/api/v1/inventory/workflows`). See packages/cli/src/governance/README.md.
import '../../openapi-extend';

import { z } from 'zod';

import {
	workflowInventoryFieldDocs,
	workflowInventoryQueryFieldDocs,
} from './workflow-inventory-public.openapi';
import { Z } from '../../zod-class';

export const MAX_INVENTORY_PAGE_SIZE = 100;
export const MAX_INVENTORY_EXECUTIONS = 20;

export class WorkflowInventoryQueryPublicDto extends Z.class({
	projectId: z
		.string()
		.trim()
		.min(1)
		.max(36)
		.optional()
		.openapi(workflowInventoryQueryFieldDocs.projectId),
	executions: z.coerce
		.number()
		.int()
		.min(0)
		.max(MAX_INVENTORY_EXECUTIONS)
		.default(5)
		.openapi(workflowInventoryQueryFieldDocs.executions),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_INVENTORY_PAGE_SIZE)
		.default(50)
		.openapi(workflowInventoryQueryFieldDocs.limit),
	cursor: z.string().optional(),
}) {}

const docs = workflowInventoryFieldDocs;

const projectSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string().openapi({ example: 'personal' }),
});

export const workflowInventoryItemPublicSchema = z.object({
	id: z.string(),
	name: z.string(),
	status: z.enum(['published', 'unpublished', 'archived']).openapi(docs.status),
	hasUnpublishedChanges: z.boolean().openapi(docs.hasUnpublishedChanges),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	tags: z.array(z.string()),
	homeProject: projectSchema.nullable().openapi(docs.homeProject),
	owner: z
		.object({
			id: z.string(),
			email: z.string().nullable(),
			firstName: z.string().nullable(),
			lastName: z.string().nullable(),
		})
		.nullable()
		.openapi(docs.owner),
	sharedWith: z
		.array(projectSchema.extend({ role: z.string().openapi({ example: 'workflow:editor' }) }))
		.openapi(docs.sharedWith),
	nodeCount: z.number().int(),
	nodeTypes: z.array(z.string()).openapi(docs.nodeTypes),
	credentials: z
		.array(z.object({ id: z.string().nullable(), name: z.string(), type: z.string() }))
		.openapi(docs.credentials),
	triggers: z
		.array(z.object({ name: z.string(), type: z.string(), disabled: z.boolean() }))
		.openapi(docs.triggers),
	recentExecutions: z
		.array(
			z.object({
				id: z.string(),
				status: z.string().openapi({ example: 'success' }),
				mode: z.string().openapi({ example: 'trigger' }),
				startedAt: z.string().datetime().nullable(),
				stoppedAt: z.string().datetime().nullable(),
			}),
		)
		.openapi(docs.recentExecutions),
});

export type WorkflowInventoryItemPublic = z.infer<typeof workflowInventoryItemPublicSchema>;

export class WorkflowInventoryListPublicDto extends Z.class({
	data: z.array(workflowInventoryItemPublicSchema),
	nextCursor: z.string().nullable().openapi(docs.nextCursor),
}) {}
