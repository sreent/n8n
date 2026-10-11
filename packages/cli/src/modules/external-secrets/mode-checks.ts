import { ForbiddenError } from '@n8n/errors';
import type { NextFunction, Response } from 'express';

import { sendErrorResponse } from '@/response-helper';

import type { ExternalSecretsConfig } from './external-secrets.config';

/**
 * Fork code (not in upstream n8n). The checks of the mode flags that the controllers of the
 * connections API run before each route. They answer 403 when the mode does not allow the route.
 */
export function checkMode(allowed: boolean, message: string, res: Response, next: NextFunction) {
	if (allowed) {
		next();
		return;
	}
	sendErrorResponse(res, new ForbiddenError(message));
}

export const usesConnections = (config: ExternalSecretsConfig) =>
	config.externalSecretsForProjects || config.externalSecretsMultipleConnections;

export const CONNECTIONS_DISABLED =
	'Requested beta external secret endpoint without feature flag enabled';
export const PROJECTS_DISABLED = 'External secrets for projects feature is not enabled';
export const MULTIPLE_CONNECTIONS_DISABLED =
	'External secrets multiple connections feature is not enabled';
export const ROLE_BASED_ACCESS_DISABLED = 'Role-based access for external secrets is not enabled';
