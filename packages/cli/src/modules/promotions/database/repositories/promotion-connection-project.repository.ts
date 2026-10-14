import { isUniqueConstraintError } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { PromotionConnectionProject } from '../entities/promotion-connection-project.entity';
import { PromotionRowConflictError } from '../promotion-row-conflict.error';

@Service()
export class PromotionConnectionProjectRepository extends Repository<PromotionConnectionProject> {
	constructor(dataSource: DataSource) {
		super(PromotionConnectionProject, dataSource.manager);
	}

	async findByProjectId(projectId: string) {
		return await this.findOneBy({ projectId });
	}

	/** The ids of the projects that a connection has links to, oldest link first. */
	async findProjectIds(connectionId: string) {
		const links = await this.find({
			where: { connectionId },
			order: { createdAt: 'ASC', projectId: 'ASC' },
		});
		return links.map(({ projectId }) => projectId);
	}

	/** Adds a link. A link of the project to any connection makes the primary key refuse it. */
	async insertLink(projectId: string, connectionId: string) {
		try {
			await this.insert({ projectId, connectionId });
		} catch (error) {
			if (isUniqueConstraintError(error)) throw new PromotionRowConflictError();
			throw error;
		}
	}
}
