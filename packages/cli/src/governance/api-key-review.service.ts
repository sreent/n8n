// Fork code (not in upstream n8n): the list of all API keys for reviews. See README.md.
import type { ApiKeyReviewPublic } from '@n8n/api-types';
import { ApiKeyRepository, type ApiKey } from '@n8n/db';
import { Service } from '@n8n/di';

import { PublicApiKeyService } from '@/services/public-api-key.service';

export interface ApiKeyReviewFilter {
	userId?: string;
	audience?: ApiKey['audience'];
}

@Service()
export class ApiKeyReviewService {
	constructor(
		private readonly apiKeyRepository: ApiKeyRepository,
		private readonly publicApiKeyService: PublicApiKeyService,
	) {}

	/**
	 * One page of the API keys of all users, newest first, and the number of all keys that match.
	 * The result never holds the value of a key.
	 */
	async list(filter: ApiKeyReviewFilter, offset: number, limit: number, now = new Date()) {
		const [apiKeys, count] = await this.apiKeyRepository.findAndCount({
			where: {
				...(filter.userId && { userId: filter.userId }),
				...(filter.audience && { audience: filter.audience }),
			},
			relations: { user: { role: true } },
			order: { createdAt: 'DESC', id: 'DESC' },
			skip: offset,
			take: limit,
		});

		return { count, apiKeys: apiKeys.map((apiKey) => this.toReview(apiKey, now)) };
	}

	private toReview(apiKey: ApiKey, now: Date): ApiKeyReviewPublic {
		const expiresAtSeconds = this.publicApiKeyService.getApiKeyExpiration(apiKey.apiKey);
		const expiresAt = expiresAtSeconds === null ? null : new Date(expiresAtSeconds * 1000);
		const { user } = apiKey;
		return {
			id: apiKey.id,
			label: apiKey.label,
			audience: apiKey.audience,
			scopes: apiKey.scopes,
			user: {
				id: user.id,
				email: user.email ?? null,
				firstName: user.firstName ?? null,
				lastName: user.lastName ?? null,
				role: user.role?.slug ?? null,
			},
			createdAt: apiKey.createdAt.toISOString(),
			updatedAt: apiKey.updatedAt.toISOString(),
			expiresAt: expiresAt?.toISOString() ?? null,
			expired: expiresAt !== null && expiresAt <= now,
			lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
		};
	}
}
