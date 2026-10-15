import { Service } from '@n8n/di';

import { JwtService } from '@/services/jwt.service';

/** The audience of a token of the gateway. No other token of n8n has it. */
export const AI_GATEWAY_TOKEN_AUDIENCE = 'n8n:fork-ai-gateway';

/** The lifetime of a token, in seconds. `AiGatewayService` gets a new one after 90 % of it. */
export const AI_GATEWAY_TOKEN_LIFETIME_SECONDS = 3600;

const TOKEN_KIND = 'fork-ai-gateway';

/**
 * The tokens that the nodes send to the gateway in place of an API key. A token is a JWT of the
 * ordinary `JwtService`, bound to the audience of the gateway, and names one user.
 */
@Service()
export class AiGatewayTokenService {
	constructor(private readonly jwtService: JwtService) {}

	issue(userId: string) {
		const token = this.jwtService.signForResource(
			{ sub: userId, kind: TOKEN_KIND },
			AI_GATEWAY_TOKEN_AUDIENCE,
			{ expiresIn: AI_GATEWAY_TOKEN_LIFETIME_SECONDS },
		);
		return { token, expiresIn: AI_GATEWAY_TOKEN_LIFETIME_SECONDS };
	}

	/** The user of a valid token, else `undefined`. */
	verify(token: string): string | undefined {
		try {
			const claims = this.jwtService.verifyForResource<{ sub?: unknown; kind?: unknown }>(
				token,
				AI_GATEWAY_TOKEN_AUDIENCE,
			);
			if (claims.kind !== TOKEN_KIND || typeof claims.sub !== 'string' || !claims.sub) {
				return undefined;
			}
			return claims.sub;
		} catch {
			return undefined;
		}
	}
}
