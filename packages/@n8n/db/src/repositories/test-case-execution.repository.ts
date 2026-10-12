import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';
import type { JsonObject } from 'n8n-workflow';

import type { TestCaseExecutionStatus } from '../entities/test-case-execution';
import { TestCaseExecution } from '../entities/test-case-execution';
import type { TestCaseExecutionErrorCode } from '../entities/types-db';

/** The case states that a cancellation ends: the case has not finished yet. */
const PENDING_STATUSES: TestCaseExecutionStatus[] = ['new', 'running', 'evaluation_running'];

/**
 * Fork repository (not in upstream n8n): the cases of the runs of evaluations, one for each row of
 * the dataset. It replaces the enterprise repository of the same name. See
 * `packages/@n8n/db/src/entities/FORK.md`.
 */
@Service()
export class TestCaseExecutionRepository extends Repository<TestCaseExecution> {
	constructor(dataSource: DataSource) {
		super(TestCaseExecution, dataSource.manager);
	}

	/**
	 * One case with the status `new` for each row, in the order of the rows. A case keeps the
	 * dataset row as its inputs until a successful run sets them.
	 */
	async createPendingBatch(
		testRunId: string,
		rows: Array<{ runIndex: number; inputs: JsonObject }>,
	): Promise<TestCaseExecution[]> {
		const cases = rows.map(({ runIndex, inputs }) =>
			this.create({
				testRun: { id: testRunId },
				status: 'new',
				runIndex,
				executionId: null,
				runAt: null,
				completedAt: null,
				errorCode: null,
				errorDetails: null,
				metrics: null,
				inputs,
				outputs: null,
			}),
		);
		return await this.save(cases);
	}

	/** Starts a case that is still `new`. Gives `false` when a user cancelled it before. */
	async tryMarkCaseAsRunning(id: string): Promise<boolean> {
		const result = await this.update(
			{ id, status: 'new' },
			{ status: 'running', runAt: new Date() },
		);
		return (result.affected ?? 0) > 0;
	}

	async markAsCompleted(input: {
		id: string;
		executionId: string;
		metrics: Record<string, number | boolean>;
		inputs: JsonObject;
		outputs: JsonObject;
	}) {
		return await this.update(input.id, {
			status: 'success',
			completedAt: new Date(),
			executionId: input.executionId,
			metrics: input.metrics,
			inputs: input.inputs,
			outputs: input.outputs,
		});
	}

	/**
	 * Ends a case with an error. The fields that are not given keep their values: the inputs keep
	 * the dataset row of the case.
	 */
	async markAsFailed(input: {
		id: string;
		errorCode: TestCaseExecutionErrorCode;
		executionId?: string;
		metrics?: Record<string, number | boolean>;
	}) {
		return await this.update(input.id, {
			status: 'error',
			completedAt: new Date(),
			errorCode: input.errorCode,
			...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
			...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
		});
	}

	/** Ends the cases of a run that have not finished. Gives their number. */
	async markAllPendingAsCancelled(testRunId: string): Promise<number> {
		const result = await this.update(
			{ testRun: { id: testRunId }, status: In(PENDING_STATUSES) },
			{ status: 'cancelled', completedAt: new Date() },
		);
		return result.affected ?? 0;
	}

	/** Cancels one case that has not started. Gives `false` when the case is not `new`. */
	async cancelIfNew(id: string, testRunId: string): Promise<boolean> {
		const result = await this.update(
			{ id, testRun: { id: testRunId }, status: 'new' },
			{ status: 'cancelled', completedAt: new Date() },
		);
		return (result.affected ?? 0) > 0;
	}

	/** The cases of a run in the order of the dataset. */
	async getManyByTestRunId(
		testRunId: string,
		options: { skip?: number; take?: number } = {},
	): Promise<TestCaseExecution[]> {
		return await this.find({
			where: { testRun: { id: testRunId } },
			order: { runIndex: 'ASC', id: 'ASC' },
			skip: options.skip,
			take: options.take,
		});
	}

	async countByTestRunId(testRunId: string): Promise<number> {
		return await this.countBy({ testRun: { id: testRunId } });
	}
}
