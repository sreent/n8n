import { StartTestRunRequestDto } from '@n8n/api-types';
import type { AuthenticatedRequest, TestRun, User } from '@n8n/db';
import {
	EvaluationConfigRepository,
	TestCaseExecutionRepository,
	TestRunRepository,
} from '@n8n/db';
import { Body, Delete, Get, Post, RestController } from '@n8n/decorators';
import { ConflictError, NotFoundError } from '@n8n/errors';
import type { Scope } from '@n8n/permissions';
import type { Response } from 'express';

import { listQueryMiddleware } from '@/middlewares';
import type { ListQuery } from '@/requests';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { runMetricScales } from './metric-scales';
import type { StartTestRunOptions } from './test-runner/test-runner.service';
import { TestRunnerService } from './test-runner/test-runner.service';

type WorkflowParams = { workflowId: string };
type TestRunParams = WorkflowParams & { id: string };
type TestCaseParams = TestRunParams & { caseId: string };

const READ: Scope[] = ['workflow:read'];
const EXECUTE: Scope[] = ['workflow:execute'];

/**
 * Fork code (not in upstream n8n): the REST API of the test runs of a workflow
 * (`/rest/workflows/:workflowId/test-runs`). A user who can read the workflow can read its runs.
 * A user who can execute the workflow can start, cancel and delete them. It replaces the
 * enterprise controller of the same name. See `FORK.md` in this folder.
 */
@RestController('/workflows')
export class TestRunsController {
	constructor(
		private readonly testRunRepository: TestRunRepository,
		private readonly testCaseExecutionRepository: TestCaseExecutionRepository,
		private readonly evaluationConfigRepository: EvaluationConfigRepository,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly testRunnerService: TestRunnerService,
	) {}

	// oxlint-disable-next-line typescript/no-deprecated
	@Get('/:workflowId/test-runs', { middlewares: listQueryMiddleware })
	async getMany(req: ListQuery.Request & { params: WorkflowParams }) {
		const { workflowId } = req.params;
		await this.assertUserHasAccessToWorkflow(workflowId, req.user, READ);
		const { take, skip } = req.listQueryOptions ?? {};
		const testRuns = await this.testRunRepository.getMany(workflowId, { take, skip });
		return await Promise.all(
			testRuns.map(async (testRun) => await this.attachMetricScales(testRun)),
		);
	}

	@Get('/:workflowId/test-runs/:id')
	async getOne(req: AuthenticatedRequest<TestRunParams>) {
		const { workflowId, id } = req.params;
		await this.assertUserHasAccessToWorkflow(workflowId, req.user, READ);
		const testRun = await this.testRunRepository.getTestRunSummaryById(id, workflowId);
		if (!testRun) throw new NotFoundError('Test run not found');
		return await this.attachMetricScales(testRun);
	}

	@Get('/:workflowId/test-runs/:id/test-cases')
	async getTestCases(req: AuthenticatedRequest<TestRunParams>) {
		const { workflowId, id } = req.params;
		await this.getTestRun(id, workflowId, req.user, READ);
		return await this.testCaseExecutionRepository.getManyByTestRunId(id);
	}

	@Delete('/:workflowId/test-runs/:id')
	async delete(req: AuthenticatedRequest<TestRunParams>) {
		const { workflowId, id } = req.params;
		await this.getTestRun(id, workflowId, req.user, EXECUTE);
		await this.testRunRepository.delete({ id });
		return { success: true };
	}

	@Post('/:workflowId/test-runs/:id/cancel')
	async cancel(req: AuthenticatedRequest<TestRunParams>, res: Response) {
		const { workflowId, id } = req.params;
		const testRun = await this.getTestRun(id, workflowId, req.user, EXECUTE);
		if (this.testRunnerService.canBeCancelled(testRun)) {
			throw new ConflictError(`The test run "${id}" cannot be cancelled`);
		}
		await this.testRunnerService.cancelTestRun(id);
		res.status(202).json({ success: true });
	}

	/** Cancels one case of a run that has not started yet. */
	@Post('/:workflowId/test-runs/:id/test-cases/:caseId/cancel')
	async cancelCase(req: AuthenticatedRequest<TestCaseParams>) {
		const { workflowId, id, caseId } = req.params;
		await this.getTestRun(id, workflowId, req.user, EXECUTE);
		if (!(await this.testCaseExecutionRepository.cancelIfNew(caseId, id))) {
			throw new ConflictError(
				`Test case "${caseId}" cannot be cancelled — it is not in a pending state`,
			);
		}
		return { success: true };
	}

	@Post('/:workflowId/test-runs/new')
	async create(
		req: AuthenticatedRequest<WorkflowParams>,
		res: Response,
		@Body payload: StartTestRunRequestDto,
	) {
		const { workflowId } = req.params;
		await this.assertUserHasAccessToWorkflow(workflowId, req.user, EXECUTE);

		const { concurrency, evaluationConfigId, compileFromConfig, rowIndices } = payload;
		// Without options in the body, the runner gets no options.
		const options: StartTestRunOptions | undefined =
			evaluationConfigId !== undefined ||
			compileFromConfig !== undefined ||
			rowIndices !== undefined
				? { evaluationConfigId, compileFromConfig, rowIndices }
				: undefined;

		const { testRun, finished } = await this.testRunnerService.startTestRun(
			req.user,
			workflowId,
			concurrency ?? 1,
			options,
		);
		void finished;
		res.status(202).json({ success: true, testRunId: testRun.id });
	}

	private async assertUserHasAccessToWorkflow(workflowId: string, user: User, scopes: Scope[]) {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, scopes);
		if (!workflow) throw new NotFoundError('Workflow not found');
		return workflow;
	}

	private async getTestRun(testRunId: string, workflowId: string, user: User, scopes: Scope[]) {
		await this.assertUserHasAccessToWorkflow(workflowId, user, scopes);
		const testRun = await this.testRunRepository.findOneByIdAndWorkflowId(testRunId, workflowId);
		if (!testRun) throw new NotFoundError('Test run not found');
		return testRun;
	}

	/** A run of an evaluation config gets the scale of each metric, for the charts of the editor. */
	private async attachMetricScales<T extends TestRun>(testRun: T) {
		if (!testRun.evaluationConfigId) return testRun;
		const liveConfig = testRun.evaluationConfigSnapshot
			? null
			: await this.evaluationConfigRepository.findByIdAndWorkflowId(
					testRun.evaluationConfigId,
					testRun.workflowId,
				);
		const metricScales = runMetricScales(testRun, liveConfig);
		return metricScales ? { ...testRun, metricScales } : testRun;
	}
}
