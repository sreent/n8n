import { UpdateProjectPoolSettingsDto } from '@n8n/api-types';
import type { ProjectPoolSettingsResponse } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, Licensed, Param, Patch, ProjectScope, RestController } from '@n8n/decorators';
import type { Response } from 'express';

import { PoolConfigService } from '@/scaling/pool-config.service';

/**
 * Fork code (not in upstream n8n): the worker pool of a project, for the project settings page.
 * It replaces the enterprise controller of the same name. See `../scaling/FORK.md`.
 */
@RestController('/projects/:projectId/pool-settings')
export class ProjectPoolSettingsController {
	constructor(private readonly poolConfigService: PoolConfigService) {}

	@Get('/')
	@Licensed('feat:workerPools')
	@ProjectScope('project:read')
	async getPoolSettings(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
	): Promise<ProjectPoolSettingsResponse> {
		return await this.poolConfigService.getProjectPoolSettings(projectId);
	}

	@Patch('/')
	@Licensed('feat:workerPools')
	@ProjectScope('project:update')
	async updatePoolSettings(
		_req: AuthenticatedRequest,
		_res: Response,
		@Body body: UpdateProjectPoolSettingsDto,
		@Param('projectId') projectId: string,
	): Promise<ProjectPoolSettingsResponse> {
		return await this.poolConfigService.setProjectPoolSettings(projectId, body.defaultPool);
	}
}
