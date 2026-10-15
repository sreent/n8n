import { randomBytes } from 'node:crypto';

import { CacheService } from '@n8n/backend-services';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';
import { z } from 'zod';

/** How long an authorization link stays valid. */
const INTENT_TTL_MS = 60 * 60 * 1000;

const intentSchema = z.object({
	credentialId: z.string(),
	resolverId: z.string(),
	/** The n8n user that the link is for. A link for an external identity has none. */
	userId: z.string().optional(),
	/** The external identity (the `Authorization` value) of a link without a user. */
	authorizationHeader: z.string().optional(),
	authMetadata: z.record(z.unknown()).optional(),
});

export type AuthorizeIntent = z.infer<typeof intentSchema>;

/**
 * Authorization links: a random token that stands for the connection of one identity to one
 * private credential. The credential check gives these links to the forms and nodes that ask a
 * user to connect an account. The link can be opened more than once until it expires.
 */
@Service()
export class AuthorizeIntentService {
	constructor(
		private readonly cacheService: CacheService,
		private readonly cipher: Cipher,
	) {}

	async create(intent: AuthorizeIntent) {
		const token = randomBytes(32).toString('base64url');
		// The intent can carry the token of an external identity, so the cache keeps it encrypted.
		await this.cacheService.set(
			this.key(token),
			await this.cipher.encryptV2(JSON.stringify(intent)),
			INTENT_TTL_MS,
		);
		return token;
	}

	async find(token: string): Promise<AuthorizeIntent | undefined> {
		const stored = await this.cacheService.get<string>(this.key(token));
		if (typeof stored !== 'string') return undefined;
		try {
			const result = intentSchema.safeParse(jsonParse(await this.cipher.decryptV2(stored)));
			return result.success ? result.data : undefined;
		} catch {
			return undefined;
		}
	}

	private key(token: string) {
		return `dynamic-credentials:authorize-intent:${token}`;
	}
}
