import {
	CreateSecretsProviderConnectionDto,
	UpdateSecretsProviderConnectionDto,
} from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	GlobalScope,
	Middleware,
	Param,
	Patch,
	Post,
	RestController,
} from '@n8n/decorators';
import type { NextFunction, Request, Response } from 'express';

import { ExternalSecretsConfig } from './external-secrets.config';
import { CONNECTIONS_DISABLED, checkMode, usesConnections } from './mode-checks';
import { SecretsProvidersConnectionsService } from './secrets-providers-connections.service';

/**
 * Fork code (not in upstream n8n). The connections of the instance: global connections and
 * connections that projects use. packages/cli/src/modules/external-secrets/FORK.md describes the
 * answers.
 */
@RestController('/secret-providers/connections')
export class SecretsProvidersConnectionsController {
	constructor(
		private readonly config: ExternalSecretsConfig,
		private readonly service: SecretsProvidersConnectionsService,
	) {}

	@Middleware()
	requireMode(_req: Request, res: Response, next: NextFunction) {
		checkMode(usesConnections(this.config), CONNECTIONS_DISABLED, res, next);
	}

	@Post('/')
	@GlobalScope('externalSecretsProvider:create')
	async createConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: CreateSecretsProviderConnectionDto,
	) {
		return await this.service.createConnection(body, req.user);
	}

	@Get('/')
	@GlobalScope('externalSecretsProvider:list')
	async listConnections() {
		return await this.service.listConnections();
	}

	@Get('/:providerKey')
	@GlobalScope('externalSecretsProvider:read')
	async getConnection(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') key: string,
	) {
		return await this.service.getConnection(key);
	}

	@Patch('/:providerKey')
	@GlobalScope('externalSecretsProvider:update')
	async updateConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') key: string,
		@Body body: UpdateSecretsProviderConnectionDto,
	) {
		return await this.service.updateConnection(key, body, req.user);
	}

	@Delete('/:providerKey')
	@GlobalScope('externalSecretsProvider:delete')
	async deleteConnection(
		req: AuthenticatedRequest,
		res: Response,
		@Param('providerKey') key: string,
	) {
		await this.service.deleteConnection(key, req.user);
		res.status(204);
	}

	@Post('/:providerKey/test')
	@GlobalScope('externalSecretsProvider:update')
	async testConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') key: string,
	) {
		return await this.service.testConnection(key, req.user);
	}

	@Post('/:providerKey/reload')
	@GlobalScope('externalSecretsProvider:sync')
	async reloadConnection(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('providerKey') key: string,
	) {
		return await this.service.reloadConnection(key, req.user);
	}
}
