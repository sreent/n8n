import { addDatasetRowSchema, upsertEvaluationConfigSchema } from '@n8n/api-types';
import type { AuthenticatedRequest, User } from '@n8n/db';
import { Delete, Get, Post, Put, RestController } from '@n8n/decorators';
import { BadRequestError, NotFoundError } from '@n8n/errors';
import type { Scope } from '@n8n/permissions';

import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { EvaluationConfigService } from './evaluation-config.service';
import { EvaluationDatasetService } from './evaluation-dataset.service';

type WorkflowParams = { workflowId: string };
type ConfigParams = WorkflowParams & { configId: string };

/**
 * Fork code (not in upstream n8n): the REST API of the evaluation configs of a workflow
 * (`/rest/workflows/:workflowId/evaluation-configs`). A user who can read the workflow can read
 * its configs. A user who can update the workflow can change them. It replaces the enterprise
 * controller of the same name. See `FORK.md` in this folder.
 */
@RestController('/workflows')
export class EvaluationConfigController {
	constructor(
		private readonly evaluationConfigService: EvaluationConfigService,
		private readonly evaluationDatasetService: EvaluationDatasetService,
		private readonly workflowFinderService: WorkflowFinderService,
	) {}

	@Get('/:workflowId/evaluation-configs')
	async list(req: AuthenticatedRequest<WorkflowParams>) {
		const { workflowId } = req.params;
		await this.assertWorkflowAccess(workflowId, req.user, ['workflow:read']);
		return await this.evaluationConfigService.list(workflowId);
	}

	@Get('/:workflowId/evaluation-configs/:configId')
	async get(req: AuthenticatedRequest<ConfigParams>) {
		const { workflowId, configId } = req.params;
		await this.assertWorkflowAccess(workflowId, req.user, ['workflow:read']);
		const config = await this.evaluationConfigService.get(workflowId, configId);
		if (!config) throw new NotFoundError('Evaluation config not found');
		return config;
	}

	@Post('/:workflowId/evaluation-configs')
	async create(req: AuthenticatedRequest<WorkflowParams>) {
		const { workflowId } = req.params;
		const workflow = await this.assertWorkflowAccess(workflowId, req.user, ['workflow:update']);
		const dto = upsertEvaluationConfigSchema.parse(req.body);
		return await this.evaluationConfigService.create(workflowId, workflow, req.user, dto);
	}

	@Put('/:workflowId/evaluation-configs/:configId')
	async update(req: AuthenticatedRequest<ConfigParams>) {
		const { workflowId, configId } = req.params;
		const workflow = await this.assertWorkflowAccess(workflowId, req.user, ['workflow:update']);
		const dto = upsertEvaluationConfigSchema.parse(req.body);
		return await this.evaluationConfigService.update(workflowId, configId, workflow, req.user, dto);
	}

	@Delete('/:workflowId/evaluation-configs/:configId')
	async delete(req: AuthenticatedRequest<ConfigParams>) {
		const { workflowId, configId } = req.params;
		await this.assertWorkflowAccess(workflowId, req.user, ['workflow:update']);
		await this.evaluationConfigService.delete(workflowId, configId);
		return { success: true };
	}

	/** The columns of the dataset and the fields of an execution, to add it as a dataset row. */
	@Get('/:workflowId/evaluation-configs/:configId/dataset-candidate')
	async datasetCandidate(
		req: AuthenticatedRequest<ConfigParams, {}, {}, { executionId?: string }>,
	) {
		const { workflowId, configId } = req.params;
		await this.assertWorkflowAccess(workflowId, req.user, ['workflow:read']);
		const { executionId } = req.query;
		if (typeof executionId !== 'string' || executionId.length === 0) {
			throw new BadRequestError('executionId query parameter is required');
		}
		return await this.evaluationDatasetService.getCandidate(
			workflowId,
			configId,
			executionId,
			req.user,
		);
	}

	@Post('/:workflowId/evaluation-configs/:configId/dataset-rows')
	async addDatasetRow(req: AuthenticatedRequest<ConfigParams>) {
		const { workflowId, configId } = req.params;
		await this.assertWorkflowAccess(workflowId, req.user, ['workflow:update']);
		const dto = addDatasetRowSchema.parse(req.body);
		return await this.evaluationDatasetService.addRow(workflowId, configId, dto, req.user);
	}

	private async assertWorkflowAccess(workflowId: string, user: User, scopes: Scope[]) {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, scopes);
		if (!workflow) throw new NotFoundError('Workflow not found');
		return workflow;
	}
}
