import { mock } from 'vitest-mock-extended';

import type { ExternalSecretsConfig } from '../external-secrets.config';
import { ExternalSecretsRefreshTask } from '../external-secrets-refresh.task';
import type { ExternalSecretsSecretsCache } from '../secrets-cache.service';

describe('ExternalSecretsRefreshTask', () => {
	const config = mock<ExternalSecretsConfig>({ updateInterval: 300 });
	let secretsCache = mock<ExternalSecretsSecretsCache>();
	let task = new ExternalSecretsRefreshTask(config, secretsCache);

	beforeEach(() => {
		secretsCache = mock<ExternalSecretsSecretsCache>();
		task = new ExternalSecretsRefreshTask(config, secretsCache);
	});

	it('should run in every kind of instance at the update interval', () => {
		expect(task.name).toBe('external-secrets-refresh');
		expect(task.schedule).toEqual({ kind: 'interval', intervalSeconds: 300 });
		expect(task.target).toEqual({
			scope: 'instance',
			instanceTypes: ['main', 'worker', 'webhook'],
		});
	});

	it('should read the secrets of the connected providers again', async () => {
		await task.run(new AbortController().signal);

		expect(secretsCache.refreshAll).toHaveBeenCalledTimes(1);
	});

	it('should not read the secrets when the run is aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(task.run(controller.signal)).rejects.toThrow();
		expect(secretsCache.refreshAll).not.toHaveBeenCalled();
	});
});
