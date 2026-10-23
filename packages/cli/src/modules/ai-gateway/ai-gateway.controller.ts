import {
	AiGatewayAdminUsageQueryDto,
	type AiGatewayAdminUsagePage,
	type AiGatewayOverview,
	type AiGatewayPriceTable,
	AiGatewaySettingsDto,
	type AiGatewaySettingsResponse,
	AiGatewayTopUpDto,
	type AiGatewayTopUpEntry,
} from '@n8n/api-types';
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
	async getSettings(): Promise<AiGatewaySettingsResponse> {
		return await this.admin.getSettings();
	}

	@Put('/settings')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async updateSettings(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: AiGatewaySettingsDto,
	): Promise<AiGatewaySettingsResponse> {
		return await this.admin.updateSettings(body, req.user);
	}

	@Get('/overview')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async overview(): Promise<AiGatewayOverview> {
		return await this.admin.overview();
	}

	@Get('/top-ups')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async listTopUps(): Promise<AiGatewayTopUpEntry[]> {
		return await this.admin.listTopUps();
	}

	@Post('/top-ups')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async addTopUp(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: AiGatewayTopUpDto,
	): Promise<AiGatewayOverview> {
		return await this.admin.addTopUp(body, req.user);
	}

	@Get('/prices')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	prices(): AiGatewayPriceTable {
		return this.admin.prices();
	}

	@Get('/usage')
	@Licensed('feat:aiGateway')
	@GlobalScope('aiAssistant:manage')
	async usage(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: AiGatewayAdminUsageQueryDto,
	): Promise<AiGatewayAdminUsagePage> {
		const { skip, take, ...filter } = query;
		return await this.admin.usage(filter, skip, take);
	}
}
