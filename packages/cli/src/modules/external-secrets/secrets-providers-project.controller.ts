import {
	CreateSecretsProviderConnectionDto,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	Middleware,
	Param,
	Patch,
	Post,
	ProjectScope,
	RestController,
} from '@n8n/decorators';
import type { NextFunction, Request, Response } from 'express';

import { ExternalSecretsConfig } from './external-secrets.config';
import { PROJECTS_DISABLED, checkMode } from './mode-checks';
import { SecretsProvidersConnectionsService } from './secrets-providers-connections.service';

/**
 * Fork code (not in upstream n8n). The connections of a project: the connections that the project
 * owns or uses, and the global connections. The scopes of the project roles decide the access.
 */
@RestController('/secret-providers/projects')
export class SecretsProvidersProjectController {
	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly service: SecretsProvidersConnectionsService,
	) {}

	@Middleware()
	requireMode(_req: Request, res: Response, next: NextFunction) {
		checkMode(this.config.externalSecretsForProjects, PROJECTS_DISABLED, res, next);
	}

	@Get('/:projectId/connections')
	@ProjectScope('externalSecretsProvider:list')
	async listConnections(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
	) {
		return await this.service.listProjectConnections(projectId);
	}

	@Post('/:projectId/connections')
	@ProjectScope('externalSecretsProvider:create')
	async createConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
		@Body body: CreateSecretsProviderConnectionDto,
	) {
		return await this.service.createProjectConnection(projectId, body, req.user);
	}

	@Get('/:projectId/connections/:providerKey')
	@ProjectScope('externalSecretsProvider:read')
	async getConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
		@Param('providerKey') key: string,
	) {
		return await this.service.getProjectConnection(projectId, key, req.user);
	}

	@Patch('/:projectId/connections/:providerKey')
	@ProjectScope('externalSecretsProvider:update')
	async updateConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
		@Param('providerKey') key: string,
		@Body body: UpdateSecretsProviderConnectionDto,
	) {
		return await this.service.updateProjectConnection(projectId, key, body, req.user);
	}

	@Delete('/:projectId/connections/:providerKey')
	@ProjectScope('externalSecretsProvider:delete')
	async deleteConnection(
		_req: AuthenticatedRequest,
		res: Response,
		@Param('projectId') projectId: string,
		@Param('providerKey') key: string,
	) {
		await this.service.deleteProjectConnection(projectId, key);
		res.status(204);
	}

	@Post('/:projectId/connections/:providerKey/test')
	@ProjectScope('externalSecretsProvider:update')
	async testConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
		@Param('providerKey') key: string,
	) {
		return await this.service.testProjectConnection(projectId, key, req.user);
	}
}
