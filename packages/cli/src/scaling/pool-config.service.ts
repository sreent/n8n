import type { ProjectPoolSettingsResponse } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { CacheService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import { ProjectPoolSettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { IWorkflowExecutionDataProcess } from 'n8n-workflow';

import { DEFAULT_QUEUE_NAME, poolQueueName } from './queue-name';
import { WorkerPoolsService } from './worker-pools.service';

/** The queue and the worker pool of an execution. `undefined` means the default queue. */
export type ExecutionPool = {
	queueName: string | undefined;
	poolName: string | undefined;
};

/**
 * Fork code (not in upstream n8n): the worker pool of each project. With worker pools on and
 * licensed, the executions of a project with a pool go to the queue of the pool. The pool of a
 * project is in the table `project_pool_settings` and in the cache. It replaces the enterprise
 * service of the same name. See `./FORK.md`.
 */
@Service()
export class PoolConfigService {
	constructor(
		private readonly projectPoolSettingsRepository: ProjectPoolSettingsRepository,
		private readonly cacheService: CacheService,
		private readonly workerPoolsService: WorkerPoolsService,
		private readonly globalConfig: GlobalConfig,
		private readonly licenseState: LicenseState,
	) {}

	/** The queue of an execution: the queue of the pool of its project, or the default queue. */
	async resolvePoolForExecution(data: IWorkflowExecutionDataProcess): Promise<ExecutionPool> {
		const poolsActive =
			this.globalConfig.queue.workerPool.enabled && this.licenseState.isWorkerPoolsLicensed();
		const pool =
			poolsActive && data.projectId ? await this.getProjectDefaultPool(data.projectId) : null;

		if (!pool) return { queueName: DEFAULT_QUEUE_NAME, poolName: undefined };

		return { queueName: poolQueueName(pool), poolName: pool };
	}

	async getProjectPoolSettings(projectId: string): Promise<ProjectPoolSettingsResponse> {
		const [availablePools, defaultPool] = await Promise.all([
			this.workerPoolsService.getAvailablePools(),
			this.getProjectDefaultPool(projectId),
		]);
		return { defaultPool, availablePools };
	}

	/** Sets the pool of a project. An empty name or `null` sends the executions to the default queue. */
	async setProjectPoolSettings(
		projectId: string,
		defaultPool: string | null,
	): Promise<ProjectPoolSettingsResponse> {
		const pool = defaultPool || null;
		await this.projectPoolSettingsRepository.setDefaultPool(projectId, pool);
		await this.cacheService.delete(this.cacheKey(projectId));
		return { defaultPool: pool, availablePools: await this.workerPoolsService.getAvailablePools() };
	}

	private cacheKey(projectId: string) {
		return `projectPool:${projectId}`;
	}

	/** The pool of a project. The cache keeps an empty string for a project without a pool. */
	private async getProjectDefaultPool(projectId: string): Promise<string | null> {
		const key = this.cacheKey(projectId);
		const cached = await this.cacheService.get<string>(key);
		if (cached !== undefined) return cached || null;

		const pool = await this.projectPoolSettingsRepository.getDefaultPool(projectId);
		await this.cacheService.set(key, pool ?? '');
		return pool;
	}
}
