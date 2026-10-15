import { Service } from '@n8n/di';
import type { Request, Response } from 'express';

import { DynamicCredentialsConfig } from '../dynamic-credentials.config';

const ALLOWED_HEADERS = 'Authorization, Content-Type, X-Requested-With, X-Authorization';
const MAX_AGE_SECONDS = '86400';

/**
 * CORS for the endpoints that an external application calls from a browser: the origins of
 * `N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN` get the CORS headers, other origins get none.
 */
@Service()
export class DynamicCredentialCorsService {
	constructor(private readonly config: DynamicCredentialsConfig) {}

	private isAllowedOrigin(origin: string) {
		const allowed = this.config.corsOrigin
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		return allowed.includes('*') || allowed.includes(origin);
	}

	/** Adds the CORS headers for an allowed origin. Tells whether it did. */
	applyHeaders(req: Request, res: Response, methods: string) {
		const origin = req.headers.origin;
		if (typeof origin !== 'string' || !this.isAllowedOrigin(origin)) return false;
		res.header('Access-Control-Allow-Origin', origin);
		if (this.config.corsAllowCredentials) res.header('Access-Control-Allow-Credentials', 'true');
		res.header('Access-Control-Allow-Methods', methods);
		res.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
		res.header('Access-Control-Max-Age', MAX_AGE_SECONDS);
		return true;
	}

	/** Answers a preflight request: 204 for an allowed origin, else 404. */
	preflight(req: Request, res: Response, methods: string) {
		res.status(this.applyHeaders(req, res, methods) ? 204 : 404).end();
	}
}
