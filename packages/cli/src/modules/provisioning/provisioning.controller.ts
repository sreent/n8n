// Fork module (not in upstream n8n): the endpoints of the provisioning config, in place of the
// enterprise `provisioning.controller.ee.ts`. packages/cli/src/modules/provisioning/FORK.md
// describes them.
import { ProvisioningConfigPatchDto } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, Middleware, Patch, RestController } from '@n8n/decorators';
import { BadRequestError } from '@n8n/errors';
import { NextFunction, Request, Response } from 'express';

import { ProvisioningService } from './provisioning.service';

@RestController('/sso/provisioning')
export class ProvisioningController {
	constructor(
		private readonly provisioningService: ProvisioningService,
		private readonly licenseState: LicenseState,
	) {}

	/** After the session and the scope checks: the provisioning needs the SAML or OIDC licence. */
	@Middleware()
	checkLicence(_req: Request, res: Response, next: NextFunction) {
		if (!this.licenseState.isProvisioningLicensed()) {
			res.status(403).json({ message: 'Provisioning is not licensed' });
			return;
		}
		next();
	}

	@Get('/config')
	@GlobalScope('provisioning:manage')
	async getConfig(_req: AuthenticatedRequest) {
		return await this.provisioningService.getConfig();
	}

	@Patch('/config')
	@GlobalScope('provisioning:manage')
	async patchConfig(req: AuthenticatedRequest) {
		const parsed = ProvisioningConfigPatchDto.safeParse(req.body);
		if (!parsed.success) throw new BadRequestError(parsed.error.message);
		return await this.provisioningService.patchConfig(parsed.data);
	}
}
