import { Service } from '@n8n/di';

/**
 * Fork stand-in (not in upstream n8n) for the enterprise worker status service, which the fork
 * removed with the worker view. The workers do not report their status. Without a licence,
 * upstream n8n never asks them either: the orchestration controller returns before it calls this
 * service. See `./FORK.md`.
 */
@Service()
export class WorkerStatusService {
	async requestWorkerStatus(_userId: string): Promise<void> {
		// The fork has no worker view, so it asks no worker.
	}
}
