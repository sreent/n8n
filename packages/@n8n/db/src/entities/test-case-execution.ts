import type { TestCaseExecutionStatusPublic } from '@n8n/api-types';
import { Column, Entity, JoinColumn, ManyToOne, OneToOne } from '@n8n/typeorm';
import type { IDataObject, JsonObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithStringId } from './abstract-entity';
import type { ExecutionEntity } from './execution-entity';
import type { TestRun } from './test-run';
import type { TestCaseExecutionErrorCode } from './types-db';

/** The states of one case of a test run. */
export type TestCaseExecutionStatus = TestCaseExecutionStatusPublic;

/**
 * Fork code (not in upstream n8n): one case of a test run, that is one row of the dataset and
 * the execution of the workflow for it. It replaces the enterprise entity of the same name. See
 * `FORK.md` in this folder.
 *
 * The table has `createdAt` and `updatedAt` columns with database defaults, but the entity does
 * not map them.
 */
@Entity({ name: 'test_case_execution' })
export class TestCaseExecution extends WithStringId {
	@ManyToOne('TestRun')
	@JoinColumn({ name: 'testRunId' })
	testRun: TestRun;

	@OneToOne('ExecutionEntity', { onDelete: 'SET NULL', nullable: true })
	execution: ExecutionEntity | null;

	/** The execution of the workflow for this case. The column is an integer. */
	@Column({ type: 'varchar', nullable: true })
	executionId: string | null;

	@Column()
	status: TestCaseExecutionStatus;

	/** The position of the row in the dataset, from 0. */
	@Column({ type: 'integer', nullable: true })
	runIndex: number | null;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	@Column('varchar', { nullable: true })
	errorCode: TestCaseExecutionErrorCode | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;

	@JsonColumn({ nullable: true })
	metrics: Record<string, number | boolean> | null;

	/** The inputs of the case, from the Set Inputs operation of the Evaluation node. */
	@JsonColumn({ nullable: true })
	inputs: JsonObject | null;

	/** The outputs of the case, from the Set Outputs operation of the Evaluation node. */
	@JsonColumn({ nullable: true })
	outputs: JsonObject | null;
}
