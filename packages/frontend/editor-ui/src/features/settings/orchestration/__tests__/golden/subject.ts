// Fork test (not in upstream n8n): the code under test of the golden tests of this folder. To
// record the snapshots against the enterprise files in a checkout of upstream n8n, point these
// exports at the same paths in `@/features/settings/orchestration.ee/`. See `../../FORK.md`.
export {
	WORKER_HISTORY_LENGTH,
	useOrchestrationStore,
} from '@/features/settings/orchestration/orchestration.store';
export { default as WorkerView } from '@/features/settings/orchestration/views/WorkerView.vue';
