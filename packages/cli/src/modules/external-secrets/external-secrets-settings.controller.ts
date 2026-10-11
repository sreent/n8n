import { UpdateExternalSecretsSettingsDto } from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import { Body, GlobalScope, Middleware, Post, RestController } from '@n8n/decorators';
import type { NextFunction, Request, Response } from 'express';

import { ExternalSecretsConfig } from './external-secrets.config';
import { ExternalSecretsService } from './external-secrets.service';
import { ROLE_BASED_ACCESS_DISABLED, checkMode } from './mode-checks';

/**
 * Fork code (not in upstream n8n). The setting of the system roles: whether the project admin and
 * editor roles get the scopes of external secrets.
 */
@RestController('/external-secrets/settings')
export class ExternalSecretsSettingsController {
	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly service: ExternalSecretsService,
	) {}

	/** The setting needs the access of project roles (`N8N_ENV_FEAT_EXTERNAL_SECRETS_ROLE_BASED_ACCESS`). */
	@Middleware()
	requireRoleBasedAccess(_req: Request, res: Response, next: NextFunction) {
		checkMode(this.config.externalSecretsRoleBasedAccess, ROLE_BASED_ACCESS_DISABLED, res, next);
	}

	@Post('/')
	@GlobalScope('externalSecretsProvider:update')
	async updateSettings(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: UpdateExternalSecretsSettingsDto,
	) {
		await this.service.setSystemRolesEnabled(body.systemRolesEnabled, req.user.id);
		return { systemRolesEnabled: body.systemRolesEnabled };
	}
}
