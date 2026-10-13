// Fork code (not in upstream n8n): the docs of the inventory of workflows in the public API. See
// packages/cli/src/governance/README.md.
import type { ZodOpenAPIMetadata } from '@asteasolutions/zod-to-openapi';

export const workflowInventoryQueryFieldDocs = {
	projectId: {
		description: 'Only the workflows of this project.',
		example: 'VmwOO9HeTEj20kxM',
	},
	executions: {
		description: 'How many of the newest executions to give for each workflow: 0 to 20.',
	},
	limit: {
		description: 'The maximum number of workflows to return: 1 to 100.',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;

export const workflowInventoryFieldDocs = {
	status: {
		description:
			'`published` (the workflow runs in production), `unpublished`, or `archived`. n8n v1 called a published workflow active.',
	},
	hasUnpublishedChanges: {
		description: 'Whether the saved version differs from the published version.',
	},
	homeProject: { description: 'The project that owns the workflow.' },
	owner: {
		description:
			'The user of the personal space that owns the workflow, or null when a team project owns it.',
	},
	sharedWith: { description: 'The other projects that the workflow is shared with.' },
	nodeTypes: {
		description: 'The node types of the saved version, each once, sorted.',
	},
	credentials: {
		description: 'The credentials that the nodes of the saved version use, each once.',
	},
	triggers: { description: 'The trigger nodes of the saved version.' },
	recentExecutions: { description: 'The newest executions of the workflow, newest first.' },
	nextCursor: {
		description:
			'Paginate through the workflows by setting the cursor parameter to a nextCursor attribute ' +
			'returned by a previous request. Send the same filters again. Default value fetches the ' +
			'first "page" of the collection.',
		example: 'eyJvZmZzZXQiOjUwLCJsaW1pdCI6NTB9',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;
