import { Container } from '@n8n/di';
import type { RequestHandler } from 'express';

import { SOURCE_CONTROL_NOT_CONNECTED_MESSAGE } from './constants';
import { SourceControlPreferencesService } from './source-control-preferences.service';

/** The routes that need a connection answer 412 without one, as in the original. */
export const sourceControlConnectedMiddleware: RequestHandler = (_req, res, next) => {
	if (Container.get(SourceControlPreferencesService).isSourceControlConnected()) {
		next();
		return;
	}
	res.status(412).json({ status: 'error', message: SOURCE_CONTROL_NOT_CONNECTED_MESSAGE });
};
