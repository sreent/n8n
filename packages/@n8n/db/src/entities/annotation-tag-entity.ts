import { Column, Entity, Index, ManyToMany, OneToMany } from '@n8n/typeorm';
import { IsString, Length } from 'class-validator';

import { WithTimestampsAndStringId } from './abstract-entity';
import type { AnnotationTagMapping } from './annotation-tag-mapping';
import type { ExecutionAnnotation } from './execution-annotation';

/**
 * Fork code (not in upstream n8n): a tag for execution annotations. It replaces the enterprise
 * entity of the same name. See `packages/cli/src/executions/FORK.md`.
 */
@Entity({ name: 'annotation_tag_entity' })
export class AnnotationTagEntity extends WithTimestampsAndStringId {
	@Column({ length: 24 })
	@Index({ unique: true })
	@IsString({ message: 'Tag name must be of type string.' })
	@Length(1, 24, { message: 'Tag name must be $constraint1 to $constraint2 characters long.' })
	name: string;

	@ManyToMany('ExecutionAnnotation', 'tags')
	annotations: ExecutionAnnotation[];

	@OneToMany('AnnotationTagMapping', 'tags')
	annotationMappings: AnnotationTagMapping[];
}
