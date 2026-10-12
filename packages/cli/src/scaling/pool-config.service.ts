import { Service } from '@n8n/di';
import type { IWorkflowExecutionDataProcess } from 'n8n-workflow';

/** The queue and the worker pool of an execution. `undefined` means the default queue. */
export type ExecutionPool = {
	queueName: string | undefined;
	poolName: string | undefined;
};

/**
 * Fork stand-in (not in upstream n8n) for the enterprise pool config service, which the fork
 * removed with the worker pools. Each execution goes to the default queue, as in n8n without worker
 * pools. See `./FORK.md`.
 */
@Service()
export class PoolConfigService {
	async resolvePoolForExecution(_data: IWorkflowExecutionDataProcess): Promise<ExecutionPool> {
		return { queueName: undefined, poolName: undefined };
	}
}
