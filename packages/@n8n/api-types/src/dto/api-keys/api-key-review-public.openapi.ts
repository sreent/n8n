// Fork code (not in upstream n8n): the docs of the list of API keys in the public API. See
// packages/cli/src/governance/README.md.
import type { ZodOpenAPIMetadata } from '@asteasolutions/zod-to-openapi';

export const apiKeyReviewQueryFieldDocs = {
	userId: {
		description: 'Only the API keys of this user.',
		example: '6b2c7f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
	},
	audience: {
		description:
			'Only the API keys of this audience: `public-api` (the public API) or `mcp-server-api` (the MCP server of n8n).',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;

export const apiKeyReviewFieldDocs = {
	id: { description: 'The id of the API key.' },
	label: { description: 'The label that the user gave the API key.', example: 'SIEM export' },
	audience: { description: 'What the API key opens: `public-api` or `mcp-server-api`.' },
	scopes: {
		description: 'The scopes of the API key. A key of the MCP server can have no scopes.',
	},
	user: { description: 'The user of the API key. The key acts as this user.' },
	userRole: { description: 'The instance role of the user.', example: 'global:member' },
	createdAt: { description: 'The time that the user created the API key.' },
	updatedAt: { description: 'The time of the last change of the API key, for example a rotation.' },
	expiresAt: { description: 'The time that the API key expires, or null when it does not expire.' },
	expired: { description: 'Whether the API key expired.' },
	lastUsedAt: { description: 'The time of the last use of the API key, or null.' },
	nextCursor: {
		description:
			'Paginate through the API keys by setting the cursor parameter to a nextCursor attribute ' +
			'returned by a previous request. Send the same filters again. Default value fetches the ' +
			'first "page" of the collection.',
		example: 'eyJvZmZzZXQiOjEwMCwibGltaXQiOjEwMH0=',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;
