import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { ProjectPoolSettings } from '../entities';

/**
 * Fork code (not in upstream n8n): the worker pool of each project. It replaces the enterprise
 * repository of the same name. See `../entities/FORK.md`.
 */
@Service()
export class ProjectPoolSettingsRepository extends Repository<ProjectPoolSettings> {
	constructor(dataSource: DataSource) {
		super(ProjectPoolSettings, dataSource.manager);
	}

	/** The pool of a project, or `null` when the project has no pool. */
	async getDefaultPool(projectId: string): Promise<string | null> {
		const settings = await this.findOneBy({ projectId });
		return settings?.defaultPool ?? null;
	}

	/** Sets the pool of a project. `null` sends its executions to the default queue. */
	async setDefaultPool(projectId: string, defaultPool: string | null): Promise<void> {
		await this.upsert({ projectId, defaultPool }, ['projectId']);
	}
}
