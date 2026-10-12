import { Column, Entity, Index, PrimaryColumn } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { JsonColumn, WithTimestamps } from './abstract-entity';

/**
 * Fork code (not in upstream n8n): a collection of test runs of one evaluation config, to compare
 * versions of a workflow. It replaces the enterprise entity of the same name. See `FORK.md` in
 * this folder.
 */
@Entity({ name: 'evaluation_collection' })
export class EvaluationCollection extends WithTimestamps {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	id: string;

	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'text', nullable: true })
	description: string | null;

	@Index()
	@Column({ type: 'varchar', length: 36 })
	workflowId: string;

	@Index()
	@Column({ type: 'varchar', length: 36 })
	evaluationConfigId: string;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;

	/** The last AI insights of the collection, to give them again without a new model call. */
	@JsonColumn({ nullable: true })
	insightsCache: IDataObject | null;
}
