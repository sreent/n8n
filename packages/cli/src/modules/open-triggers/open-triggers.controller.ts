import type { OpenTriggerItem } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, RestController } from '@n8n/decorators';

import { OpenTriggersService } from './open-triggers.service';

/**
 * The open triggers of the published workflows, for the page Settings > Open triggers. Only users
 * with the global scope `workflow:list` can call it: the owner and the admins.
 */
@RestController('/open-triggers')
export class OpenTriggersController {
	constructor(private readonly openTriggersService: OpenTriggersService) {}

	@Get('/')
	@GlobalScope('workflow:list')
	async list(req: AuthenticatedRequest): Promise<OpenTriggerItem[]> {
		return await this.openTriggersService.listPublished(req.user);
	}
}
