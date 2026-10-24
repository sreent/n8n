import { Service } from '@n8n/di';

import { JwtService, TOKEN_PURPOSES } from '@n8n/backend-services';

/** The audience of a token of the gateway. No other token of n8n has it. */
export const AI_GATEWAY_TOKEN_AUDIENCE = TOKEN_PURPOSES.aiGateway;

/** The lifetime of a token, in seconds. `AiGatewayService` gets a new one after 90 % of it. */
export const AI_GATEWAY_TOKEN_LIFETIME_SECONDS = 3600;

const TOKEN_KIND = 'fork-ai-gateway';

/**
 * The tokens that the nodes send to the gateway in place of an API key. A token is a JWT of the
 * ordinary `JwtService` with the purpose `aiGateway`, which binds it to the audience of the
 * gateway, and names one user.
 */
@Service()
export class AiGatewayTokenService {
	constructor(private readonly jwtService: JwtService) {}

	issue(userId: string) {
		const token = this.jwtService.sign(
			'aiGateway',
			{ sub: userId, kind: TOKEN_KIND },
			{ expiresIn: AI_GATEWAY_TOKEN_LIFETIME_SECONDS },
		);
		return { token, expiresIn: AI_GATEWAY_TOKEN_LIFETIME_SECONDS };
	}

	/** The user of a valid token, else `undefined`. */
	verify(token: string): string | undefined {
		try {
			const claims = this.jwtService.verify<{ sub?: unknown; kind?: unknown }>('aiGateway', token);
			if (claims.kind !== TOKEN_KIND || typeof claims.sub !== 'string' || !claims.sub) {
				return undefined;
			}
			return claims.sub;
		} catch {
			return undefined;
		}
	}
}
