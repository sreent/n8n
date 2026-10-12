import { LicenseState } from '@n8n/backend-common';
import { UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import type { TestRun } from '@n8n/db';
import { TestCaseExecutionRepository, TestRunRepository, WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { PaymentRequiredError } from '@n8n/errors';

/**
 * Fork code (not in upstream n8n): the queries of the public API of test runs. It replaces the
 * enterprise service of the same name. See `FORK.md` in this folder.
 */
@Service()
export class EvaluationTestRunService {
	constructor(
		private readonly testRunRepository: TestRunRepository,
		private readonly testCaseExecutionRepository: TestCaseExecutionRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly licenseState: LicenseState,
	) {}

	/** A page of the runs of a workflow, newest first, and the number of all its runs. */
	async findManyAndCount(
		workflowId: string,
		{ offset, limit }: { offset: number; limit: number },
		status?: TestRun['status'],
	) {
		const [testRuns, count] = await Promise.all([
			this.testRunRepository.getMany(workflowId, { skip: offset, take: limit, status }),
			this.testRunRepository.countByWorkflowId(workflowId, status),
		]);
		return { testRuns, count };
	}

	/**
	 * Throws when the workflow may not get a test run: it has none yet, and the licence quota of
	 * workflows with evaluations is full.
	 */
	async assertEvaluationQuotaAvailable(workflowId: string) {
		const limit = this.licenseState.getMaxWorkflowsWithEvaluations();
		if (limit === UNLIMITED_LICENSE_QUOTA) return;
		if (await this.testRunRepository.hasRunsForWorkflow(workflowId)) return;

		const count = await this.workflowRepository.getWorkflowsWithEvaluationCount();
		if (count >= limit) {
			throw new PaymentRequiredError(
				`Evaluation quota exceeded: ${count}/${limit} workflows already have evaluations`,
			);
		}
	}

	/** A run of the workflow with its cases and its final result, or `null`. */
	async findSummaryByWorkflowId(testRunId: string, workflowId: string): Promise<TestRun | null> {
		return await this.testRunRepository.getTestRunSummaryById(testRunId, workflowId);
	}

	/** A page of the cases of a run of the workflow and their number, or `null` for no run. */
	async findTestCasesAndCount(
		testRunId: string,
		workflowId: string,
		{ offset, limit }: { offset: number; limit: number },
	) {
		if (!(await this.testRunRepository.existsInWorkflow(testRunId, workflowId))) return null;
		const [testCases, count] = await Promise.all([
			this.testCaseExecutionRepository.getManyByTestRunId(testRunId, { skip: offset, take: limit }),
			this.testCaseExecutionRepository.countByTestRunId(testRunId),
		]);
		return { testCases, count };
	}

	async findOneByIdAndWorkflowId(testRunId: string, workflowId: string): Promise<TestRun | null> {
		return await this.testRunRepository.findOneByIdAndWorkflowId(testRunId, workflowId);
	}
}
