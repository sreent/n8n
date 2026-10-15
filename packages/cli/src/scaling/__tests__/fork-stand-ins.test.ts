import { Container } from '@n8n/di';
import type { IWorkflowExecutionDataProcess } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { PoolConfigService } from '../pool-config.service';

describe('fork stand-in for worker pools', () => {
	describe('PoolConfigService', () => {
		it('sends each execution to the default queue', async () => {
			const data = mock<IWorkflowExecutionDataProcess>({ projectId: 'project-1' });

			await expect(Container.get(PoolConfigService).resolvePoolForExecution(data)).resolves.toEqual(
				{ queueName: undefined, poolName: undefined },
			);
		});
	});
});
