import { Get, Post, RootLevelController } from '@n8n/decorators';
import type { Request, Response } from 'express';

import { AiGatewayProxyService } from './ai-gateway-proxy.service';

/**
 * The proxy of the AI gateway. The nodes call it with a token of the gateway, not with a session
 * of n8n, so the routes skip the sign-in and the proxy checks the token. See `README.md`.
 */
@RootLevelController('/ai-gateway')
export class AiGatewayProxyController {
	constructor(private readonly proxy: AiGatewayProxyService) {}

	@Get('/v1/gateway/*path', { skipAuth: true, usesTemplates: true })
	async get(req: Request, res: Response) {
		await this.proxy.handle(req, res);
	}

	@Post('/v1/gateway/*path', { skipAuth: true, usesTemplates: true })
	async post(req: Request, res: Response) {
		await this.proxy.handle(req, res);
	}
}
