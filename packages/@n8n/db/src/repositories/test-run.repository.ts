import { Service } from '@n8n/di';
import type { FindOptionsWhere } from '@n8n/typeorm';
import { DataSource, In, Repository } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { TestCaseExecution } from '../entities/test-case-execution';
import type { TestRunStatus } from '../entities/test-run';
import { TestRun } from '../entities/test-run';
import type {
	AggregatedTestRunMetrics,
	TestRunErrorCode,
	TestRunFinalResult,
} from '../entities/types-db';

/** A run in a list: the run, its number of cases and its final result. */
export type TestRunSummary = TestRun & {
	testCaseCount: number;
	finalResult: TestRunFinalResult | null;
};

type CaseCounts = { total: number; errors: number; warnings: number };

/** The final result of a run: only a completed run has one. The most severe case status wins. */
function finalResultOf(status: TestRunStatus, counts: CaseCounts | undefined) {
	if (status !== 'completed') return null;
	if (counts && counts.errors > 0) return 'error';
	if (counts && counts.warnings > 0) return 'warning';
	return 'success';
}

const UNFINISHED_STATUSES: TestRunStatus[] = ['new', 'running'];

/**
 * Fork repository (not in upstream n8n): the runs of evaluations. It replaces the enterprise
 * repository of the same name. See `packages/@n8n/db/src/entities/FORK.md`.
 */
@Service()
export class TestRunRepository extends Repository<TestRun> {
	constructor(dataSource: DataSource) {
		super(TestRun, dataSource.manager);
	}

	/** A new run with the status `new`. */
	async createTestRun(
		workflowId: string,
		options: {
			evaluationConfigId?: string | null;
			evaluationConfigSnapshot?: IDataObject | null;
			workflowVersionId?: string | null;
			collectionId?: string | null;
		} = {},
	): Promise<TestRun> {
		const testRun = this.create({
			workflowId,
			status: 'new',
			runAt: null,
			completedAt: null,
			metrics: null,
			errorCode: null,
			errorDetails: null,
			runningInstanceId: null,
			cancelRequested: false,
			workflowVersionId: options.workflowVersionId ?? null,
			evaluationConfigId: options.evaluationConfigId ?? null,
			evaluationConfigSnapshot: options.evaluationConfigSnapshot ?? null,
			collectionId: options.collectionId ?? null,
		});
		return await this.save(testRun);
	}

	/** `runningInstanceId` is the main instance that runs the run. */
	async markAsRunning(id: string, runningInstanceId?: string) {
		return await this.update(id, {
			status: 'running',
			runAt: new Date(),
			runningInstanceId: runningInstanceId ?? null,
		});
	}

	async markAsCompleted(id: string, metrics: AggregatedTestRunMetrics) {
		return await this.update(id, { status: 'completed', completedAt: new Date(), metrics });
	}

	async markAsError(id: string, errorCode: TestRunErrorCode, errorDetails?: IDataObject) {
		return await this.update(id, {
			status: 'error',
			completedAt: new Date(),
			errorCode,
			errorDetails: errorDetails ?? null,
		});
	}

	async markAsCancelled(id: string) {
		return await this.update(id, { status: 'cancelled', completedAt: new Date() });
	}

	/** Marks the runs that a stopped instance left unfinished as failed. Gives their number. */
	async markAllIncompleteAsFailed(): Promise<number> {
		const result = await this.update(
			{ status: In(UNFINISHED_STATUSES) },
			{ status: 'error', errorCode: 'INTERRUPTED', completedAt: new Date() },
		);
		return result.affected ?? 0;
	}

	/** Sets the flag that the running instance reads before each case. */
	async requestCancellation(id: string) {
		return await this.update(id, { cancelRequested: true });
	}

	async isCancellationRequested(id: string): Promise<boolean> {
		const testRun = await this.findOne({ where: { id }, select: ['id', 'cancelRequested'] });
		return testRun?.cancelRequested ?? false;
	}

