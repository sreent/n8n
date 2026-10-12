import type { WorkerStatus } from '@n8n/api-types';
import { defineStore } from 'pinia';

/**
 * Fork stand-in (not in upstream n8n) for the enterprise orchestration store, which the fork
 * removed with the worker view. The push handler `sendWorkerStatusMessage` uses it. The fork's
 * backend sends no worker status, so the store keeps nothing. See `./FORK.md`.
 */
export const useOrchestrationStore = defineStore('orchestration', () => {
	function updateWorkerStatus(_status: WorkerStatus) {
		// The fork has no worker view, so nothing shows the status.
	}

	return { updateWorkerStatus };
});
