import { Get, RestController } from '@n8n/decorators';

import { LicenseService } from './license.service';

// Fork: the fork has no routes that register the Community Edition, request a trial, or activate or
// renew a licence key (the owner chose this on 2026-10-13). packages/cli/src/license/FORK.md
// describes the change.
@RestController('/license')
export class LicenseController {
	constructor(private readonly licenseService: LicenseService) {}

	@Get('/')
	async getLicenseData() {
		return await this.licenseService.getLicenseData();
	}
}
