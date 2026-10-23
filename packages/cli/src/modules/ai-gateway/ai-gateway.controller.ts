import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Get,
	GlobalScope,
	Licensed,
	Post,
	Put,
	Query,
	RestController,
} from '@n8n/decorators';
import type { Response } from 'express';

import { AiGatewayAdminService } from './ai-gateway-admin.service';
import { AiGatewaySettingsDto, AiGatewayTopUpDto, AiGatewayUsageQueryDto } from './ai-gateway.dto';

/**
 * The settings of the AI gateway, for users with the scope `aiAssistant:manage` ("Manage AI
 * usage"): the owner and the admins. See `README.md`, "REST API".
 */
@RestController('/ai-gateway')
export class AiGatewayAdminController {
	constructor(private readonly admin: AiGatewayAdminService) {}

	@Get('/settings')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async getSettings() {
		return await this.admin.getSettings();
	}

	@Put('/settings')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async updateSettings(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: AiGatewaySettingsDto,
	) {
		return await this.admin.updateSettings(body, req.user);
	}

	@Get('/overview')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async overview() {
		return await this.admin.overview();
	}

	@Get('/top-ups')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async listTopUps() {
		return await this.admin.listTopUps();
	}

	@Post('/top-ups')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async addTopUp(req: AuthenticatedRequest, _res: Response, @Body body: AiGatewayTopUpDto) {
		return await this.admin.addTopUp(body, req.user);
	}

	@Get('/prices')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	prices() {
		return this.admin.prices();
	}

	@Get('/usage')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async usage(_req: AuthenticatedRequest, _res: Response, @Query query: AiGatewayUsageQueryDto) {
		const { skip, take, ...filter } = query;
		return await this.admin.usage(filter, skip, take);
	}
}
