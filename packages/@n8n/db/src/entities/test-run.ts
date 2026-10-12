import type { TestRunStatusPublic } from '@n8n/api-types';
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from './abstract-entity';
import type { TestCaseExecution } from './test-case-execution';
import type { AggregatedTestRunMetrics, TestRunErrorCode, TestRunFinalResult } from './types-db';
import type { WorkflowEntity } from './workflow-entity';

/** The states of a test run: `new` until it starts, then `running`, then one of the end states. */
export type TestRunStatus = TestRunStatusPublic;

/**
 * Fork code (not in upstream n8n): one run of the evaluation of a workflow over the rows of its
 * dataset. It replaces the enterprise entity of the same name. See `FORK.md` in this folder.
 */
@Entity({ name: 'test_run' })
export class TestRun extends WithTimestampsAndStringId {
	@Column('varchar')
	status: TestRunStatus;

	@DateTimeColumn({ nullable: true })
	runAt: Date | null;

	@DateTimeColumn({ nullable: true })
	completedAt: Date | null;

	/** The average of each metric over the cases of the run. */
	@JsonColumn({ nullable: true })
	metrics: AggregatedTestRunMetrics | null;

	@Column({ type: 'varchar', length: 255, nullable: true })
	errorCode: TestRunErrorCode | null;

	@JsonColumn({ nullable: true })
	errorDetails: IDataObject | null;

	@OneToMany('TestCaseExecution', 'testRun')
	testCaseExecutions: TestCaseExecution[];

	@ManyToOne('WorkflowEntity')
	@JoinColumn({ name: 'workflowId' })
	workflow: WorkflowEntity;

	@Column({ type: 'varchar', length: 255 })
	workflowId: string;

	/** The main instance that runs the test run. A cancellation goes to this instance. */
	@Column({ type: 'varchar', length: 255, nullable: true })
	runningInstanceId: string | null;

	/** Set when a user cancels the run. The running instance reads it before each case. */
	@Column({ type: 'boolean', default: false })
	cancelRequested: boolean;

	/** The version of the workflow that the run used (`workflow_history.versionId`), without a foreign key. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	workflowVersionId: string | null;

	/** The evaluation config that the run used, if any. */
	@Index()
	@Column({ type: 'varchar', length: 36, nullable: true })
	evaluationConfigId: string | null;

	/** A copy of the config at the start of the run, so that later edits do not change its results. */
	@JsonColumn({ nullable: true })
	evaluationConfigSnapshot: IDataObject | null;

	@Index()
	@Column({ type: 'varchar', length: 36, nullable: true })
	collectionId: string | null;

	/** The most severe status of the cases. The summary queries set it; it is not a column. */
	finalResult?: TestRunFinalResult | null;
}
