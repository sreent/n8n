import {
	Column,
	Entity,
	Index,
	JoinColumn,
	JoinTable,
	ManyToMany,
	OneToMany,
	OneToOne,
	PrimaryGeneratedColumn,
	RelationId,
} from '@n8n/typeorm';
import type { AnnotationVote } from 'n8n-workflow';

import { WithTimestamps } from './abstract-entity';
import type { AnnotationTagEntity } from './annotation-tag-entity';
import type { AnnotationTagMapping } from './annotation-tag-mapping';
import type { ExecutionEntity } from './execution-entity';

/**
 * Fork code (not in upstream n8n): the annotation of an execution, with its vote and tags. It
 * replaces the enterprise entity of the same name. See `packages/cli/src/executions/FORK.md`.
 */
@Entity({ name: 'execution_annotations' })
export class ExecutionAnnotation extends WithTimestamps {
	@PrimaryGeneratedColumn()
	id: number;

	/** The rating of the execution. `null` when there is no rating. */
	@Column('varchar', { length: 6, nullable: true })
	vote: AnnotationVote | null;

	@Column('text', { nullable: true })
	note: string | null;

	@RelationId((annotation: ExecutionAnnotation) => annotation.execution)
	@Column()
	executionId: string;

	@Index({ unique: true })
	@OneToOne('ExecutionEntity', 'annotation', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'executionId' })
	execution: ExecutionEntity;

	@ManyToMany('AnnotationTagEntity', 'annotations')
	@JoinTable({
		name: 'execution_annotation_tags',
		joinColumn: { name: 'annotationId', referencedColumnName: 'id' },
		inverseJoinColumn: { name: 'tagId', referencedColumnName: 'id' },
	})
	tags?: AnnotationTagEntity[];

	@OneToMany('AnnotationTagMapping', 'annotations')
	tagMappings: AnnotationTagMapping[];
}
