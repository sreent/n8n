# The fork's worker view stand-ins

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md) and
[the FORK.md of the scaling stand-ins](../../../../../../cli/src/scaling/FORK.md).

The fork removed the worker view with the enterprise folder `orchestration.ee`. Two ordinary files
import from it: the router (the page) and the push handler `sendWorkerStatusMessage.ts` (the
store). Stand-ins at the fork paths keep them, with only the import paths changed:

| Fork file | Enterprise file that it replaces |
| --- | --- |
| `views/WorkerView.vue` | `orchestration.ee/views/WorkerView.vue` |
| `orchestration.store.ts` | `orchestration.ee/orchestration.store.ts` |

## Behaviour

- The page `/settings/workers` shows the box `worker-view-unlicensed`: "The worker view is not
  available. This build of n8n does not show the status of the queue mode workers." The test id is
  the one of the unlicensed view in the ordinary Playwright page object `WorkerViewPage.ts`.
- The settings menu shows **Workers** only in queue mode, as in upstream n8n.
- The store takes the worker status of the push message `sendWorkerStatusMessage`, and keeps
  nothing. The fork's backend sends no such message.

## Differences from upstream

The licensed tests of the ordinary Playwright spec `tests/e2e/settings/workers/workers.spec.ts` do
not apply: the fork has no worker list.

## Tests

`__tests__/WorkerView.test.ts` tests the page and the store.
