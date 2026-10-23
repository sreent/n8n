import {
	CreateDestinationDto,
	DeleteDestinationQueryDto,
	GetDestinationQueryDto,
	TestDestinationQueryDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Delete, Get, GlobalScope, Post, Query, RestController } from '@n8n/decorators';
import { BadRequestError } from '@n8n/errors';
import type { Response } from 'express';

import { eventNamesAll } from '@/eventbus/event-message-classes';

import { LogStreamingService } from './log-streaming.service';

/**
 * The log streaming destinations, for users with the global scope `logStreaming:manage`: the owner
 * and admins.
 */
@RestController('/eventbus')
export class LogStreamingController {
	constructor(private readonly logStreamingService: LogStreamingService) {}

	/** The names of the events that a destination can subscribe to. */
	@Get('/eventnames')
	@GlobalScope('logStreaming:manage')
	eventNames() {
		return eventNamesAll;
	}

	@Get('/destination')
	@GlobalScope('logStreaming:manage')
	async getDestinations(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: GetDestinationQueryDto,
	) {
		return await this.logStreamingService.findDestinations(query.id);
	}

	/** Adds a destination, or changes the destination with the id of the body. */
	@Post('/destination')
	@GlobalScope('logStreaming:manage')
	async saveDestination(req: AuthenticatedRequest) {
		// The body is a union of the destination kinds, which the route arguments cannot validate.
		const result = CreateDestinationDto.safeParse(req.body);
		if (!result.success) {
			const [issue] = result.error.issues;
			throw new BadRequestError(
				issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The body is not valid',
			);
		}
		return await this.logStreamingService.saveDestination(result.data, req.user);
	}

	@Delete('/destination')
	@GlobalScope('logStreaming:manage')
	async deleteDestination(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: DeleteDestinationQueryDto,
	) {
		await this.logStreamingService.deleteDestination(query.id, req.user);
		return true;
	}

	/** Sends a test event to a destination. The answer tells if the destination took it. */
	@Get('/testmessage')
	@GlobalScope('logStreaming:manage')
	async sendTestMessage(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: TestDestinationQueryDto,
	) {
		return await this.logStreamingService.testDestination(query.id, req.user);
	}
}
