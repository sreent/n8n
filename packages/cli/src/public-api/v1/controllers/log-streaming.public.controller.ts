import {
	CreateLogStreamingDestinationPublicDto,
	UpdateLogStreamingDestinationPublicDto,
	LogStreamingDestinationListPublicDto,
	LogStreamingDestinationPublicDto,
	LogStreamingEventTypesPublicDto,
	LogStreamingTestResultPublicDto,
	logStreamingDestinationIdParamSchema,
} from '@n8n/api-types';
import { ModuleRegistry } from '@n8n/backend-common';
import { LICENSE_FEATURES } from '@n8n/constants';
import type { AuthenticatedRequest } from '@n8n/db';
import {
	ApiDescription,
	ApiErrorResponse,
	ApiKeyScope,
	ApiResponse,
	ApiSummary,
	ApiTags,
	Body,
	Delete,
	Get,
	Licensed,
	Param,
	Post,
	PublicApiController,
	Put,
} from '@n8n/decorators';
import { Container } from '@n8n/di';
import type { Response } from 'express';

import { ForbiddenError, NotFoundError, ServiceUnavailableError } from '@n8n/errors';
import { eventNamesAll } from '@/eventbus/event-message-classes';

const tags = ['LogStreaming'];

/*
 * Fork controller (upstream n8n calls its enterprise log streaming module here). The routes call
 * the fork module `log-streaming`. As in upstream n8n, they answer 403 without the licence value,
 * which the fork switch gives. They answer 503 while the module is off, as the promotions routes do.
 */
@PublicApiController('/settings/log-streaming')
export class LogStreamingPublicController {
	constructor(private readonly moduleRegistry: ModuleRegistry) {}

	@Get('/event-types')
	@ApiKeyScope('eventBusDestination:list')
	@Licensed(LICENSE_FEATURES.LOG_STREAMING)
	@ApiSummary('List streamable event types')
	@ApiDescription(
		'List the event types that can be streamed to a log streaming destination. Requires the `eventBusDestination:list` scope and the Log Streaming feature to be licensed.',
	)
	@ApiTags(tags)
	@ApiResponse(200, LogStreamingEventTypesPublicDto)
	@ApiErrorResponse(503)
	async getLogStreamingEventTypes(): Promise<LogStreamingEventTypesPublicDto> {
		this.assertModuleActive();
		return { data: eventNamesAll };
	}

	@Get('/destinations')
	@ApiKeyScope('eventBusDestination:list')
	@Licensed(LICENSE_FEATURES.LOG_STREAMING)
	@ApiSummary('List log streaming destinations')
	@ApiDescription(
		'List the configured log streaming destinations. Requires the `eventBusDestination:list` scope and the Log Streaming feature to be licensed.',
	)
	@ApiTags(tags)
	@ApiResponse(200, LogStreamingDestinationListPublicDto)
	@ApiErrorResponse(503)
	async getLogStreamingDestinations(): Promise<LogStreamingDestinationListPublicDto> {
		const { service, toPublicDestination } = await this.logStreaming();
		const destinations = await service.findDestinations();

		return { data: destinations.map(toPublicDestination) };
	}

	@Get('/destinations/:destinationId')
	@ApiKeyScope('eventBusDestination:read')
	@Licensed(LICENSE_FEATURES.LOG_STREAMING)
	@ApiSummary('Retrieve a log streaming destination')
	@ApiDescription(
		'Retrieve a single log streaming destination by id. Requires the `eventBusDestination:read` scope and the Log Streaming feature to be licensed.',
	)
	@ApiTags(tags)
	@ApiResponse(200, LogStreamingDestinationPublicDto)
	@ApiErrorResponse(404)
	@ApiErrorResponse(503)
	async getLogStreamingDestination(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('destinationId', logStreamingDestinationIdParamSchema) destinationId: string,
	): Promise<LogStreamingDestinationPublicDto> {
		const { service, toPublicDestination } = await this.logStreaming();

		return toPublicDestination(await service.findDestinationOrFail(destinationId));
	}

