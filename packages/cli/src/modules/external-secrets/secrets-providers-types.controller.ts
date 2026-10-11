import { AuthenticatedRequest } from '@n8n/db';
import { Get, Middleware, Param, RestController } from '@n8n/decorators';
import type { NextFunction, Request, Response } from 'express';

import { ExternalSecretsConfig } from './external-secrets.config';
import { CONNECTIONS_DISABLED, checkMode, usesConnections } from './mode-checks';
import { SecretsProvidersConnectionsService } from './secrets-providers-connections.service';

/** Fork code (not in upstream n8n). The provider types, with the fields of their forms. */
@RestController('/secret-providers/types')
export class SecretsProvidersTypesController {
	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly service: SecretsProvidersConnectionsService,
	) {}

	@Middleware()
	requireMode(_req: Request, res: Response, next: NextFunction) {
		checkMode(usesConnections(this.config), CONNECTIONS_DISABLED, res, next);
	}

	@Get('/')
	getTypes() {
		return this.service.getTypes();
	}

	@Get('/:type')
	getType(_req: AuthenticatedRequest, _res: Response, @Param('type') type: string) {
		return this.service.getType(type);
	}
}
