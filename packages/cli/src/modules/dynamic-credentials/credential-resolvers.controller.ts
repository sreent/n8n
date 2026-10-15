import {
	CreateCredentialResolverDto,
	ListCredentialResolversQueryDto,
	UpdateCredentialResolverDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	CredentialResolverError,
	Delete,
	Get,
	GlobalScope,
	Param,
	Patch,
	Post,
	Query,
	RestController,
} from '@n8n/decorators';
import { BadRequestError, NotFoundError } from '@n8n/errors';
import type { Response } from 'express';

import { DynamicCredentialResolverNotFoundError } from './errors/credential-resolver-not-found.error';
import { SystemResolverModificationError } from './errors/system-resolver-modification.error';
import { CredentialResolverService } from './services/credential-resolver.service';

/** Maps the errors of the service to the answers of the API. */
async function answer<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof DynamicCredentialResolverNotFoundError) {
			throw new NotFoundError(error.message);
		}
		if (
			error instanceof SystemResolverModificationError ||
			error instanceof CredentialResolverError
		) {
			throw new BadRequestError(error.message);
		}
		throw error;
	}
}

/**
 * Fork code (not in upstream n8n): the REST API of the credential resolvers
 * (`/rest/credential-resolvers`). See `README.md` in this folder.
 */
@RestController('/credential-resolvers')
export class CredentialResolversController {
	constructor(private readonly service: CredentialResolverService) {}

	@Get('/')
	@GlobalScope('credentialResolver:list')
	async listResolvers(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: ListCredentialResolversQueryDto,
	) {
		return await this.service.findAll(query.includeSystem === true);
	}

	@Get('/types')
	@GlobalScope('credentialResolver:list')
	listResolverTypes() {
		return this.service.listTypes();
	}

	@Post('/')
	@GlobalScope('credentialResolver:create')
	async createResolver(
		_req: AuthenticatedRequest,
		_res: Response,
		@Body dto: CreateCredentialResolverDto,
	) {
		return await answer(async () => await this.service.create(dto));
	}

	@Get('/:id/workflows')
	@GlobalScope('credentialResolver:read')
	async getAffectedWorkflows(_req: AuthenticatedRequest, _res: Response, @Param('id') id: string) {
		return await answer(async () => await this.service.findAffectedWorkflows(id));
	}

	@Get('/:id')
	@GlobalScope('credentialResolver:read')
	async getResolver(_req: AuthenticatedRequest, _res: Response, @Param('id') id: string) {
		return await answer(async () => await this.service.findById(id));
	}

	@Patch('/:id')
	@GlobalScope('credentialResolver:update')
	async updateResolver(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body dto: UpdateCredentialResolverDto,
	) {
		return await answer(async () => await this.service.update(id, dto));
	}

	@Delete('/:id')
	@GlobalScope('credentialResolver:delete')
	async deleteResolver(_req: AuthenticatedRequest, _res: Response, @Param('id') id: string) {
		await answer(async () => await this.service.delete(id));
		return { success: true };
	}
}
