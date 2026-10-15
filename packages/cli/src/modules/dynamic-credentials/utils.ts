import { timingSafeEqual } from 'node:crypto';

import { isAuthenticatedRequest } from '@n8n/db';
import { Container } from '@n8n/di';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { DynamicCredentialsConfig } from './dynamic-credentials.config';
import { DynamicCredentialCorsService } from './services/dynamic-credential-cors.service';

/** Compares two texts in a time that does not depend on where they differ. */
function sameText(given: string, expected: string) {
	const left = Buffer.from(given);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The middleware of an endpoint that an external application can call: it adds the CORS
 * headers, and lets a request through when it has an n8n session or the endpoint token of
 * `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN` in `X-Authorization: Bearer <token>`.
 */
export function getDynamicCredentialMiddlewares(methods: string): RequestHandler[] {
	return [
		(req: Request, res: Response, next: NextFunction) => {
			Container.get(DynamicCredentialCorsService).applyHeaders(req, res, methods);
			if (isAuthenticatedRequest(req)) {
				next();
				return;
			}
			const { endpointAuthToken } = Container.get(DynamicCredentialsConfig);
			const header = req.headers['x-authorization'];
			if (
				endpointAuthToken.length > 0 &&
				typeof header === 'string' &&
				sameText(header, `Bearer ${endpointAuthToken}`)
			) {
				next();
				return;
			}
			res.status(401).send('Unauthorized');
		},
	];
}
