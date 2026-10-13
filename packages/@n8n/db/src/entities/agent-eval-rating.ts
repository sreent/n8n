import type { AgentEvalVote as Vote } from '@n8n/api-types';
import { Column, Entity, Index, JoinColumn, ManyToOne } from '@n8n/typeorm';
import type { JsonObject } from 'n8n-workflow';

import { JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { AgentEvalResult } from './agent-eval-result';

export type AgentEvalVote = Vote;

/**
 * Fork code (not in upstream n8n): the vote of a user on the result of one case, with an optional
 * comment and a corrected answer. A result keeps all of its ratings. It replaces the enterprise
 * entity of the same name. See `FORK.md` in this folder.
 */
@Entity({ name: 'agent_eval_rating' })
export class AgentEvalRating extends WithTimestampsAndStringId {
	@Index()
	@Column({ type: 'varchar', length: 36 })
	resultId: string;

	@ManyToOne('AgentEvalResult', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'resultId' })
	result?: AgentEvalResult;

	@Column({ type: 'varchar', length: 8 })
	vote: AgentEvalVote;

	@Column({ type: 'text', nullable: true })
	comment: string | null;

	/** The answer that the user expected instead. */
	@JsonColumn({ nullable: true })
	correction: JsonObject | null;

	@Column({ type: 'uuid', nullable: true })
	ratedById: string | null;
}
