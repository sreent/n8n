import type { AnnotationTagEntity } from '@n8n/db';
import { AnnotationTagRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { validateEntity } from '@/generic-helpers';

/**
 * Fork code (not in upstream n8n): the tags of execution annotations. It replaces the enterprise
 * service of the same name, and works as the ordinary `TagService` of workflow tags, without
 * external hooks. See `../executions/FORK.md`.
 */
@Service()
export class AnnotationTagService {
	constructor(private readonly annotationTagRepository: AnnotationTagRepository) {}

	toEntity(attrs: { name: string; id?: string }) {
		attrs.name = attrs.name.trim();

		return this.annotationTagRepository.create(attrs);
	}

	async save(tag: AnnotationTagEntity) {
		await validateEntity(tag);

		return await this.annotationTagRepository.save(tag, { transaction: false });
	}

	async delete(id: string) {
		return await this.annotationTagRepository.delete(id);
	}

	/**
	 * All tags, in the order of the database. With `withUsageCount`, each tag also has `usageCount`:
	 * the number of annotated executions with the tag.
	 */
	async getAll(options?: { withUsageCount: boolean }): Promise<AnnotationTagEntity[]> {
		if (options?.withUsageCount) {
			return await this.annotationTagRepository.findAllWithUsageCount();
		}

		return await this.annotationTagRepository.find({
			select: ['id', 'name', 'createdAt', 'updatedAt'],
		});
	}
}
