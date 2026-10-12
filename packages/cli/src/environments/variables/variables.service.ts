import {
	NEW_VARIABLE_KEY_REGEX,
	type CreateVariableRequestDto,
	type UpdateVariableRequestDto,
} from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { CacheService, EventService } from '@n8n/backend-services';
import type { User, Variables } from '@n8n/db';
import { generateNanoId, ProjectRepository, VariablesRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { ForbiddenError, NotFoundError } from '@n8n/errors';
import { hasGlobalScope, type Scope } from '@n8n/permissions';

import { VariableCountLimitReachedError } from '@/errors/variable-count-limit-reached.error';
import { VariableValidationError } from '@/errors/variable-validation.error';
import { userHasScopes } from '@/permissions/check-access';

const CACHE_KEY = 'variables';
const UNLIMITED = -1;

/** The variables of a user: `state: 'empty'` keeps those without a value, `projectId: null` the global ones. */
export interface VariablesFilter {
	state?: 'empty';
	projectId?: string | null;
}

/**
 * Fork code (not in upstream n8n): the variables (`$vars`) of the instance and of projects. It
 * replaces the enterprise service of the same name. All variables, with their projects, stay in
 * the cache, and each change updates it. See `FORK.md` in this folder.
 */
@Service()
export class VariablesService {
	constructor(
		private readonly cacheService: CacheService,
		private readonly variablesRepository: VariablesRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly eventService: EventService,
		private readonly licenseState: LicenseState,
	) {}

	/** All variables of the instance, with their projects. */
	async getAllCached(): Promise<Variables[]> {
		const variables = await this.cacheService.get<Variables[]>(CACHE_KEY, {
			refreshFn: async () => await this.findAll(),
		});
		return variables ?? [];
	}

	async getCached(id: string): Promise<Variables | null> {
		return (await this.getAllCached()).find((variable) => variable.id === id) ?? null;
	}

	/** Reads all variables from the database into the cache. */
	async updateCache(): Promise<void> {
		await this.cacheService.set(CACHE_KEY, await this.findAll());
	}

	/** The variables that the user may read, after the filter. */
	async getAllForUser(user: User, filter: VariablesFilter = {}): Promise<Variables[]> {
		const variables = (await this.getAllCached()).filter(
			(variable) =>
				(filter.state !== 'empty' || !variable.value) &&
				(filter.projectId === undefined ||
					(filter.projectId === null
						? !variable.project
						: variable.project?.id === filter.projectId)),
		);

		// One check for each scope, not for each variable.
		const access = new Map<string | undefined, Promise<boolean>>();
		const readable = await Promise.all(
			variables.map(async (variable) => {
				const projectId = variable.project?.id;
				let allowed = access.get(projectId);
				if (!allowed) {
					allowed = this.userMay(user, projectId, 'variable:list', 'projectVariable:list');
					access.set(projectId, allowed);
				}
				return await allowed;
			}),
		);
		return variables.filter((_, index) => readable[index]);
	}

	/** One variable that the user may read. */
	async getForUser(user: User, id: string): Promise<Variables> {
		const variable = await this.getCached(id);
		if (!variable) throw new NotFoundError(`Variable with id ${id} not found`);

		if (
			!(await this.userMay(user, variable.project?.id, 'variable:read', 'projectVariable:read'))
		) {
			throw new ForbiddenError('You are not allowed to access this variable');
		}

		return variable;
	}

	async create(user: User, variable: CreateVariableRequestDto): Promise<Variables> {
		const { projectId } = variable;
		if (projectId) {
			if (!(await this.userMayInProject(user, projectId, 'projectVariable:create'))) {
				throw new ForbiddenError('You are not allowed to create a variable in this project');
			}
		} else if (!hasGlobalScope(user, 'variable:create')) {
			throw new ForbiddenError('You are not allowed to create a variable');
		}

		const quota = await this.getRemainingVariableQuota();
		if (quota && quota.remaining <= 0) {
			throw new VariableCountLimitReachedError('Variables limit reached');
		}
		await this.assertKeyIsFree(variable.key, projectId);

		const saved = await this.variablesRepository.save({
			...variable,
			id: generateNanoId(),
			project: projectId ? { id: projectId } : null,
		});
		await this.updateCache();

		this.eventService.emit('variable-created', {
			user,
			variableId: saved.id,
			variableKey: saved.key,
			...(projectId ? { projectId } : {}),
		});

		return saved;
	}

	async update(user: User, id: string, variable: UpdateVariableRequestDto): Promise<Variables> {
		const current = await this.getCached(id);
		if (!current) throw new NotFoundError(`Variable with id ${id} not found`);

		const currentProjectId = current.project?.id;
		if (
			!(await this.userMay(user, currentProjectId, 'variable:update', 'projectVariable:update'))
		) {
			throw new ForbiddenError('You are not allowed to update this variable');
		}

		// `projectId: null` moves the variable to the global scope. Without `projectId`, it stays.
		const targetProjectId =
			variable.projectId === undefined ? currentProjectId : (variable.projectId ?? undefined);
		if (targetProjectId !== currentProjectId) {
			if (!targetProjectId) {
				if (!hasGlobalScope(user, 'variable:create')) {
					throw new ForbiddenError('You are not allowed to move this variable to the global scope');
				}
			} else if (!(await this.userMayInProject(user, targetProjectId, 'projectVariable:create'))) {
				throw new ForbiddenError(
					'You are not allowed to move this variable to the specified project',
				);
			}
		}

		const { key, type, value } = variable;
		if (key !== undefined && key !== current.key && !NEW_VARIABLE_KEY_REGEX.test(key)) {
			throw new VariableValidationError(
				"When changing the variable key, it can only contain letters, numbers, and underscores (A-Za-z0-9_). Existing keys that don't follow this rule can be kept as-is for backwards-compatibility",
			);
		}
		await this.assertKeyIsFree(key ?? current.key, targetProjectId, id);

		await this.variablesRepository.update(id, {
			...(key !== undefined ? { key } : {}),
			...(type !== undefined ? { type } : {}),
			...(value !== undefined ? { value } : {}),
			...(variable.projectId !== undefined
				? { project: targetProjectId ? { id: targetProjectId } : null }
				: {}),
		});
		await this.updateCache();

		const updated = await this.variablesRepository.findOneOrFail({
			where: { id },
			relations: { project: true },
		});

		this.eventService.emit('variable-updated', {
			user,
			variableId: updated.id,
			variableKey: updated.key,
			...(updated.project ? { projectId: updated.project.id } : {}),
		});

		return updated;
	}

	/** Deletes a variable. A variable that does not exist needs the global scope. */
	async deleteForUser(user: User, id: string): Promise<void> {
		const variable = await this.getCached(id);
		const projectId = variable?.project?.id;
		if (!(await this.userMay(user, projectId, 'variable:delete', 'projectVariable:delete'))) {
			throw new ForbiddenError('You are not allowed to delete this variable');
		}

		await this.variablesRepository.delete(id);
		await this.updateCache();

		this.eventService.emit('variable-deleted', {
			user,
			variableId: id,
			variableKey: variable?.key ?? '',
			...(projectId ? { projectId } : {}),
		});
	}

	/** Deletes variables without a check of the user, for example in an import. */
	async deleteByIds(ids: string[]): Promise<void> {
		await this.variablesRepository.deleteByIds(ids);
		await this.updateCache();
	}

	/**
	 * The quota of the licence (`quota:maxVariables`), for all variables together. `null` means no
	 * limit.
	 */
	async getRemainingVariableQuota(): Promise<{ limit: number; remaining: number } | null> {
		const limit = this.licenseState.getMaxVariables();
		if (limit === UNLIMITED) return null;

		const count = (await this.getAllCached()).length;
		return { limit, remaining: Math.max(0, limit - count) };
	}

	private async findAll() {
		return await this.variablesRepository.find({ relations: { project: true } });
	}

	/** A key is unique in its scope: among the global variables, or in one project. */
	private async assertKeyIsFree(key: string, projectId: string | undefined, ownId?: string) {
		const taken = (await this.getAllCached()).some(
			(variable) =>
				variable.id !== ownId &&
				variable.key === key &&
				(projectId ? variable.project?.id === projectId : !variable.project),
		);
		if (!taken) return;

		// The import of packages catches this error class for a key that is taken.
		throw new VariableCountLimitReachedError(
			projectId
				? `A variable with key "${key}" already exists in the specified project`
				: `A global variable with key "${key}" already exists`,
		);
	}

	/** Whether the user holds the global scope, or the project scope in the project. */
	private async userMay(
		user: User,
		projectId: string | undefined,
		globalScope: Scope,
		projectScope: Scope,
	) {
		if (!projectId) return hasGlobalScope(user, globalScope);
		return await userHasScopes(user, [projectScope], false, { projectId });
	}

	/** Whether the project exists, and the user holds the scope in it. */
	private async userMayInProject(user: User, projectId: string, scope: Scope) {
		const project = await this.projectRepository.findOneBy({ id: projectId });
		if (!project) return false;
		return await userHasScopes(user, [scope], false, { projectId });
	}
}
