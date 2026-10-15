import { Container } from '@n8n/di';
import type { IWorkflowExecutionDataProcess } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { PoolConfigService } from '../pool-config.service';
import { WorkerStatusService } from '../worker-status.service';

describe('fork stand-ins for worker status and worker pools', () => {
	describe('WorkerStatusService', () => {
		it('asks no worker for its status', async () => {
			await expect(
				Container.get(WorkerStatusService).requestWorkerStatus('user-1'),
			).resolves.toBeUndefined();
		});
	});

	describe('PoolConfigService', () => {
		it('sends each execution to the default queue', async () => {
			const data = mock<IWorkflowExecutionDataProcess>({ projectId: 'project-1' });

			await expect(Container.get(PoolConfigService).resolvePoolForExecution(data)).resolves.toEqual(
				{ queueName: undefined, poolName: undefined },
			);
		});
	});
});
