// Fork code (not in upstream n8n): the insights by workflow in the public API
// (`/api/v1/insights/by-workflow`). See
// packages/cli/src/public-api/v1/controllers/insights-by-workflow.public.controller.ts.
import '../../openapi-extend';

import { z } from 'zod';

import {
	insightsByWorkflowFieldDocs,
	insightsByWorkflowQueryFieldDocs,
} from './insights-by-workflow-public.openapi';
import { ListInsightsWorkflowQueryDto } from './list-workflow-query.dto';
import { Z } from '../../zod-class';
import { publicApiPaginationSchema } from '../pagination/pagination.dto';

// `.datetime()` only checks the pattern, so an impossible offset such as `+99:99` passes it; the
// refine rejects those values.
const dateTimeQuerySchema = z
	.string()
	.datetime({ offset: true })
	.refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid datetime');

export class InsightsByWorkflowQueryPublicDto extends Z.class({
	startDate: dateTimeQuerySchema.optional().openapi(insightsByWorkflowQueryFieldDocs.startDate),
	endDate: dateTimeQuerySchema.optional().openapi(insightsByWorkflowQueryFieldDocs.endDate),
	projectId: z.string().optional().openapi(insightsByWorkflowQueryFieldDocs.projectId),
	// The sort options of the REST API, so that both stay the same.
	sortBy: ListInsightsWorkflowQueryDto.schema.shape.sortBy.openapi(
		insightsByWorkflowQueryFieldDocs.sortBy,
	),
	limit: publicApiPaginationSchema.limit,
	cursor: z.string().optional(),
}) {}

const docs = insightsByWorkflowFieldDocs;

export const insightsByWorkflowItemPublicSchema = z.object({
	workflowId: z.string().nullable().openapi(docs.workflowId),
	workflowName: z.string().openapi(docs.workflowName),
	projectId: z.string().nullable().openapi(docs.projectId),
	projectName: z.string().openapi(docs.projectName),
	total: z.number().openapi(docs.total),
	succeeded: z.number().openapi(docs.succeeded),
	failed: z.number().openapi(docs.failed),
	failureRate: z.number().openapi(docs.failureRate),
	runTime: z.number().openapi(docs.runTime),
	averageRunTime: z.number().openapi(docs.averageRunTime),
	timeSaved: z.number().openapi(docs.timeSaved),
});

export type InsightsByWorkflowItemPublic = z.infer<typeof insightsByWorkflowItemPublicSchema>;

export class InsightsByWorkflowPublicDto extends Z.class({
	data: z.array(insightsByWorkflowItemPublicSchema),
	nextCursor: z.string().nullable().openapi(docs.nextCursor),
}) {}
