# The fork's worker view

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md) and
[the FORK.md of the scaling code](../../../../../../cli/src/scaling/FORK.md).

This folder holds the fork's worker view: the page Settings > Workers and its store. It replaces
the enterprise folder `orchestration.ee`. The files that ordinary code imports keep the names and
the exports of the enterprise files. Thus the callers change only their import paths.

| Fork file                | Ordinary code that imports it                                     |
| ------------------------ | ----------------------------------------------------------------- |
| `views/WorkerView.vue`   | `app/router.ts` (the route `/settings/workers`)                   |
| `orchestration.store.ts` | `app/composables/usePushConnection/handlers/sendWorkerStatusMessage.ts` |

The other files are fork files: the card of a worker and its sections (`components/`) and the
formats (`orchestration.utils.ts`).

## Turn it on

The page shows the workers when the instance runs in queue mode (`EXECUTIONS_MODE=queue`) and the
licence value `feat:workerView` is on. The fork switch turns it on (step 5 of FORK.md). The
settings menu shows **Workers** only in queue mode (`useSettingsItems.ts`, ordinary code). The
route needs the global scope `workersView:manage`.

## Behaviour

### The store

The store (`orchestrationManager`) keeps the newest status of each worker, the time of that status,
and a history of the last 100 statuses (`WORKER_HISTORY_LENGTH`) with their times. The push
message `sendWorkerStatusMessage` gives it the statuses (`updateWorkerStatus`).

- While the page is open, the store sends `POST /rest/orchestration/worker/status` each second.
  The first request goes one second after the page opens. A second start does nothing.
- After each request that succeeds, the store removes the workers that sent no status for more
  than 120 seconds. When the request fails, the store removes nothing, and the error is not
  caught.
- `getWorkerLastUpdated` gives 0, `getWorkerStatus` gives `undefined` and `getWorkerStatusHistory`
  gives an empty list for an unknown worker.

### The page

- Without queue mode or without the licence value, the page shows the box "Available on the
  Enterprise plan" with the link "More info" to the documentation and the button "See plans",
  which opens the pricing page (`goToUpgrade('worker-view', 'upgrade-worker-view')`). The page
  sends no request.
- Otherwise the page sends the telemetry event "User viewed worker view" and starts the requests.
  It stops them when it closes. It shows a spinner until the first status comes, then a card for
  each worker in the order of their first status, or "No workers are responding or available".
- A card shows the name, the host, the pool ("default" without a pool), the queue, the mean of the
  load averages, and the free memory of the worker against the limit of its container or the
  memory of the host. Under it: the age of the status, the n8n version, the architecture, the
  platform and the uptime of the worker process.
- The age counts up each half second from the first half second of the card, and rounds up to
  whole seconds. Above 10 seconds, the card shows "(stale)".
- Four sections open and close:
  - **Current Jobs** (open at first): each running job with a link to the execution and to the
    workflow, the start time and the run time. The run time is the one of the newest status.
  - **Network Interfaces**: the IPv4 addresses, then the IPv6 addresses. A click on an address
    copies it and shows the toast "Address copied to clipboard".
  - **Performance Monitoring**: three line charts of the last 100 statuses: the number of jobs,
    the mean load and the used memory in percent. The charts change with each new status of any
    worker. They show the history before that status, so the newest status comes with the next
    one.
  - **Memory Monitoring**: the memory of the host, and the memory of the process (with the limit
    of the container for a worker in a container).

## Clean-room sources

- The ordinary code that uses these files (the table above), the push handler, the REST client
  `@n8n/rest-api-client/api/orchestration.ts`, the type `WorkerStatus` of `@n8n/api-types` and the
  i18n texts `workerList.*`.
- The ordinary Playwright page object `WorkerViewPage.ts` and its spec.
- The behaviour of the original files, recorded black-box by the golden test below. Before the
  test, a black-box probe recorded the exports of the store module and the names of its members.
  The enterprise files were not read.

## The golden test

`__tests__/golden/worker-view.golden.test.ts` runs the store and the page against a fake server,
with the harness of the evaluation editor (`@/features/ai/evaluation/__tests__/golden/harness`)
and fake timers. It gives the store statuses as the push messages do, lets time pass, clicks the
controls, and records the state of the store, the requests, what a user sees (the text, the test
IDs, the controls and the icons), the toasts, the telemetry and the data of the charts (through a
stub of `vue-chartjs`). It records no markup and no styles. 18 tests.

The snapshot was recorded against the enterprise files, two times with the same result, and the
fork files give the same snapshot.

To record the snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`. Copy the folder `__tests__/golden` and the harness of the evaluation
editor into the same paths there. Point the exports of `subject.ts` at the files in
`@/features/settings/orchestration.ee/`, and run the test with `-u`.

## Upstream updates

The fork added i18n texts for the labels of its card that upstream n8n does not have (for example
`workerList.item.name` and `workerList.item.memory.*`). When an upstream update changes the texts
`workerList.*` or the type `WorkerStatus`, record the snapshot again and compare it with the fork.
