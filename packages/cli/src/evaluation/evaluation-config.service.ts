import type { UpsertEvaluationConfigDto } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import type { EvaluationConfig, User } from '@n8n/db';
import { EvaluationConfigRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { nanoid } from 'nanoid';
import type { IWorkflowBase } from 'n8n-workflow';

import { EvaluationApiError } from './evaluation-api-error';
import { EvaluationConfigValidator } from './evaluation-config-validator';

/**
 * Fork code (not in upstream n8n): saves the evaluation configs of a workflow. A config pairs a
 * dataset with a part of the workflow and the metrics that score its output. The caller checks
 * the access to the workflow. It replaces the enterprise service. See `FORK.md` in this folder.
 */
@Service()
export class EvaluationConfigService {
	constructor(
		private readonly evaluationConfigRepository: EvaluationConfigRepository,
		private readonly validator: EvaluationConfigValidator,
		private readonly licenseState: LicenseState,
	) {}

	async list(workflowId: string): Promise<EvaluationConfig[]> {
		return await this.evaluationConfigRepository.listByWorkflowId(workflowId);
	}

	async get(workflowId: string, configId: string): Promise<EvaluationConfig | null> {
		return await this.evaluationConfigRepository.findByIdAndWorkflowId(configId, workflowId);
	}

	async create(
		workflowId: string,
		workflow: Pick<IWorkflowBase, 'nodes' | 'connections'>,
		user: User,
		dto: UpsertEvaluationConfigDto,
	): Promise<EvaluationConfig> {
		await this.assertQuota(workflowId);
		await this.runValidator(workflow, user, dto);
		return await this.evaluationConfigRepository.createForWorkflow(nanoid(), workflowId, dto);
	}

	/** Replaces the whole config. The config becomes valid again. */
	async update(
		workflowId: string,
		configId: string,
		workflow: Pick<IWorkflowBase, 'nodes' | 'connections'>,
		user: User,
		dto: UpsertEvaluationConfigDto,
	): Promise<EvaluationConfig> {
		if (!(await this.get(workflowId, configId))) throw this.notFound(configId);
		await this.runValidator(workflow, user, dto);
		const updated = await this.evaluationConfigRepository.updateForWorkflow(
			configId,
			workflowId,
			dto,
		);
		if (!updated) throw this.notFound(configId);
		return updated;
	}

	async delete(workflowId: string, configId: string): Promise<void> {
		await this.evaluationConfigRepository.deleteByIdAndWorkflowId(configId, workflowId);
	}

	async markInvalid(configId: string, invalidReason: string): Promise<void> {
		await this.evaluationConfigRepository.markInvalid(configId, invalidReason);
	}

	async runValidator(
		workflow: Pick<IWorkflowBase, 'nodes' | 'connections'>,
		user: User,
		config: UpsertEvaluationConfigDto,
	) {
		await this.validator.validate({ workflow, user, config });
	}

	/**
	 * A workflow without configs may get its first config only while the licence quota of
	 * workflows with evaluations has room. A quota of 0 or of no limit checks nothing.
	 */
	private async assertQuota(workflowId: string) {
		const limit = this.licenseState.getMaxWorkflowsWithEvaluations();
		if (limit === UNLIMITED_LICENSE_QUOTA || limit <= 0) return;
		if ((await this.evaluationConfigRepository.listByWorkflowId(workflowId)).length > 0) return;

		const projected = (await this.evaluationConfigRepository.countWorkflowsWithConfigs()) + 1;
		if (projected > limit) {
			throw new EvaluationApiError(
				'EVALUATION_QUOTA_EXCEEDED',
				`Evaluation quota exceeded: ${projected}/${limit} workflows already have evaluations`,
			);
		}
	}

	private notFound(configId: string) {
		return new EvaluationApiError('CONFIG_NOT_FOUND', `Evaluation config "${configId}" not found`);
	}
}
