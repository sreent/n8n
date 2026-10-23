import { OutboundHttp } from '@n8n/backend-network';
import { Service } from '@n8n/di';
import { formatPemBlock } from '@n8n/utils/format-pem-block';
import { isRecord } from '@n8n/utils/is-record';
import { SignJWT } from 'jose';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';

import { stringField, vertexHost } from './backends';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The gateway gets a new token this long before the old one expires. */
const RENEW_BEFORE_MS = 5 * 60_000;

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** The service account could not sign in. The message has no secret. */
export class VertexSignInError extends Error {}

/**
 * The signed JWT of a service account for the token endpoint of Google (RFC 7523). It is not a
 * token of n8n, so it does not go through `JwtService`.
 */
async function serviceAccountAssertion(email: string, privateKeyPem: string) {
	let key: KeyObject;
	try {
		key = createPrivateKey(privateKeyPem);
	} catch {
		throw new VertexSignInError('The private key of the credential is not valid.');
	}
	if (key.asymmetricKeyType !== 'rsa') {
		throw new VertexSignInError('The private key of the credential is not an RSA key.');
	}
	return await new SignJWT({ scope: CLOUD_PLATFORM_SCOPE })
		.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
		.setIssuer(email)
		.setAudience(TOKEN_URL)
		.setIssuedAt()
		.setExpirationTime('1h')
		.sign(key);
}

/**
 * Signs in to Vertex AI with the service account of a credential of the type `googleApi`, and
 * keeps each access token until 5 minutes before it expires. See `README.md`, "Backends".
 */
@Service()
export class AiGatewayVertexService {
	private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

	private readonly pending = new Map<string, Promise<string>>();

	constructor(private readonly outboundHttp: OutboundHttp) {}

	/** The origin of the API of Vertex AI in a location. */
	origin(location: string) {
		return `https://${vertexHost(location)}`;
	}

	/** The origin of the Cloud Vision API. */
	visionOrigin() {
		return 'https://vision.googleapis.com';
	}

	/** The origin of Document AI in a location, for example `us` or `eu`. */
	documentAiOrigin(location: string) {
		return `https://${location}-documentai.googleapis.com`;
	}

	/** An access token of the service account of a credential. */
	async accessToken(data: ICredentialDataDecryptedObject): Promise<string> {
		const email = stringField(data, 'email');
		const privateKey = formatPemBlock(stringField(data, 'privateKey').replace(/\\n/g, '\n'));
		if (!email || !privateKey) {
			throw new VertexSignInError('The credential has no e-mail or no private key.');
		}
		// The key of the cache changes when an admin changes the credential.
		const key = createHash('sha256').update(`${email}\n${privateKey}`).digest('hex');
		const cached = this.tokens.get(key);
		if (cached && cached.expiresAt - RENEW_BEFORE_MS > Date.now()) return cached.token;

		let request = this.pending.get(key);
		if (!request) {
			request = this.requestToken(key, email, privateKey).finally(() => this.pending.delete(key));
			this.pending.set(key, request);
		}
		return await request;
	}

	/** Forgets the tokens, for example after a change of the settings. */
	clear() {
		this.tokens.clear();
	}

	private async requestToken(key: string, email: string, privateKey: string) {
		const assertion = await serviceAccountAssertion(email, privateKey);
		let response: unknown;
		try {
			response = await this.outboundHttp.requests().request({
				url: TOKEN_URL,
				method: 'POST',
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
					assertion,
				}).toString(),
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				json: true,
				timeout: TOKEN_REQUEST_TIMEOUT_MS,
			});
		} catch (error) {
			throw new VertexSignInError(
				`Google refused the sign-in: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const token = isRecord(response) ? response.access_token : undefined;
		if (typeof token !== 'string' || !token) {
			throw new VertexSignInError('Google gave no access token.');
		}
		const lifetime = isRecord(response) ? Number(response.expires_in) : Number.NaN;
		const expiresAt =
			Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000;
		this.tokens.set(key, { token, expiresAt });
		return token;
	}
}
