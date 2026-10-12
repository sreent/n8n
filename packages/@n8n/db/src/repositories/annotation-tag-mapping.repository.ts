import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AnnotationTagMapping } from '../entities';

/**
 * Fork repository (not in upstream n8n): the links between execution annotations and their tags.
 * See `packages/cli/src/executions/FORK.md`.
 */
@Service()
export class AnnotationTagMappingRepository extends Repository<AnnotationTagMapping> {
	constructor(dataSource: DataSource) {
		super(AnnotationTagMapping, dataSource.manager);
	}

	/**
	 * Replaces the tags of an annotation, in one transaction. A tag ID that does not exist fails on
	 * its foreign key, and a duplicate tag ID fails on the primary key. Then the old tags stay.
	 */
	async overwriteTags(annotationId: number, tagIds: string[]) {
		return await this.manager.transaction(async (tx) => {
			await tx.delete(AnnotationTagMapping, { annotationId });

			const tagMappings = tagIds.map((tagId) => this.create({ annotationId, tagId }));

			return await tx.insert(AnnotationTagMapping, tagMappings);
		});
	}
}
