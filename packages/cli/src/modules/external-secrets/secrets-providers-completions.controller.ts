import { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, Middleware, Param, ProjectScope, RestController } from '@n8n/decorators';
import type { NextFunction, Request, Response } from 'express';

import { ExternalSecretsConfig } from './external-secrets.config';
import {
	MULTIPLE_CONNECTIONS_DISABLED,
	PROJECTS_DISABLED,
	checkMode,
	usesConnections,
} from './mode-checks';
import { SecretsProvidersConnectionsService } from './secrets-providers-connections.service';

/**
 * Fork code (not in upstream n8n). The names of the secrets for the completions of the editor:
 * of the global connections, and of the connections of a project.
 */
@RestController('/secret-providers/completions')
export class SecretsProvidersCompletionsController {
	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly service: SecretsProvidersConnectionsService,
	) {}

	/** The routes of a project need the vaults of projects; the others need connections. */
	@Middleware()
	requireMode(req: Request<{ projectId?: string }>, res: Response, next: NextFunction) {
		if (req.params.projectId !== undefined) {
			checkMode(this.config.externalSecretsForProjects, PROJECTS_DISABLED, res, next);
		} else {
			checkMode(usesConnections(this.config), MULTIPLE_CONNECTIONS_DISABLED, res, next);
		}
	}

	@Get('/secrets/global')
	@GlobalScope('externalSecret:list')
	async getGlobalSecrets() {
		return await this.service.getGlobalCompletions();
	}

	@Get('/secrets/global/:projectId')
	@ProjectScope('externalSecret:list')
	async getGlobalSecretsForProject(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') _projectId: string,
	) {
		return await this.service.getGlobalCompletions();
	}

	@Get('/secrets/project/:projectId')
	@ProjectScope('externalSecret:list')
	async getProjectSecrets(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
	) {
		return await this.service.getProjectCompletions(projectId);
	}
}
