import { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, Middleware, Post, RestController } from '@n8n/decorators';
import { NotFoundError } from '@n8n/errors';
import type { NextFunction, Request, Response } from 'express';
import type { IDataObject } from 'n8n-workflow';

import { ExternalSecretsService } from './external-secrets.service';

type ProviderRequest<Body = IDataObject> = AuthenticatedRequest<{ provider: string }, {}, Body>;

/**
 * Fork code (not in upstream n8n). The settings API of external secrets: one setting for each
 * provider type. packages/cli/src/modules/external-secrets/FORK.md describes the answers.
 */
@RestController('/external-secrets')
export class ExternalSecretsController {
	constructor(private readonly service: ExternalSecretsService) {}

	/** A route of a provider needs a provider type that n8n knows. */
	@Middleware()
	validateProvider(req: Request<{ provider?: string }>, _res: Response, next: NextFunction) {
		const { provider } = req.params;
		if (provider !== undefined && !this.service.hasProviderType(provider)) {
			throw new NotFoundError(`Could not find provider "${provider}"`);
		}
		next();
	}

	@Get('/providers')
	@GlobalScope('externalSecretsProvider:list')
	async getProviders() {
		return await this.service.getProviders();
	}

	@Get('/providers/:provider')
	@GlobalScope('externalSecretsProvider:read')
	async getProvider(req: ProviderRequest) {
		return await this.service.getProvider(req.params.provider);
	}

	@Post('/providers/:provider/test')
	@GlobalScope('externalSecretsProvider:update')
	async testProviderSettings(req: ProviderRequest, res: Response) {
		const { success, error } = await this.service.testProviderSettings(
			req.params.provider,
			req.body ?? {},
		);
		if (success) return { success, testState: 'connected' };
		res.status(400);
		return { success, testState: 'error', ...(error !== undefined && { error }) };
	}

	@Post('/providers/:provider')
	@GlobalScope('externalSecretsProvider:create')
	async setProviderSettings(req: ProviderRequest) {
		await this.service.saveProviderSettings(req.params.provider, req.body, req.user.id);
		return {};
	}

	@Post('/providers/:provider/connect')
	@GlobalScope('externalSecretsProvider:update')
	async setProviderConnected(req: ProviderRequest<{ connected?: unknown }>) {
		await this.service.setProviderConnected(req.params.provider, req.body.connected);
		return {};
	}

	@Post('/providers/:provider/update')
	@GlobalScope('externalSecretsProvider:sync')
	async updateProvider(req: ProviderRequest, res: Response) {
		if (await this.service.updateProvider(req.params.provider)) return { updated: true };
		res.status(400);
		return { updated: false };
	}

	@Get('/secrets')
	@GlobalScope('externalSecret:list')
	getSecretNames() {
		return this.service.getSecretNames();
	}
}
