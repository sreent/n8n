import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Delete, Get, Middleware, Post, Put, Query, RestController } from '@n8n/decorators';
import { ForbiddenError } from '@n8n/errors';
import type { NextFunction, Response } from 'express';

import { sendErrorResponse } from '@/response-helper';

import { canUseGitSync } from './git-sync.access';
import {
	GitSyncProjectsQueryDto,
	GitSyncPullDto,
	GitSyncPushDto,
	GitSyncSettingsDto,
} from './git-sync.dto';
import { GitSyncService } from './git-sync.service';

@RestController('/git-sync')
export class GitSyncController {
	constructor(private readonly gitSyncService: GitSyncService) {}

	/** Runs before every route of this controller, after authentication. */
	@Middleware()
	ownerAndAdminsOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		if (!canUseGitSync(req.user)) {
			sendErrorResponse(
				res,
				new ForbiddenError('Only the instance owner and admins can use Git sync.'),
			);
			return;
		}
		next();
	}

	@Get('/settings')
	async getSettings() {
		return await this.gitSyncService.getSettings();
	}

	@Put('/settings')
	async saveSettings(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncSettingsDto) {
		return await this.gitSyncService.saveSettings(req.user, body);
	}

	@Delete('/settings')
	async disconnect() {
		await this.gitSyncService.disconnect();
		return { success: true };
	}

	@Post('/test-connection', { keyedRateLimit: { source: 'user', limit: 10, windowMs: 60_000 } })
	async testConnection(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncSettingsDto) {
		return await this.gitSyncService.testConnection(req.user, body);
	}

	@Get('/projects')
	async listProjects(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: GitSyncProjectsQueryDto,
	) {
		return await this.gitSyncService.listProjects(query.search);
	}

	@Get('/status')
	async getStatus(req: AuthenticatedRequest) {
		return await this.gitSyncService.getStatus(req.user);
	}

	@Post('/push')
	async push(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncPushDto) {
		return await this.gitSyncService.push(req.user, body.message, body.replaceRemoteContent);
	}

	@Post('/pull')
	async pull(req: AuthenticatedRequest, _res: Response, @Body body: GitSyncPullDto) {
		return await this.gitSyncService.pull(req.user, body.overwriteLocalChanges, body.full);
	}
}
