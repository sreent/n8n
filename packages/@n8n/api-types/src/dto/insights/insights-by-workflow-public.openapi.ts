// Fork code (not in upstream n8n): the docs of the insights by workflow in the public API. See
// packages/cli/src/public-api/v1/controllers/insights-by-workflow.public.controller.ts.
import type { ZodOpenAPIMetadata } from '@asteasolutions/zod-to-openapi';

export const insightsByWorkflowQueryFieldDocs = {
	startDate: { description: 'ISO 8601 start date. Defaults to 7 days ago.' },
	endDate: { description: 'ISO 8601 end date. Defaults to now.' },
	projectId: {
		description: 'Only the workflows of this project.',
		example: 'VmwOO9HeTEj20kxM',
	},
	sortBy: {
		description: 'The order of the workflows: a metric or `workflowName`, then `asc` or `desc`.',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;

export const insightsByWorkflowFieldDocs = {
	workflowId: { description: 'The id of the workflow, or null when it was deleted.' },
	workflowName: { description: 'The name of the workflow.' },
	projectId: {
		description: 'The id of the home project of the workflow, or null when it was deleted.',
	},
	projectName: { description: 'The name of the home project of the workflow.' },
	total: { description: 'The number of production executions.' },
	succeeded: { description: 'The number of executions that succeeded.' },
	failed: { description: 'The number of executions that failed.' },
	failureRate: { description: 'The share of failed executions, from 0 to 1.', example: 0.25 },
	runTime: { description: 'The run time of all executions, in milliseconds.' },
	averageRunTime: { description: 'The average run time of an execution, in milliseconds.' },
	timeSaved: { description: 'The time that the executions saved, in minutes.' },
	nextCursor: {
		description:
			'Paginate through the workflows by setting the cursor parameter to a nextCursor attribute ' +
			'returned by a previous request. Send the same filters again. Default value fetches the ' +
			'first "page" of the collection.',
		example: 'eyJvZmZzZXQiOjEwMCwibGltaXQiOjEwMH0=',
	},
} as const satisfies Record<string, ZodOpenAPIMetadata>;
