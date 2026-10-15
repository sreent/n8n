// Fork test (not in upstream n8n): the code under test of the golden test of this folder. To
// record the snapshot in a checkout of upstream n8n, point the import and the export at the
// enterprise files `@/controllers/project-pool-settings.controller.ee` and
// `@/scaling/pool-config.service.ee`. See `packages/cli/src/scaling/FORK.md`.
import '@/controllers/project-pool-settings.controller';

export { PoolConfigService } from '@/scaling/pool-config.service';
