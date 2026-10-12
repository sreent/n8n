import { Delete, Get, GlobalScope, Patch, Post, RestController } from '@n8n/decorators';

import { AnnotationTagsRequest } from '@/requests';
import { AnnotationTagService } from '@/services/annotation-tag.service';

/**
 * Fork code (not in upstream n8n): the REST API of the tags of execution annotations. It replaces
 * the enterprise controller of the same path. The routes need the global scopes
 * `annotationTag:*`, and no licence. See `../executions/FORK.md`.
 */
@RestController('/annotation-tags')
export class AnnotationTagsController {
	constructor(private readonly annotationTagService: AnnotationTagService) {}

	@Get('/')
	@GlobalScope('annotationTag:list')
	async getAll(req: AnnotationTagsRequest.GetAll) {
		return await this.annotationTagService.getAll({
			withUsageCount: req.query.withUsageCount === 'true',
		});
	}

	@Post('/')
	@GlobalScope('annotationTag:create')
	async createTag(req: AnnotationTagsRequest.Create) {
		const tag = this.annotationTagService.toEntity({ name: req.body.name });

		return await this.annotationTagService.save(tag);
	}

	@Patch('/:id')
	@GlobalScope('annotationTag:update')
	async updateTag(req: AnnotationTagsRequest.Update) {
		const newTag = this.annotationTagService.toEntity({
			id: req.params.id,
			name: req.body.name,
		});

		return await this.annotationTagService.save(newTag);
	}

	@Delete('/:id')
	@GlobalScope('annotationTag:delete')
	async deleteTag(req: AnnotationTagsRequest.Delete) {
		await this.annotationTagService.delete(req.params.id);

		return true;
	}
}
