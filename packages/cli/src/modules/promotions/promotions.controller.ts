import type { PromotionDirection } from '@n8n/api-types';
import { PromotionChangesQueryDto, promotionDirectionSchema } from '@n8n/api-types';
import { LICENSE_FEATURES } from '@n8n/constants';
import type { AuthenticatedRequest } from '@n8n/db';
import { Get, GlobalScope, Licensed, Param, Query, RestController } from '@n8n/decorators';
import { NotFoundError } from '@n8n/errors';
import type { Response } from 'express';

import { PromotionChangeService } from './promotion-change.service';

function parseDirection(value: string): PromotionDirection {
	const parsed = promotionDirectionSchema.safeParse(value);
	if (!parsed.success) throw new NotFoundError(`Unknown promotion direction: ${value}`);
	return parsed.data;
}

/**
 * Fork code (not in upstream n8n): the REST route of the change list. The editor calls it with the
 * session of the user, and needs the global scope `gitConnection:read`. The other routes of the
 * editor are the routes of the public API controller. See `README.md`.
 */
@RestController('/promotions')
export class PromotionsController {
	constructor(private readonly changeService: PromotionChangeService) {}

	@Get('/:projectId/changes/:direction')
	@Licensed(LICENSE_FEATURES.GIT_CONNECTIONS)
	@GlobalScope('gitConnection:read')
	async getChanges(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('projectId') projectId: string,
		@Param('direction') direction: string,
		@Query query: PromotionChangesQueryDto,
	) {
		return await this.changeService.getChanges(
			req.user,
			projectId,
			parseDirection(direction),
			query,
		);
	}
}
