// Fork test (not in upstream n8n): the code under test of the golden tests of this folder. To
// record the snapshots in a checkout of upstream n8n, point the exports at the enterprise files
// `@/scaling/multi-main-setup.ee` and `@/scaling/worker-status.service.ee`. See `../../FORK.md`.
export { MultiMainSetup } from '@/scaling/multi-main-setup';
export { WorkerStatusService } from '@/scaling/worker-status.service';
