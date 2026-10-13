# The fork's evaluation editor

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md).

The evaluation editor shows the Evaluations tab of a workflow: the setup steps, the list of runs,
the detail of a run, the collections and their comparison, and the panels on the canvas. It is
part of the evaluations that the owner chose to rebuild on 2026-10-12. The fork files replace the
enterprise folder `evaluation.ee` next to this folder. They keep the store IDs, the exports that
ordinary code uses, the test IDs, the texts, the REST calls and the telemetry events of the
original.

The fork builds the editor in parts. Until the last part, the app still routes to the enterprise
files, and only the golden tests use the fork files.

| Part | Fork files | Status |
| --- | --- | --- |
| The evaluation page | `evaluation.api.ts`, `evaluation.store.ts`, `parallelEval.store.ts`, `evaluation.constants.ts`, `evaluation.types.ts`, `evaluation.utils.ts`, `composables/useEvaluationsLicense.ts`, `composables/useWorkflowEvaluationState.ts`, `composables/useCyclingVerb.ts`, `views/EvaluationsRootView.vue`, `views/EvaluationsListSwitcher.vue`, `views/EvaluationsView.vue`, `views/TestRunDetailView.vue`, and the components in `components/SetupWizard`, `components/ListRuns`, `components/RunDetail` and `components/Paywall` | Done |
| Collections and their comparison | `evalCollections.api.ts`, `evalCollections.store.ts`, `evalCollections.utils.ts`, `composables/useEvalCollectionsFlag.ts`, `composables/useAgentEvalsFlag.ts`, `composables/useCompareData.ts`, `views/EvalCollectionsListView.vue`, `views/CompareCollectionView.vue`, and the components in `components/Collections`, `components/Compare` and `components/shared` | Done |
| The panels on the canvas and the dataset modal | | Next |

## Sources

- The ordinary callers of the enterprise folder: the router, `NodeView.vue`, `Modals.vue`,
  `FocusSidebar.vue`, `WorkflowProductionChecklist.vue`, the node creator, the executions
  preview, the agent builder and the n8n Assistant, with their tests.
- The texts in `@n8n/i18n` (`evaluation.*` and `evaluations.*`), the REST API of the fork backend
  (see [the backend FORK.md](../../../../../../cli/src/evaluation/FORK.md)) and the contracts of
  `@n8n/api-types`.
