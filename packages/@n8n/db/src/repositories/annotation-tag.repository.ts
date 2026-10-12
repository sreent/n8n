import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AnnotationTagEntity } from '../entities';

/**
 * Fork repository (not in upstream n8n): the tags of execution annotations. See
 * `packages/cli/src/executions/FORK.md`.
 */
@Service()
export class AnnotationTagRepository extends Repository<AnnotationTagEntity> {
	constructor(dataSource: DataSource) {
		super(AnnotationTagEntity, dataSource.manager);
	}

	/**
	 * All tags, in the order of the database. Each tag also has `usageCount`: the number of
	 * annotated executions with the tag.
	 */
	async findAllWithUsageCount(): Promise<AnnotationTagEntity[]> {
		return await this.createQueryBuilder('tag')
			.select(['tag.id', 'tag.name', 'tag.createdAt', 'tag.updatedAt'])
			.loadRelationCountAndMap('tag.usageCount', 'tag.annotationMappings')
			.getMany();
	}
}
