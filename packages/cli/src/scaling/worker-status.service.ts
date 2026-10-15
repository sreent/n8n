import type { WorkerStatus } from '@n8n/api-types';
import { GlobalConfig } from '@n8n/config';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import os from 'node:os';

import { N8N_VERSION } from '@/constants';
import { Push } from '@/push';

import { JobProcessor } from './job-processor';
import { Publisher } from './pubsub/publisher.service';
import { resolveQueueName, resolveWorkerPoolName } from './queue-name';

/**
 * Fork code (not in upstream n8n): the status of the workers for the worker view. A main instance
 * asks all workers for their status over pub/sub. Each worker answers with its running jobs, its
 * memory, its host and its queue, and the main instance pushes each answer to the user who asked.
 * It replaces the enterprise service of the same name. See `./FORK.md`.
 */
@Service()
export class WorkerStatusService {
	constructor(
		private readonly jobProcessor: JobProcessor,
		private readonly globalConfig: GlobalConfig,
		private readonly instanceSettings: InstanceSettings,
		private readonly publisher: Publisher,
		private readonly push: Push,
	) {}

	/** Asks all workers for their status, for the user of the worker view. */
	async requestWorkerStatus(requestingUserId: string) {
		await this.publisher.publishCommand({
			command: 'get-worker-status',
			payload: { requestingUserId },
		});
	}

	@OnPubSubEvent('response-to-get-worker-status', { instanceType: 'main' })
	handleWorkerStatusResponse(payload: WorkerStatus & { requestingUserId: string }) {
		this.push.sendToUsers(
			{
				type: 'sendWorkerStatusMessage',
				data: { workerId: payload.senderId, status: payload },
			},
			[payload.requestingUserId],
		);
	}

	@OnPubSubEvent('get-worker-status', { instanceType: 'worker' })
	async publishWorkerResponse({ requestingUserId }: { requestingUserId: string }) {
		await this.publisher.publishWorkerResponse({
			senderId: this.instanceSettings.hostId,
			response: 'response-to-get-worker-status',
			payload: { ...this.generateStatus(), requestingUserId },
		});
	}

	private generateStatus(): WorkerStatus {
		const constraint = process.constrainedMemory();
		const poolName = resolveWorkerPoolName(this.globalConfig.queue.workerPool);

		return {
			senderId: this.instanceSettings.hostId,
			runningJobsSummary: this.jobProcessor.getRunningJobsSummary(),
			// Node gives 0, or a value of at least 2^53, when no container limits the memory.
			isInContainer: constraint > 0 && constraint < Number.MAX_SAFE_INTEGER,
			process: {
				memory: {
					available: process.availableMemory(),
					constraint,
					...process.memoryUsage(),
				},
				uptime: process.uptime(),
			},
			host: {
				memory: { total: os.totalmem(), free: os.freemem() },
			},
			freeMem: os.freemem(),
			totalMem: os.totalmem(),
			uptime: process.uptime(),
			loadAvg: os.loadavg(),
			cpus: this.getOsCpuString(),
			arch: os.arch(),
			platform: os.platform(),
			hostname: os.hostname(),
			interfaces: Object.values(os.networkInterfaces()).flatMap((addresses) =>
				(addresses ?? []).map(({ family, address, internal }) => ({ family, address, internal })),
			),
			version: N8N_VERSION,
			poolName,
			queueName: resolveQueueName(this.instanceSettings.instanceType, poolName),
		};
	}

	private getOsCpuString() {
		const cpus = os.cpus();
		if (cpus.length === 0) return 'no CPU info';
		return `${cpus.length}x ${cpus[0].model}`;
	}
}
