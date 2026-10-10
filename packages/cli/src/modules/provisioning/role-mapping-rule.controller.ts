// Fork module (not in upstream n8n): the endpoints of the role mapping rules, in place of the
// enterprise `role-mapping-rule.controller.ee.ts`. packages/cli/src/modules/provisioning/FORK.md
// describes them.
import {
	CreateRoleMappingRuleDto,
	ListRoleMappingRuleQueryDto,
	MoveRoleMappingRuleDto,
	PatchRoleMappingRuleDto,
} from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
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
	Query,
	RestController,
} from '@n8n/decorators';
import { NextFunction, Request, Response } from 'express';

import { RoleMappingRuleService } from './role-mapping-rule.service';

@RestController('/role-mapping-rule')
export class RoleMappingRuleController {
	constructor(
		private readonly roleMappingRuleService: RoleMappingRuleService,
		private readonly licenseState: LicenseState,
	) {}

	/** After the session and the scope checks: the rules need the SAML or OIDC licence. */
	@Middleware()
	checkLicence(_req: Request, res: Response, next: NextFunction) {
		if (!this.licenseState.isProvisioningLicensed()) {
			res.status(403).json({ message: 'Provisioning is not licensed' });
			return;
		}
		next();
	}

	@Get('/')
	@GlobalScope('roleMappingRule:list')
	async list(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: ListRoleMappingRuleQueryDto,
	) {
		return await this.roleMappingRuleService.list(query);
	}

	@Post('/')
	@GlobalScope('roleMappingRule:create')
	async create(req: AuthenticatedRequest, _res: Response, @Body body: CreateRoleMappingRuleDto) {
		return await this.roleMappingRuleService.create(body, req.user);
	}

	@Patch('/:id')
	@GlobalScope('roleMappingRule:update')
	async patch(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body body: PatchRoleMappingRuleDto,
	) {
		return await this.roleMappingRuleService.patch({
			id,
			dto: body,
			userId: req.user.id,
			userEmail: req.user.email,
		});
	}

	@Post('/:id/move')
	@GlobalScope('roleMappingRule:update')
	async move(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body body: MoveRoleMappingRuleDto,
	) {
		return await this.roleMappingRuleService.move({
			id,
			targetIndex: body.targetIndex,
			userId: req.user.id,
			userEmail: req.user.email,
		});
	}

	@Delete('/:id')
	@GlobalScope('roleMappingRule:delete')
	async delete(req: AuthenticatedRequest, _res: Response, @Param('id') id: string) {
		await this.roleMappingRuleService.delete({
			id,
			userId: req.user.id,
			userEmail: req.user.email,
		});
		return { success: true };
	}
}
