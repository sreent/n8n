// Fork service (not in upstream n8n): the execution view with sharing data, in place of the
// enterprise `execution.service.ee.ts`. It keeps the class name, so that the controller changes
// only its import. packages/cli/src/executions/FORK.md describes it.
import { WorkflowRepository, type WorkflowWithSharingsMetaDataAndCredentials } from '@n8n/db';
import { Service } from '@n8n/di';
import type { IWorkflowBase } from 'n8n-workflow';

import type { IExecutionFlattedResponse } from '@/interfaces';
import { EnterpriseWorkflowService } from '@/workflows/enterprise-workflow.service';

import { ExecutionService } from './execution.service';
import type { ExecutionRequest } from './execution.types';

type SharingData = Pick<
	WorkflowWithSharingsMetaDataAndCredentials,
	'homeProject' | 'sharedWithProjects' | 'usedCredentials'
>;

@Service()
export class EnterpriseExecutionsService {
	constructor(
		private readonly executionService: ExecutionService,
		private readonly workflowRepository: WorkflowRepository,
		private readonly enterpriseWorkflowService: EnterpriseWorkflowService,
	) {}

	/**
	 * The execution as `ExecutionService.findOne` gives it, with sharing data in its workflow. The
	 * credential list comes from the workflow as it is now, not as it ran. The workflow is read
	 * without its shares, so the home project is `null` and the list of shares is empty. When the
	 * workflow is gone, there is no result.
	 */
	async findOne(
		req: ExecutionRequest.GetOne,
		sharedWorkflowIds: string[],
	): Promise<IExecutionFlattedResponse | undefined> {
		const execution = await this.executionService.findOne(req, sharedWorkflowIds);
		if (!execution) return undefined;

		const workflow = await this.workflowRepository.findOneBy({ id: execution.workflowId });
		if (!workflow) return undefined;

		const described = this.enterpriseWorkflowService.addOwnerAndSharings(workflow);
		await this.enterpriseWorkflowService.addCredentialsToWorkflow(described, req.user);

		const workflowData: IWorkflowBase & SharingData = {
			...execution.workflowData,
			homeProject: described.homeProject,
			sharedWithProjects: described.sharedWithProjects,
			usedCredentials: described.usedCredentials,
		};
		return { ...execution, workflowData };
	}
}
