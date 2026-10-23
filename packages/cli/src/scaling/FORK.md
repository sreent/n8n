# The fork's scaling code

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md).

The fork removed the multi-main setup, the worker view and the worker pools in step 4 of FORK.md,
with stand-ins. On 2026-10-14 the owner chose to rebuild them (4 of 6 in
[FORK-FEATURES.md](../../../../FORK-FEATURES.md#parity-with-the-enterprise-edition)). The fork
files below replace the stand-ins and the enterprise files. Queue mode with workers is ordinary
code.

| Fork file | Enterprise file that it replaces | Ordinary code that uses it |
| --- | --- | --- |
| `multi-main-setup.ts` | `multi-main-setup.ee.ts` | `commands/start.ts`, `controllers/debug.controller.ts`, and the handlers of `@OnLeaderTakeover` and `@OnLeaderStepdown`, for example in `wait-tracker.ts` |
| `worker-status.service.ts` | `worker-status.service.ee.ts` | `controllers/orchestration.controller.ts`, `commands/worker.ts`, the pub/sub handlers |
| `worker-pools.service.ts` | `worker-pools.service.ee.ts` | `pool-config.service.ts` |
| `pool-config.service.ts` | `pool-config.service.ee.ts` | `workflow-runner.ts` |
| `../controllers/project-pool-settings.controller.ts` | `project-pool-settings.controller.ee.ts` | `server.ts` loads it |
| `@n8n/db`: `entities/project-pool-settings.ts` and `repositories/project-pool-settings.repository.ts` | `project-pool-settings.ee.ts` and `project-pool-settings.repository.ee.ts` | the indexes of `@n8n/db` |

The editor of the worker view is in `editor-ui/src/features/settings/orchestration`: see
[the FORK.md of the editor folder](../../../frontend/editor-ui/src/features/settings/orchestration/FORK.md).
The project settings page of the editor (ordinary code) sets the pool of a project.

## Turn them on

The fork switch (step 5 of FORK.md) turns on the licence values `feat:multipleMainInstances`,
`feat:workerView` and `feat:workerPools`. Each feature also needs its configuration, as in upstream
n8n:

- **Multi-main setup**: queue mode (`EXECUTIONS_MODE=queue`) with Redis, and
  `N8N_MULTI_MAIN_SETUP_ENABLED=true` on each main instance. `N8N_MULTI_MAIN_SETUP_KEY_TTL` (10
  seconds by default) and `N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL` (3 seconds by default) set the
  leader key. Put the main instances behind a load balancer, as the
  [documentation of queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) tells.
- **Worker view**: queue mode. The page is Settings > Workers.
- **Worker pools**: queue mode, and `N8N_WORKER_POOLS_ENABLED=true` on the main instances and on
  the workers. A worker with `N8N_WORKER_POOL_NAME=<pool>` takes the jobs of the queue of its pool.
  The project settings page sets the pool of a project.

## Behaviour

The sources are the ordinary callers and their tests, the configuration classes, the leader
election client (`leader-election-client.ts`), the DTOs in `@n8n/api-types`, the migration of the
table `project_pool_settings`, and the behaviour of the enterprise files, recorded black-box by the
golden tests below. The enterprise files were not read.

### Multi-main setup

- At the start, each main instance tries to set the leader key in Redis. The instance that sets it
  becomes the leader. The others become followers. When Redis fails, the instance becomes a
  follower.
- At each check, the leader renews the key. When another instance holds the key, the leader steps
  down. When the key is gone, the leader sets it again, and steps down when it cannot.
- At each check, a follower reads the key. When the key is free, the follower tries to set it and
  becomes the leader. When the key names this instance, the instance becomes the leader again, and
  the error reporter gets a report of the mismatch.
- A change of the role calls the handlers of `@OnLeaderTakeover` and `@OnLeaderStepdown`.
- The class has no limit of listeners. Each handler adds a listener, and n8n has more handlers
  than the default limit of 10 of Node.js.
- At the shutdown, the leader frees the key for another main instance.

### Worker view

- A main instance asks all workers for their status over pub/sub (`get-worker-status`), for the
  user who opened the page.
- Each worker answers with its running jobs, the memory of its process and of its host (and the
  limit of its container), its CPUs, its load, its network interfaces, its n8n version, its pool
  and its queue.
- The main instance pushes each answer to the user who asked (`sendWorkerStatusMessage`).

### Worker pools

- The pools are the pool names that the workers announce in the instance registry, sorted,
  without duplicates.
- With worker pools on and licensed, an execution of a project with a pool goes to the queue
  `jobs-<pool>`. The other executions go to the default queue `jobs`.
- `GET` and `PATCH /rest/projects/:projectId/pool-settings` give and set the pool of a project.
  Both need the licence value. `GET` needs the project scope `project:read`, and `PATCH` needs
  `project:update`. An empty pool name sends the executions of the project to the default queue.
- The cache keeps the pool of each project (`projectPool:<id>`). A change of the pool clears it.
- A project that is deleted loses its pool (the foreign key deletes the row).

## Tests

- `__tests__/golden/multi-main-setup.golden.test.ts`: the leader election at the start, at each
  check and at the shutdown, with a fake leader election client that answers, fails or names
  another instance, and the handlers of the events.
- `__tests__/golden/worker-status.golden.test.ts`: the handlers of the pub/sub events, the request
  of the status, the answer of a worker (with fake values of the operating system and the
  process) and the push to the user.
- `test/integration/worker-pools/worker-pools.golden.test.ts`: the pools of the registry, the pool
  of each execution, the REST routes of the pool settings (licence, scopes and bodies), the cache
  and the table.

The snapshots were recorded against the enterprise files, two times with the same result, and the
fork files give the same snapshots. `subject.ts` in each folder names the code under test. To
record a snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`, point `subject.ts` at the enterprise files, and run the test with
`-u`.

The ordinary tests of upstream n8n run against the fork files: `start.test.ts`, `worker.test.ts`,
`wait-tracker.test.ts`, `workflow-runner.test.ts`, `orchestration.controller.test.ts`,
`__tests__/worker-status.service.test.ts` and the integration test of the debug controller. The
fork test `__tests__/multi-main-setup.test.ts` checks that the multi-main setup has no limit of
listeners.

## Upstream updates

- The ordinary files and tests that use these classes import the fork files, for example
  `commands/start.ts`, `wait-tracker.test.ts` and `__tests__/worker-status.service.test.ts`. Keep
  the fork import paths.
- The indexes of `@n8n/db` (`entities/index.ts` and `repositories/index.ts`) import the fork
  entity and repository of the pool settings. Keep the fork import paths.
- `server.ts` loads the fork controller of the pool settings, and the manifest of the ownership
  transfer (`services/ownership-transfer/ownership-transfer.manifest.json`) names the fork entity.
  Keep the fork paths.
- When upstream changes how ordinary code uses `MultiMainSetup`, `WorkerStatusService`,
  `WorkerPoolsService` or `PoolConfigService`, change the fork classes, and record the snapshots
  again to compare.
- When an upstream migration changes the table `project_pool_settings`, change the fork entity.
