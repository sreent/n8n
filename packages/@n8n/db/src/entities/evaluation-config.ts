import type { DatasetRef, EvaluationConfigStatus, EvaluationMetric } from '@n8n/api-types';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, Unique } from '@n8n/typeorm';

import { JsonColumn, WithTimestamps } from './abstract-entity';
import type { WorkflowEntity } from './workflow-entity';

/**
 * Fork code (not in upstream n8n): a saved evaluation of a workflow: the dataset, the part of the
 * workflow under test and the metrics. It replaces the enterprise entity of the same name. See
 * `FORK.md` in this folder.
 */
@Entity({ name: 'evaluation_config' })
@Unique(['workflowId', 'name'])
export class EvaluationConfig extends WithTimestamps {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	id: string;

	@Index()
	@Column({ type: 'varchar', length: 36 })
	workflowId: string;

	@ManyToOne('WorkflowEntity', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'workflowId' })
	workflow?: WorkflowEntity;

	@Column({ type: 'varchar', length: 128 })
	name: string;

	/** `invalid` when a change of the workflow broke the config. `invalidReason` tells why. */
	@Column({ type: 'varchar', length: 16, default: 'valid' })
	status: EvaluationConfigStatus;

	@Column({ type: 'varchar', length: 64, nullable: true })
	invalidReason: string | null;

	@Column({ type: 'varchar', length: 32 })
	datasetSource: DatasetRef['datasetSource'];

	@JsonColumn()
	datasetRef: DatasetRef['datasetRef'];

	/** The node where the part of the workflow under test starts. */
	@Column({ type: 'varchar', length: 255 })
	startNodeName: string;

	/** The node whose output the metrics score. */
	@Column({ type: 'varchar', length: 255 })
	endNodeName: string;

	@JsonColumn()
	metrics: EvaluationMetric[];
}
