import type { AgentEvalColumnMapping as ColumnMapping, DatasetRef } from '@n8n/api-types';
import { Column, Entity, Index } from '@n8n/typeorm';

import { JsonColumn, WithTimestampsAndStringId } from './abstract-entity';

/** The dataset columns for the roles of an agent eval: the input, the expected output and the criteria. */
export type AgentEvalColumnMapping = ColumnMapping;

/**
 * Fork code (not in upstream n8n): a dataset of an agent eval. It points at a Data Table or a
 * Google Sheet that holds the cases. It replaces the enterprise entity of the same name. See
 * `FORK.md` in this folder.
 */
@Entity({ name: 'agent_eval_dataset' })
export class AgentEvalDataset extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'text', nullable: true })
	description: string | null;

	/** The agent under test. The table of agents belongs to the agents module of the CLI. */
	@Index()
	@Column({ type: 'varchar', length: 36 })
	agentId: string;

	@Column({ type: 'varchar', length: 32 })
	datasetSource: DatasetRef['datasetSource'];

	/** Where the cases are, for example `{ dataTableId }`. The shape depends on `datasetSource`. */
	@JsonColumn()
	datasetRef: DatasetRef['datasetRef'];

	@JsonColumn({ nullable: true })
	columnMapping: AgentEvalColumnMapping | null;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;
}
