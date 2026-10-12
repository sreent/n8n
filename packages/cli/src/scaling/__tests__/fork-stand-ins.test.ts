import { Container } from '@n8n/di';
import type { IWorkflowExecutionDataProcess } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { MultiMainSetup } from '../multi-main-setup';
import { PoolConfigService } from '../pool-config.service';
import { WorkerStatusService } from '../worker-status.service';

describe('fork stand-ins for multi-main, worker status and worker pools', () => {
	describe('MultiMainSetup', () => {
		const multiMainSetup = Container.get(MultiMainSetup);

		it('stops the start of a multi-main instance', async () => {
			await expect(multiMainSetup.init()).rejects.toThrow(
				'Multi-main setup is not in this build of n8n. Set N8N_MULTI_MAIN_SETUP_ENABLED to false, and run one main instance.',
			);
			await expect(multiMainSetup.init()).rejects.toBeInstanceOf(UserError);
		});

		it('registers no handlers, shuts down without work, and has no leader key', async () => {
			expect(() => multiMainSetup.registerEventHandlers()).not.toThrow();
			await expect(multiMainSetup.shutdown()).resolves.toBeUndefined();
			await expect(multiMainSetup.fetchLeaderKey()).resolves.toBeNull();
		});
	});

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
