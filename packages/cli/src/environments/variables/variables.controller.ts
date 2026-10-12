import {
	CreateVariableRequestDto,
	UpdateVariableRequestDto,
	VariableListRequestDto,
} from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	Licensed,
	Param,
	Patch,
	Post,
	Query,
	RestController,
} from '@n8n/decorators';
import { BadRequestError } from '@n8n/errors';
import { Response } from 'express';

import { VariableCountLimitReachedError } from '@/errors/variable-count-limit-reached.error';
import { VariableValidationError } from '@/errors/variable-validation.error';

import { VariablesService } from './variables.service';

/**
 * Fork code (not in upstream n8n): the REST API of the variables (`/rest/variables`). It replaces
 * the enterprise controller of the same name. The service checks the scopes of the user. A
 * change needs the licence feature `feat:variables`. See `FORK.md` in this folder.
 */
@RestController('/variables')
export class VariablesController {
	constructor(private readonly variablesService: VariablesService) {}

	@Get('/')
	async getVariables(
		req: AuthenticatedRequest,
		_res: Response,
		@Query query: VariableListRequestDto,
	) {
		return await this.variablesService.getAllForUser(req.user, query);
	}

	@Get('/:id')
	async getVariable(req: AuthenticatedRequest, _res: Response, @Param('id') id: string) {
		return await this.variablesService.getForUser(req.user, id);
	}

	@Post('/')
	@Licensed('feat:variables')
	async createVariable(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: CreateVariableRequestDto,
	) {
		return await asBadRequest(async () => await this.variablesService.create(req.user, payload));
	}

	@Patch('/:id')
	@Licensed('feat:variables')
	async updateVariable(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Body payload: UpdateVariableRequestDto,
	) {
		return await asBadRequest(
			async () => await this.variablesService.update(req.user, id, payload),
		);
	}

	@Delete('/:id')
	@Licensed('feat:variables')
	async deleteVariable(req: AuthenticatedRequest, _res: Response, @Param('id') id: string) {
		await this.variablesService.deleteForUser(req.user, id);
		return true;
	}
}

/** A taken key, a full quota and a key that is not valid are errors of the request. */
async function asBadRequest<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (
			error instanceof VariableCountLimitReachedError ||
			error instanceof VariableValidationError
		) {
			throw new BadRequestError(error.message);
		}
		throw error;
	}
}
