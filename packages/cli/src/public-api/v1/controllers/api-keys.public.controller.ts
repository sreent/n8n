// Fork code (not in upstream n8n): the list of all API keys in the public API, for reviews. See
// packages/cli/src/governance/README.md.
import { ApiKeyReviewListPublicDto, ListApiKeysQueryPublicDto } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import {
	ApiDescription,
	ApiKeyScope,
	ApiResponse,
	ApiSummary,
	ApiTags,
	Get,
	GlobalScope,
	PublicApiController,
	Query,
} from '@n8n/decorators';
import type { Response } from 'express';

import { ApiKeyReviewService } from '@/governance/api-key-review.service';

import { assertOffsetPage } from '../shared/services/offset-page';
import { encodeNextCursor, resolveOffsetPagination } from '../shared/services/pagination.service';

@PublicApiController('/api-keys')
export class ApiKeysPublicController {
	constructor(private readonly apiKeyReviewService: ApiKeyReviewService) {}

	@Get('/')
	@ApiKeyScope('apiKey:manage')
	@GlobalScope('apiKey:manage')
	@ApiSummary('Retrieve all API keys')
	@ApiDescription(
		'Returns one page of the API keys of all users, newest first, for reviews: the user, the label, the scopes, the expiry and the last use. It never gives the value of a key.',
	)
	@ApiTags(['ApiKey'])
	@ApiResponse(200, ApiKeyReviewListPublicDto)
	async getApiKeys(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: ListApiKeysQueryPublicDto,
	): Promise<ApiKeyReviewListPublicDto> {
		const { offset, limit } = resolveOffsetPagination({ cursor: query.cursor, limit: query.limit });
		assertOffsetPage({ offset, limit });

		const { count, apiKeys } = await this.apiKeyReviewService.list(
			{ userId: query.userId, audience: query.audience },
			offset,
			limit,
		);

		return {
			data: apiKeys,
			nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: count }),
		};
	}
}
