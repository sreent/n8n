// Fork code (not in upstream n8n): the docs of the audit log in the public API. See
// packages/cli/src/modules/audit-log/README.md.
import type { ZodOpenAPIMetadata } from '@asteasolutions/zod-to-openapi';

export const auditLogQueryFieldDocs = {
	from: {
		description: 'Only the events at or after this time, in ISO 8601 with an offset.',
		example: '2026-10-01T00:00:00.000Z',
	},
	to: {
		description: 'Only the events at or before this time, in ISO 8601 with an offset.',
		example: '2026-10-31T23:59:59.999Z',
	},
	eventName: {
		description: 'An event name, or a prefix that ends with a dot.',
		example: 'n8n.audit.workflow.',
	},
	userId: {
		description: 'Only the events of this user.',
		example: '6b2c7f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
	},
	projectId: {
		description: 'Only the events of this project.',
		example: 'Xk3pV9qLm2Rt7wYz',
	},
	projectType: {
		description:
			'Only the events of projects of this type. `personal` gives the events of the personal spaces of users.',
	},
	format: {
		description: 'The format of the file: `csv` (the default) or `json`.',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;

export const auditLogEventFieldDocs = {
	id: { description: 'The id of the event.' },
	eventName: { description: 'The name of the event.', example: 'n8n.audit.workflow.updated' },
	timestamp: { description: 'The time of the event.' },
	userId: { description: 'The id of the user that the event names, or null.' },
	userEmail: { description: 'The email address of that user, or null.' },
	projectId: {
		description:
			'The project of the event: the project that the payload names, else the home project of the workflow or credential that it names. Null when the event names none of them, and for the events that the audit log stored before it recorded projects.',
	},
	projectType: {
		description: 'The type of that project: `personal` or `team`, or null.',
		example: 'personal',
	},
	payload: { description: 'The payload of the event, as the event bus sends it.' },
} as const satisfies Record<string, ZodOpenAPIMetadata>;

export const auditLogListFieldDocs = {
	nextCursor: {
		description:
			'Paginate through the events by setting the cursor parameter to a nextCursor attribute ' +
			'returned by a previous request. Default value fetches the first "page" of the collection.',
		example: 'eyJvZmZzZXQiOjEwMCwibGltaXQiOjEwMH0=',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;
