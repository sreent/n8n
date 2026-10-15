import { isAuthenticatedRequest } from '@n8n/db';
import { Get, Options, Param, RestController } from '@n8n/decorators';
import { Container } from '@n8n/di';
import type { Request, Response } from 'express';

import { DynamicCredentialsConfig } from './dynamic-credentials.config';
import { DynamicCredentialCorsService } from './services/dynamic-credential-cors.service';
import { DynamicCredentialWebService } from './services/dynamic-credential-web.service';
import { getDynamicCredentialMiddlewares } from './utils';

const METHODS = 'GET, OPTIONS';

/**
 * Fork code (not in upstream n8n): the execution status of a workflow: whether the identity of
 * the request connected each private credential of the workflow. An external application calls
 * it with the endpoint token and the bearer token of its user. See `README.md` in this folder.
 */
@RestController('/workflows')
export class WorkflowStatusController {
	constructor(
		private readonly web: DynamicCredentialWebService,
		private readonly cors: DynamicCredentialCorsService,
	) {}

	@Options('/:workflowId/execution-status', { skipAuth: true })
	executionStatusPreflight(req: Request, res: Response) {
		this.cors.preflight(req, res, METHODS);
	}

	@Get('/:workflowId/execution-status', {
		allowUnauthenticated: true,
		middlewares: getDynamicCredentialMiddlewares(METHODS),
		ipRateLimit: {
			limit: Container.get(DynamicCredentialsConfig).rateLimitPerMinute,
			windowMs: 60_000,
		},
	})
	async getExecutionStatus(req: Request, _res: Response, @Param('workflowId') workflowId: string) {
		const user = isAuthenticatedRequest(req) ? req.user : undefined;
		const identity = this.web.identityOf(req, req.query.authSource, user);
		return await this.web.workflowStatus(workflowId, identity, user);
	}
}