	@Post('/destinations')
	@ApiKeyScope('eventBusDestination:create')
	@Licensed(LICENSE_FEATURES.LOG_STREAMING)
	@ApiSummary('Create a log streaming destination')
	@ApiDescription(
		'Create a log streaming destination. The destination takes effect exactly as it would from the UI, using the same validation. Requires the `eventBusDestination:create` scope and the Log Streaming feature to be licensed. When destinations are managed via environment variables, the write is rejected with 409 and nothing is created; reads still return the current values.',
	)
	@ApiTags(tags)
	@ApiResponse(200, LogStreamingDestinationPublicDto)
	@ApiErrorResponse(409)
	@ApiErrorResponse(503)
	async createLogStreamingDestination(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: CreateLogStreamingDestinationPublicDto,
	): Promise<LogStreamingDestinationPublicDto> {
		const { service, fromPublicDestination, toPublicDestination } = await this.logStreaming();
		service.assertNotManagedByEnv();

		return toPublicDestination(
			await service.saveDestination(fromPublicDestination(body), req.user),
		);
	}

	/** Changes the fields of the body. The fields that the body leaves out keep their values. */
	@Put('/destinations/:destinationId')
	@ApiKeyScope('eventBusDestination:update')
	@Licensed(LICENSE_FEATURES.LOG_STREAMING)
	@ApiSummary('Update a log streaming destination')
	@ApiDescription(
		'Replace an existing log streaming destination. The update takes effect exactly as it would from the UI, using the same validation. Requires the `eventBusDestination:update` scope and the Log Streaming feature to be licensed. When destinations are managed via environment variables, the write is rejected with 409 and nothing is changed; reads still return the current values.',
	)
	@ApiTags(tags)
	@ApiResponse(200, LogStreamingDestinationPublicDto)
	@ApiErrorResponse(404)
	@ApiErrorResponse(409)
	@ApiErrorResponse(503)
	async updateLogStreamingDestination(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('destinationId', logStreamingDestinationIdParamSchema) destinationId: string,
		@Body body: UpdateLogStreamingDestinationPublicDto,
	): Promise<LogStreamingDestinationPublicDto> {
		const { service, fromPublicDestination, toPublicDestination } = await this.logStreaming();
		service.assertNotManagedByEnv();
		const { id } = await service.findDestinationOrFail(destinationId);

		return toPublicDestination(
			await service.saveDestination({ ...fromPublicDestination(body), id }, req.user),
		);
	}

	@Post('/destinations/:destinationId/test')
	@ApiKeyScope('eventBusDestination:test')
	@Licensed(LICENSE_FEATURES.LOG_STREAMING)
	@ApiSummary('Send a test message to a log streaming destination')
	@ApiDescription(
		'Send a test message to the destination to verify it is reachable and configured correctly. Requires the `eventBusDestination:test` scope and the Log Streaming feature to be licensed.',
	)
	@ApiTags(tags)
	@ApiResponse(200, LogStreamingTestResultPublicDto)
	@ApiErrorResponse(404)
	@ApiErrorResponse(503)
	async testLogStreamingDestination(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('destinationId', logStreamingDestinationIdParamSchema) destinationId: string,
	): Promise<LogStreamingTestResultPublicDto> {
		const { service } = await this.logStreaming();
		// A destination that does not take the test event is a failed test, not a server error.
		const success = await service
			.testDestination(destinationId, req.user)
			.catch((error: unknown) => {
				if (error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
				return false;
			});

		return { success };
	}

	@Delete('/destinations/:destinationId')
	@ApiKeyScope('eventBusDestination:delete')
	@Licensed(LICENSE_FEATURES.LOG_STREAMING)
	@ApiSummary('Delete a log streaming destination')
	@ApiDescription(
		'Remove a log streaming destination. Requires the `eventBusDestination:delete` scope and the Log Streaming feature to be licensed. When destinations are managed via environment variables, the delete is rejected with 409 and nothing is removed; reads still return the current values.',
	)
	@ApiTags(tags)
	@ApiResponse(200, LogStreamingDestinationPublicDto)
	@ApiErrorResponse(404)
	@ApiErrorResponse(409)
	@ApiErrorResponse(503)
	async deleteLogStreamingDestination(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('destinationId', logStreamingDestinationIdParamSchema) destinationId: string,
	): Promise<LogStreamingDestinationPublicDto> {
		const { service, toPublicDestination } = await this.logStreaming();

		return toPublicDestination(await service.deleteDestination(destinationId, req.user));
	}

	private assertModuleActive() {
		if (!this.moduleRegistry.isActive('log-streaming')) {
			throw new ServiceUnavailableError('The log streaming module is not enabled');
		}
	}

	/** The service and the helpers of the module. The routes load them only when the module is on. */
	private async logStreaming() {
		this.assertModuleActive();
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
}