	async clearInstanceTracking(id: string) {
		return await this.update(id, { runningInstanceId: null });
	}

	async findOneByIdAndWorkflowId(id: string, workflowId: string): Promise<TestRun | null> {
		return await this.findOne({ where: { id, workflowId } });
	}

	async existsInWorkflow(id: string, workflowId: string): Promise<boolean> {
		return await this.existsBy({ id, workflowId });
	}

	async hasRunsForWorkflow(workflowId: string): Promise<boolean> {
		return await this.existsBy({ workflowId });
	}

	/** The runs of an evaluation config, newest first. */
	async findByWorkflowAndConfig(
		workflowId: string,
		evaluationConfigId: string,
	): Promise<TestRun[]> {
		return await this.find({
			where: { workflowId, evaluationConfigId },
			order: { createdAt: 'DESC', id: 'DESC' },
		});
	}

	async countByCollectionId(collectionId: string): Promise<number> {
		return await this.countBy({ collectionId });
	}

	async countByWorkflowId(workflowId: string, status?: TestRunStatus): Promise<number> {
		return await this.countBy(this.whereWorkflow(workflowId, status));
	}

	/** The runs of a workflow, newest first, with their number of cases and final result. */
	async getMany(
		workflowId: string,
		options: { take?: number; skip?: number; status?: TestRunStatus } = {},
	): Promise<TestRunSummary[]> {
		const testRuns = await this.find({
			where: this.whereWorkflow(workflowId, options.status),
			order: { createdAt: 'DESC', id: 'DESC' },
			take: options.take,
			skip: options.skip,
		});
		const counts = await this.countCases(testRuns.map((testRun) => testRun.id));
		return testRuns.map((testRun) =>
			Object.assign(testRun, {
				testCaseCount: counts.get(testRun.id)?.total ?? 0,
				finalResult: finalResultOf(testRun.status, counts.get(testRun.id)),
			}),
		);
	}

	/** A run with its cases in the order of the dataset, and its final result. */
	async getTestRunSummaryById(id: string, workflowId?: string): Promise<TestRun | null> {
		const testRun = await this.findOne({
			where: workflowId === undefined ? { id } : { id, workflowId },
		});
		if (!testRun) return null;
		testRun.testCaseExecutions = await this.manager.find(TestCaseExecution, {
			where: { testRun: { id } },
			order: { runIndex: 'ASC', id: 'ASC' },
		});
		const counts = await this.countCases([id]);
		testRun.finalResult = finalResultOf(testRun.status, counts.get(id));
		return testRun;
	}

	private whereWorkflow(workflowId: string, status?: TestRunStatus): FindOptionsWhere<TestRun> {
		return status === undefined ? { workflowId } : { workflowId, status };
	}

	private async countCases(testRunIds: string[]): Promise<Map<string, CaseCounts>> {
		if (testRunIds.length === 0) return new Map();
		const rows = await this.manager
			.createQueryBuilder(TestCaseExecution, 'testCase')
			.select('testCase.testRunId', 'testRunId')
			.addSelect('COUNT(testCase.id)', 'total')
			.addSelect("SUM(CASE WHEN testCase.status = 'error' THEN 1 ELSE 0 END)", 'errors')
			.addSelect("SUM(CASE WHEN testCase.status = 'warning' THEN 1 ELSE 0 END)", 'warnings')
			.where('testCase.testRunId IN (:...testRunIds)', { testRunIds })
			.groupBy('testCase.testRunId')
			.getRawMany<{
				testRunId: string;
				total: string | number;
				errors: string | number | null;
				warnings: string | number | null;
			}>();
		return new Map(
			rows.map((row) => [
				row.testRunId,
				{
					total: Number(row.total),
					errors: Number(row.errors ?? 0),
					warnings: Number(row.warnings ?? 0),
				},
			]),
		);
	}
}
