# The fork's scaling stand-ins

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md).

The fork removed the multi-main setup, the worker view and the worker pools in step 4 of FORK.md.
They are enterprise code, and [FORK-FEATURES.md](../../../../FORK-FEATURES.md) lists them as not
planned: the fork runs one main instance. Queue mode with workers stays, because it is ordinary
code.

## The stand-ins

Ordinary code loads three of the enterprise classes by name. Fork stand-ins with the same names
keep that code unchanged:

| Fork file | Enterprise file that it replaces | Behaviour |
| --- | --- | --- |
| `multi-main-setup.ts` | `multi-main-setup.ee.ts` | `init()` stops the start with a `UserError`. The other methods do nothing, and `fetchLeaderKey()` gives `null`. |
| `worker-status.service.ts` | `worker-status.service.ee.ts` | `requestWorkerStatus()` asks no worker. |
| `pool-config.service.ts` | `pool-config.service.ee.ts` | `resolvePoolForExecution()` gives the default queue. |

The fork also removed these enterprise files, which no ordinary code imports:
`worker-pools.service.ee.ts`, the controller `project-pool-settings.controller.ee.ts`, and the
entity and the repository of the table `project_pool_settings` in `@n8n/db`. The editor folder
`orchestration.ee` has stand-ins too: see
[the FORK.md of the editor folder](../../../frontend/editor-ui/src/features/settings/orchestration/FORK.md).

## Behaviour

The sources are the ordinary callers and their tests: `commands/start.ts`, `commands/worker.ts`,
`workflow-runner.ts`, `controllers/orchestration.controller.ts` and
`controllers/debug.controller.ts`.

- **Multi-main setup.** In queue mode with `N8N_MULTI_MAIN_SETUP_ENABLED=true`, the start stops in
  `initOrchestration()` with the error "Multi-main setup is not in this build of n8n. Set
  N8N_MULTI_MAIN_SETUP_ENABLED to false, and run one main instance." Without a licence, upstream
  n8n also stops this start: its licence check `ensureMultiMainLicensed()` fails after
  `MultiMainSetup.init()`. The fork stops before that.
- **Worker view.** Without a licence, the orchestration controller returns before it calls the
  service, as in upstream n8n. With a licence, the service asks no worker. The workers do not
  answer status requests.
- **Worker pools.** Each execution goes to the default queue `jobs`. Without a licence, upstream n8n
  does the same, and a worker with `N8N_WORKER_POOL_NAME` does not start: the licence check of
  `worker.ts` stays. The table `project_pool_settings` stays in the database, because its migration
  is ordinary code, but no code reads it. The endpoints of the project pool settings are gone. The
  project settings page calls them only when worker pools are licensed.

### Differences from upstream

- With a licence, upstream n8n runs the multi-main setup, the worker view and the worker pools. The
  fork does not, also with a licence.
- `leader-election-client.ts` stays, because it is ordinary code. No ordinary code imports it.

## Tests

`__tests__/fork-stand-ins.test.ts` tests the stand-ins. The ordinary tests of the callers use the
stand-ins: `start.test.ts`, `worker.test.ts`, `wait-tracker.test.ts`, `workflow-runner.test.ts`,
`orchestration.controller.test.ts` and the integration test `debug.controller.test.ts`. The fork
deleted the ordinary test `__tests__/worker-status.service.test.ts` of the enterprise service, and
removed an unused multi-main mock from `wait-tracker.test.ts`.

## Upstream updates

`scripts/sync-upstream.sh` deletes the enterprise files and the deleted test again, as
`scripts/removed-enterprise-paths.txt` tells. When upstream changes how ordinary code uses these
classes, change the stand-ins.
