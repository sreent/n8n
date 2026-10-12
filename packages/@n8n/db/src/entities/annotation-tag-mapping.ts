import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from '@n8n/typeorm';

import type { AnnotationTagEntity } from './annotation-tag-entity';
import type { ExecutionAnnotation } from './execution-annotation';

/**
 * Fork code (not in upstream n8n): a tag of an execution annotation. It replaces the enterprise
 * entity of the same name. See `packages/cli/src/executions/FORK.md`.
 */
@Entity({ name: 'execution_annotation_tags' })
export class AnnotationTagMapping {
	@PrimaryColumn()
	annotationId: number;

	@ManyToOne('ExecutionAnnotation', 'tagMappings')
	@JoinColumn({ name: 'annotationId' })
	annotations: ExecutionAnnotation[];

	@PrimaryColumn()
	tagId: string;

	@ManyToOne('AnnotationTagEntity', 'annotationMappings')
	@JoinColumn({ name: 'tagId' })
	tags: AnnotationTagEntity[];
}
