import type { AgentEvalResultStatus as ResultStatus } from '@n8n/api-types';
import { Column, Entity, Index, JoinColumn, ManyToOne } from '@n8n/typeorm';
import type { IDataObject, JsonObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { AgentEvalRun } from './agent-eval-run';

export type AgentEvalResultStatus = ResultStatus;

/**
 * Fork code (not in upstream n8n): the result of one case of an agent eval run. It replaces the
 * enterprise entity of the same name. See `FORK.md` in this folder.
 */
@Entity({ name: 'agent_eval_result' })
export class AgentEvalResult extends WithTimestampsAndStringId {
	@Index()
	@Column({ type: 'varchar', length: 36 })
	runId: string;

	@ManyToOne('AgentEvalRun', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'runId' })
	run?: AgentEvalRun;

	/** The row of the dataset, without a foreign key: the rows are outside n8n and can change. */
	@Column({ type: 'varchar', length: 255, nullable: true })
	sourceRowId: string | null;

	/** The position of the case in the run. */
	@Column({ type: 'int', nullable: true })
	runIndex: number | null;

	@Column({ type: 'varchar' })
	status: AgentEvalResultStatus;

	/** A copy of the input of the case, as the run used it. */
	@JsonColumn({ nullable: true })
	input: JsonObject | null;

	@JsonColumn({ nullable: true })
	output: JsonObject | null;

	@JsonColumn({ nullable: true })
	toolCalls: JsonObject | null;

	@JsonColumn({ nullable: true })
	metrics: IDataObject | null;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	@Column({ type: 'varchar', length: 255, nullable: true })
	errorCode: string | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;
}
