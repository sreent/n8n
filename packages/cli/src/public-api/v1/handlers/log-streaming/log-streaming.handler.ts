import { PublicCreateDestinationDto } from '@n8n/api-types';
import { ModuleRegistry } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import { BadRequestError, ForbiddenError, NotFoundError } from '@n8n/errors';
import type { NextFunction, Request, Response } from 'express';

import { eventNamesAll } from '@/eventbus/event-message-classes';

import type { LogStreamingRequest } from '../../../types';
import type { PublicAPIEndpoint } from '../../shared/handler.types';
import { apiKeyHasScopeWithGlobalScopeFallback } from '../../shared/middlewares/global.middleware';

/*
 * Fork handler (upstream n8n calls its enterprise log streaming module here). The routes call the
 * fork module `log-streaming`, and need no licence. They answer 403 while the module is off.
 */

const moduleIsActive = (_req: Request, res: Response, next: NextFunction) => {
	if (Container.get(ModuleRegistry).isActive('log-streaming')) return next();
	return res.status(403).json({ message: 'The log streaming module is turned off' });
};

/** The service and the helpers of the module. The routes load them only when the module is on. */
async function logStreaming() {
	const [{ LogStreamingService }, { fromPublicDestination, toPublicDestination }] =
		await Promise.all([
			import('@/modules/log-streaming/log-streaming.service.js'),
			import('@/modules/log-streaming/destinations/destination-options.js'),
		]);
	return {
		service: Container.get(LogStreamingService),
		fromPublicDestination,
		toPublicDestination,
	};
}

function parseDestination(body: unknown) {
	const result = PublicCreateDestinationDto.safeParse(body);
	if (!result.success) {
		throw new BadRequestError(result.error.errors[0]?.message ?? 'The body is not valid');
	}
	return result.data;
}

type LogStreamingHandlers = {
	getEventTypes: PublicAPIEndpoint<LogStreamingRequest.GetEventTypes>;
	getDestinations: PublicAPIEndpoint<LogStreamingRequest.GetDestinations>;
	getDestination: PublicAPIEndpoint<LogStreamingRequest.GetDestination>;
	createDestination: PublicAPIEndpoint<LogStreamingRequest.CreateDestination>;
	updateDestination: PublicAPIEndpoint<LogStreamingRequest.UpdateDestination>;
	testDestination: PublicAPIEndpoint<LogStreamingRequest.TestDestination>;
	deleteDestination: PublicAPIEndpoint<LogStreamingRequest.DeleteDestination>;
};

const logStreamingHandlers: LogStreamingHandlers = {
	getEventTypes: [
		moduleIsActive,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'eventBusDestination:list' }),
		async (_req, res) => {
			return res.json({ data: eventNamesAll });
		},
	],

	getDestinations: [
		moduleIsActive,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'eventBusDestination:list' }),
		async (_req, res) => {
			const { service, toPublicDestination } = await logStreaming();
			const destinations = await service.findDestinations();
			return res.json({ data: destinations.map(toPublicDestination) });
		},
	],

	getDestination: [
		moduleIsActive,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'eventBusDestination:read' }),
		async (req, res) => {
			const { service, toPublicDestination } = await logStreaming();
			return res.json(toPublicDestination(await service.findDestinationOrFail(req.params.id)));
		},
	],

	createDestination: [
		moduleIsActive,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'eventBusDestination:create' }),
		async (req, res) => {
			const { service, fromPublicDestination, toPublicDestination } = await logStreaming();
			service.assertNotManagedByEnv();
			const input = fromPublicDestination(parseDestination(req.body));
			return res.json(toPublicDestination(await service.saveDestination(input, req.user)));
		},
	],

	/** Changes the fields of the body. The fields that the body leaves out keep their values. */
	updateDestination: [
		moduleIsActive,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'eventBusDestination:update' }),
		async (req, res) => {
			const { service, fromPublicDestination, toPublicDestination } = await logStreaming();
			service.assertNotManagedByEnv();
			const { id } = await service.findDestinationOrFail(req.params.id);
			const input = { ...fromPublicDestination(parseDestination(req.body)), id };
			return res.json(toPublicDestination(await service.saveDestination(input, req.user)));
		},
	],

	testDestination: [
		moduleIsActive,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'eventBusDestination:test' }),
		async (req, res) => {
			const { service } = await logStreaming();
			// A destination that does not take the test event is a failed test, not a server error.
			const success = await service
				.testDestination(req.params.id, req.user)
				.catch((error: unknown) => {
					if (error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
					return false;
				});
			return res.json({ success });
		},
	],

	deleteDestination: [
		moduleIsActive,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'eventBusDestination:delete' }),
		async (req, res) => {
			const { service, toPublicDestination } = await logStreaming();
			return res.json(
				toPublicDestination(await service.deleteDestination(req.params.id, req.user)),
			);
		},
	],
};

export = logStreamingHandlers;
