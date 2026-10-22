// Fork code (not in upstream n8n): the docs of the open triggers in the public API. See
// packages/cli/src/modules/open-triggers/README.md.
import type { ZodOpenAPIMetadata } from '@asteasolutions/zod-to-openapi';

export const openTriggerQueryFieldDocs = {
	projectId: {
		description: 'Only the workflows of this project.',
		example: 'VmwOO9HeTEj20kxM',
	},
	limit: {
		description: 'The maximum number of triggers to return: 1 to 250.',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;

export const openTriggerFieldDocs = {
	homeProject: { description: 'The project that owns the workflow.' },
	owner: {
		description:
			'The user of the personal space that owns the workflow, or null when a team project owns it.',
	},
	kind: {
		description:
			'`webhook` (Webhook node), `form` (Form Trigger), `chat` (public Chat Trigger) or `mcp` (MCP Server Trigger).',
	},
	path: {
		description:
			'The path of the URL of the trigger, or the webhook id when the path is empty. Null when the path is an expression.',
	},
	approved: {
		description:
			'Whether an approved workflow review covers the trigger. False for a trigger that was published before the check was on.',
	},
	nextCursor: {
		description:
			'Paginate through the triggers by setting the cursor parameter to a nextCursor attribute ' +
			'returned by a previous request. Send the same filters again. Default value fetches the ' +
			'first "page" of the collection.',
		example: 'eyJvZmZzZXQiOjEwMCwibGltaXQiOjEwMH0',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;