- The ordinary code of the Evaluation nodes, for the operations and the metrics of a node.
- The public documentation of
  [evaluations](https://docs.n8n.io/advanced-ai/evaluations/overview/).
- The behaviour of the original files, recorded black-box: the exports and the store members at
  run time, the rendered DOM (an outline of the elements and the text nodes), the local storage,
  the requests, and the golden tests below. The enterprise files were not read.

## Behaviour of the evaluation page

- The root view loads the licence usage and, for a saved workflow, the runs. A workflow without
  runs shows the setup steps. Without evaluations in the licence (a limit of 0 workflows), it
  shows the paywall, which opens the registration of a Community instance. A workflow with runs
  shows the child page. The view sends `User viewed tests tab` once.
- The setup steps check for an evaluation trigger, a Set Outputs node and a Set Metrics node.
  Disabled nodes count. An Evaluation node without an operation is a Set Outputs node. The buttons
  open the canvas with the actions `addEvaluationTrigger`, `addEvaluationNode` and
  `executeEvaluation`. When the licence quota of workflows with evaluations is full, the step of
  the metrics shows a callout and a link to the plans, and the last step runs only in the editor.
- The list of runs numbers the runs from the oldest by their start time, and shows the newest
  first. "Run Test" starts a run with the chosen concurrency (3 by default, up to the licence
  limit or 10). A limit of 1 sends no body. "Stop Test" cancels the running run. The browser
  keeps the concurrency of each workflow in the local storage key `N8N_PARALLEL_EVAL_BY_WORKFLOW`,
  as the original does. To open the concurrency controls turns on parallel runs for the workflow.
- The store asks for each active run (`new` or `running`) and its cases now and then each
  second, until the run ends. Each load of the list starts this again. The detail page of an
  active run also asks each second.
- The detail page shows the state of the run, the average of each metric with the change from
  the last completed run before it, and a card for each case. A score from 0 to 1 shows as a
  percentage, a score of an AI-based metric (1 to 5) as a share of 5, a boolean as 100% or 0%,
  and a value above 1 as a percentage. "Re-run test" starts a new run of the workflow and opens
  it. The detail page loads its data only when it opens.

## Behaviour of the collections

- The collections show when the setting `evaluation.collectionsEnabled` or the PostHog flag
  `084_eval_collections` is on. The default child page then shows the collections list below the
  list of runs. It loads the list view only for these users.
- The list loads the collections, the evaluation configs and the runs, and then the detail of
  each collection. A collection runs while one of its runs is `new` or `running`, failed when all
  its runs failed, and is done in the other cases. The list asks again for the detail of a running
  collection every 3 seconds, until it ends. The runs that no collection holds show below, the
  newest first.
- The dialog of a new collection loads the evaluation configs (the datasets) each time it opens,
  and the versions of the chosen dataset. The current draft stays on top of the versions. The
  others go by the time of their last run, and a version without a run counts as the oldest.
  The letters of the versions, the source filter and the request keep the order of the server. A
  version with a run on the dataset reuses it, and a version without one gets a new run. The
  dialog needs a name and two or more versions. After the create, the list loads the collections,
  the new collection and the runs again.
- The comparison loads the collection, then the cases of each run, the licence and the evaluation
  configs. It sends `Eval collection compared opened`. A collection with two or more runs that
  all completed asks for its insights. A running collection asks again for itself and for the
  cases of its running runs every 3 seconds. When the last run ends, it asks for the insights.
  "Re-run" starts the runs again, loads the collection once more, and asks again every 3
  seconds until the runs end. A collection that is not there shows a message, and an error other
  than "not found" also shows a toast.
- The comparison shows a score from 0 to 1 as a percentage and a score of an AI-based metric
  (1 to 5) as a share of 5, by the metric scales of the collection. A case that a version did
  not run shows `⊘`. The cases table sorts by the largest fall from the best version first. The
  notice about other case counts counts the cases of the completed runs only.
- `useEvaluationsLicense` loads the licence once for the whole app, as the original does. The
  pages that load the licence on their own do not count, so the first comparison asks for it
  once more.

## Differences from the original

1. **Booleans in the list of runs.** The list of the original fails with a type error when a run
   has a boolean metric. The fork shows `1.00` or `0.00`. The golden test leaves out this case.
2. **Runs with the same start time.** When the collections list loads the runs again, the list
   of runs of the original can show runs with the same start time in another order. The fork
   keeps the order. The golden test of the collections gives each run its own start time.

## Changes to ordinary files

- `@n8n/i18n`: two texts that the original page had without a translation key,
  `evaluation.listRuns.runAt` ("Run at") and `evaluation.listRuns.selectMetric` ("Select metric").

## Tests

The golden tests are in `__tests__/golden`. Each snapshot was recorded against the enterprise
files, and the fork files give the same snapshot:

- `evaluation-page.golden.test.ts`: the licence states, the setup steps, the list of runs, the
  error codes, the concurrency, the polling, the detail of a run, the state that ordinary code
  reads (`useWorkflowEvaluationState`, `useEvaluationStore().isEvaluationEnabled` and
  `useEvaluationsLicense`).
- `collections.golden.test.ts`: the collections flag, the list of collections and runs, the
  polling of a running collection, the dialog of a new collection (the dataset, the versions,
  the filter, the sort, the create and its errors), and the comparison (the scores, the insights,
  the cases, the outputs, the metrics, the workflow diff, the re-run and the errors). The
  switcher loads the list view on demand, so the test keeps that module loaded.

`harness.ts` gives a fake REST server, a router with the names and paths of the app routes, and a
description of what a user sees: the text, the test IDs, the controls, the icons, the data of
the charts, the toasts, the telemetry and the opened windows. It records no markup and no styles.
`node-types.json` holds the built descriptions of the Evaluation nodes, the manual trigger, the
AI Agent and the OpenAI chat model. To make it again, build `nodes-base` and
`@n8n/nodes-langchain`, copy these descriptions from the `dist/types/nodes.json` file of each
package, and put the package name before each node name (`n8n-nodes-base.evaluation`,
`@n8n/n8n-nodes-langchain.agent`).

To record a snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`. Copy the folder `__tests__/golden` into
`features/ai/evaluation.ee/__tests__/` there, point the exports of `subject.ts` at the
enterprise files, and run the test with `--update=all`. Use `--update=all` with the equals sign:
`-u` takes the next argument as its value and then runs all tests of the package.

## Clean-room record

- I did not open an enterprise file of this folder.
- A search without the exclusion globs printed five lines of the enterprise file
  `features/integrations/externalSecrets.ee/views/SettingsExternalSecrets.vue`: an import line
  of design-system components and four template lines. The fork files do not use them.
