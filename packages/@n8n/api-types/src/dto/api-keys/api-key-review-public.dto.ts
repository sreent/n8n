// Fork code (not in upstream n8n): the list of API keys in the public API (`/api/v1/api-keys`),
// for reviews. It never gives the value of a key. See packages/cli/src/governance/README.md.
import '../../openapi-extend';

import { z } from 'zod';

import { apiKeyReviewFieldDocs, apiKeyReviewQueryFieldDocs } from './api-key-review-public.openapi';
import { Z } from '../../zod-class';
import { publicApiPaginationSchema } from '../pagination/pagination.dto';

export const apiKeyAudienceSchema = z.enum(['public-api', 'mcp-server-api']);

export class ListApiKeysQueryPublicDto extends Z.class({
	userId: z.string().trim().min(1).max(36).optional().openapi(apiKeyReviewQueryFieldDocs.userId),
	audience: apiKeyAudienceSchema.optional().openapi(apiKeyReviewQueryFieldDocs.audience),
	limit: publicApiPaginationSchema.limit,
	cursor: z.string().optional(),
}) {}

const docs = apiKeyReviewFieldDocs;

export const apiKeyReviewPublicSchema = z.object({
	id: z.string().openapi(docs.id),
	label: z.string().openapi(docs.label),
	audience: apiKeyAudienceSchema.openapi(docs.audience),
	scopes: z.array(z.string()).openapi(docs.scopes),
	user: z
		.object({
			id: z.string(),
			email: z.string().nullable(),
			firstName: z.string().nullable(),
			lastName: z.string().nullable(),
			role: z.string().nullable().openapi(docs.userRole),
		})
		.openapi(docs.user),
	createdAt: z.string().datetime().openapi(docs.createdAt),
	updatedAt: z.string().datetime().openapi(docs.updatedAt),
	expiresAt: z.string().datetime().nullable().openapi(docs.expiresAt),
	expired: z.boolean().openapi(docs.expired),
	lastUsedAt: z.string().datetime().nullable().openapi(docs.lastUsedAt),
});

export type ApiKeyReviewPublic = z.infer<typeof apiKeyReviewPublicSchema>;

export class ApiKeyReviewListPublicDto extends Z.class({
	data: z.array(apiKeyReviewPublicSchema),
	nextCursor: z.string().nullable().openapi(docs.nextCursor),
}) {}
