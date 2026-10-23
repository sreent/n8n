import {
	GitSyncProjectsQueryDto,
	GitSyncPullDto,
	GitSyncPushDto,
	GitSyncSettingsDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Delete, Get, GlobalScope, Post, Put, Query, RestController } from '@n8n/decorators';
import type { Response } from 'express';

import { GitSyncService } from './git-sync.service';

/**
 * Git sync replaces the content of a whole project and writes to a shared repository. Each route
 * needs the global scope `sourceControl:manage`: the owner and the admins hold it, and a custom
 * instance role can hold it.
 */
@RestController('/git-sync')
export class GitSyncController {
	constructor(private readonly gitSyncService: GitSyncService) {}

	@Get('/settings')
	@GlobalScope('sourceControl:manage')
	async getSettings() {
		return await this.gitSyncService.getSettings();
	}

	@Put('/settings')
	@GlobalScope('sourceControl:manage')
	async saveSettings(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncSettingsDto) {
		return await this.gitSyncService.saveSettings(req.user, body);
	}

	@Delete('/settings')
	@GlobalScope('sourceControl:manage')
	async disconnect(req: AuthenticatedRequest) {
		await this.gitSyncService.disconnect(req.user);
		return { success: true };
	}

	@Post('/test-connection', { keyedRateLimit: { source: 'user', limit: 10, windowMs: 60_000 } })
	@GlobalScope('sourceControl:manage')
	async testConnection(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncSettingsDto) {
		return await this.gitSyncService.testConnection(req.user, body);
	}

	@Get('/projects')
	@GlobalScope('sourceControl:manage')
	async listProjects(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: GitSyncProjectsQueryDto,
	) {
		return await this.gitSyncService.listProjects(query.search);
	}

	@Get('/status')
	@GlobalScope('sourceControl:manage')
	async getStatus(req: AuthenticatedRequest) {
		return await this.gitSyncService.getStatus(req.user);
	}

	@Post('/push')
	@GlobalScope('sourceControl:manage')
	async push(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncPushDto) {
		return await this.gitSyncService.push(req.user, body.message, body.replaceRemoteContent);
	}

	@Post('/pull')
	@GlobalScope('sourceControl:manage')
	async pull(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncPullDto) {
		return await this.gitSyncService.pull(req.user, body.overwriteLocalChanges, body.full);
	}
}
