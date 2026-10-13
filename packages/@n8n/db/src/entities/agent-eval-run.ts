import type { AgentEvalRunStatus as RunStatus } from '@n8n/api-types';
import { Column, Entity, Index, JoinColumn, ManyToOne } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { AgentEvalDataset } from './agent-eval-dataset';

export type AgentEvalRunStatus = RunStatus;

/**
 * Fork code (not in upstream n8n): one run of an agent eval over the cases of its dataset. It
 * replaces the enterprise entity of the same name. See `FORK.md` in this folder.
 */
@Entity({ name: 'agent_eval_run' })
export class AgentEvalRun extends WithTimestampsAndStringId {
	@Index()
	@Column({ type: 'varchar', length: 36 })
	datasetId: string;

	/** The dataset of the run. Its agent is the agent under test. */
	@ManyToOne('AgentEvalDataset', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'datasetId' })
	dataset?: AgentEvalDataset;

	/** The published version of the agent (`agent_history.versionId`), without a foreign key. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	agentVersionId: string | null;

	@Column({ type: 'varchar' })
	status: AgentEvalRunStatus;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	/** The scores of the whole run. */
	@JsonColumn({ nullable: true })
	metrics: IDataObject | null;

	@Column({ type: 'varchar', length: 255, nullable: true })
	errorCode: string | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;

	/** The main instance that runs the run. It receives the cancellation. */
	@Column({ type: 'varchar', length: 255, nullable: true })
	runningInstanceId: string | null;

	/** Set when a user cancels the run. The running instance reads it. */
	@Column({ type: 'boolean', default: false })
	cancelRequested: boolean;

	@Column({ type: 'uuid', nullable: true })
	createdById: string | null;
}
