// Fork test (not in upstream n8n): the services that the golden tests of promotions call besides
// the public API. To record the snapshots in a checkout of upstream n8n, point these exports at the
// enterprise files: `@/environments.ee/variables/variables.service.ee`.
export { VariablesService } from '@/environments/variables/variables.service';
