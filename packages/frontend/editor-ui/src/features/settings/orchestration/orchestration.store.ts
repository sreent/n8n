import type { WorkerStatus } from '@n8n/api-types';
import { sendGetWorkerStatus } from '@n8n/rest-api-client/api/orchestration';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineStore } from 'pinia';
import { ref } from 'vue';

/** The number of statuses that the store keeps for each worker, for the charts. */
export const WORKER_HISTORY_LENGTH = 100;

/** A worker that sent no status for this time leaves the list. */
const STALE_WORKER_TIMEOUT_MS = 120_000;

/** The time between two requests for the status of the workers. */
const POLLING_INTERVAL_MS = 1_000;

export type WorkerStatusHistoryEntry = {
	data: WorkerStatus;
	timestamp: number;
};

/**
 * Fork code (not in upstream n8n): the store of the worker view. It asks the workers for their
 * status each second while the page is open, keeps the newest status and a short history of each
 * worker, and removes a worker that stops to answer. It replaces the enterprise store of the same
 * name. See `./FORK.md`.
 */
export const useOrchestrationStore = defineStore('orchestrationManager', () => {
	const rootStore = useRootStore();

	const initialStatusReceived = ref(false);
	const workers = ref<Record<string, WorkerStatus>>({});
	const workersHistory = ref<Record<string, WorkerStatusHistoryEntry[]>>({});
	const workersLastUpdated = ref<Record<string, number>>({});
	const statusInterval = ref<ReturnType<typeof setInterval> | null>(null);

	/** Keeps a status that a worker sent through the push connection. */
	function updateWorkerStatus(data: WorkerStatus) {
		const id = data.senderId;
		workers.value[id] = data;
		if (!workersHistory.value[id]) workersHistory.value[id] = [];
		const history = workersHistory.value[id];
		history.push({ data, timestamp: Date.now() });
		if (history.length > WORKER_HISTORY_LENGTH) history.shift();
		workersLastUpdated.value[id] = Date.now();
		initialStatusReceived.value = true;
	}

	/** Removes the workers that sent no status for two minutes. */
	function removeStaleWorkers() {
		const now = Date.now();
		for (const id of Object.keys(workersLastUpdated.value)) {
			if (now - workersLastUpdated.value[id] <= STALE_WORKER_TIMEOUT_MS) continue;
			delete workers.value[id];
			delete workersHistory.value[id];
			delete workersLastUpdated.value[id];
		}
	}

	/** Asks the workers for their status each second. A second call does nothing. */
	function startWorkerStatusPolling() {
		if (statusInterval.value) return;
		statusInterval.value = setInterval(async () => {
			await sendGetWorkerStatus(rootStore.restApiContext);
			removeStaleWorkers();
		}, POLLING_INTERVAL_MS);
	}

	function stopWorkerStatusPolling() {
		if (statusInterval.value) clearInterval(statusInterval.value);
		statusInterval.value = null;
	}

	function getWorkerLastUpdated(workerId: string): number {
		return workersLastUpdated.value[workerId] ?? 0;
	}

	function getWorkerStatus(workerId: string): WorkerStatus | undefined {
		return workers.value[workerId];
	}

	function getWorkerStatusHistory(workerId: string): WorkerStatusHistoryEntry[] {
		return workersHistory.value[workerId] ?? [];
	}

	return {
		initialStatusReceived,
		workers,
		workersHistory,
		workersLastUpdated,
		statusInterval,
		updateWorkerStatus,
		removeStaleWorkers,
		startWorkerStatusPolling,
		stopWorkerStatusPolling,
		getWorkerLastUpdated,
		getWorkerStatus,
		getWorkerStatusHistory,
	};
});
