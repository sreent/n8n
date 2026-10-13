# The fork's evaluation editor

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md).

The evaluation editor shows the Evaluations tab of a workflow: the setup steps, the list of runs,
the detail of a run, the collections and their comparison, and the panels on the canvas. It is
part of the evaluations that the owner chose to rebuild on 2026-10-12. The fork files replace the
enterprise folder `evaluation.ee` that was next to this folder. They keep the store IDs, the
exports that ordinary code uses, the test IDs, the texts, the REST calls and the telemetry events
of the original.

The fork built the editor in parts. The last part switched the app to the fork files and deleted
the enterprise folder.

| Part | Fork files | Status |
| --- | --- | --- |
| The evaluation page | `evaluation.api.ts`, `evaluation.store.ts`, `parallelEval.store.ts`, `evaluation.constants.ts`, `evaluation.types.ts`, `evaluation.utils.ts`, `composables/useEvaluationsLicense.ts`, `composables/useWorkflowEvaluationState.ts`, `composables/useCyclingVerb.ts`, `views/EvaluationsRootView.vue`, `views/EvaluationsListSwitcher.vue`, `views/EvaluationsView.vue`, `views/TestRunDetailView.vue`, and the components in `components/SetupWizard`, `components/ListRuns`, `components/RunDetail` and `components/Paywall` | Done |
| Collections and their comparison | `evalCollections.api.ts`, `evalCollections.store.ts`, `evalCollections.utils.ts`, `composables/useEvalCollectionsFlag.ts`, `composables/useAgentEvalsFlag.ts`, `composables/useCompareData.ts`, `views/EvalCollectionsListView.vue`, `views/CompareCollectionView.vue`, and the components in `components/Collections`, `components/Compare` and `components/shared` | Done |
| The panels on the canvas and the dataset modal | `wizardSidepanel.store.ts`, `wizard.constants.ts`, `wizard.utils.ts`, `composables/useTestsPanel.ts`, `composables/useAiRootNodes.ts`, `composables/useAddExecutionToDataset.ts`, and the components in `components/Tests`, `components/EvaluationsCanvasInfoCard`, `components/EvaluationsEmptyState`, `components/WizardSidepanel` and `components/AddExecutionToDataset` | Done |
| The switch of the app to the fork files | The import paths of the ordinary callers and their tests. The enterprise folder is deleted, and `scripts/removed-enterprise-paths.txt` lists it. | Done |

## Sources

- The ordinary callers of the enterprise folder: the router, `NodeView.vue`, `Modals.vue`,
  `FocusSidebar.vue`, `WorkflowProductionChecklist.vue`, the node creator, the executions
  preview, the agent builder and the n8n Assistant, with their tests.
- The texts in `@n8n/i18n` (`evaluation.*` and `evaluations.*`), the REST API of the fork backend
  (see [the backend FORK.md](../../../../../../cli/src/evaluation/FORK.md)) and the contracts of
  `@n8n/api-types`.
- The ordinary code of the Evaluation nodes, for the operations and the metrics of a node.
- The ordinary list of AI root node types in `@n8n/workflow-sdk` (`mock-data/ai-root-shapes.ts`),
  the REST helpers of the data tables, the executions store and the experiment
  `useEvaluationsWizardSidepanelExperiment`.
- The public documentation of
  [evaluations](https://docs.n8n.io/advanced-ai/evaluations/overview/).
- The behaviour of the original files, recorded black-box: the exports, the constants and the
  store members at run time, the values of the setup state of a component, the rendered DOM (an
  outline of the elements and the text nodes), the local storage, the requests, the timing of the
  saves, and the golden tests below. The enterprise files were not read.

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
  second, until the run ends. Each load of the runs adds a polling of its own, as the original
  does: the detail page loads the runs once more, so it asks twice each second. A polling ends
  when it finds the run done or fails, and the other pollings of the run go on.
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

## Behaviour of the panels on the canvas

- The panels show when the setting `evaluation.configEvalsEnabled` or the experiment of the
  evaluations side panel is on. With it, the Evaluations tab of a workflow without runs shows an
  empty state, and "Get started" opens the canvas with the action `openEvaluationsWizard`.
  Without evaluations in the licence it shows only the paywall.
- The info card on the canvas shows for a published workflow with an AI node (an agent, a chain
  or a model node of a vendor) and evaluations in the licence. It asks for the evaluation configs
  of the workflow once, and shows only when there are none. An error counts as a config. "Setup"
  sends `User opened evaluations wizard` and opens the Tests panel. The close button keeps the
  workflow in the local storage key `N8N_EVALUATIONS_CANVAS_INFO_CARD_DISMISSED`.
- The Tests panel loads when its tab of the focus sidebar is open, or when the canvas opens it.
  It loads the 10 newest successful executions and the saved setup: the evaluation config of the
  workflow, the rows of its data table and the newest run of the config. A workflow without
  nodes shows "Add node", and a workflow without executions and without a saved setup shows
  "Execute workflow". An execution from the executions page becomes a new case when the panel
  loads.
- The input fields of a case are the fields of the input of the AI node: in the execution of a
  new case, else in the last run of the editor, else one field `input`. Pinned data does not
  count. So after a load of a saved setup the field is `input`, and the next save adds an `input`
  column to the data table, as the original does.
- The panel keeps the dataset (the data table `Evaluation: <workflow name>`) and the config in
  step with its state. A change of the checks, of the AI node or a load of the saved setup saves
  the dataset and the config after 1.5 seconds. A change of a case (an input, an expected value,
  the name) saves the case too, after 1.5 seconds of its own. A new case without changes is not
  saved. "Run" saves the case and starts a run of its row, "Run all" starts a run of all rows.
  The config starts the run at the node after the trigger and ends it at the AI node. Each save
  gives the checks new IDs. A check with an AI judge takes the chat model, the credential and the
  model of the AI node, and a save without them fails with "Missing model selection".
- The results show the newest run of the config, or the run that the panel started. A failed case
  loads its execution. An open result shows the answer of the AI node from the execution of the
  case, else from the outputs of the case. "Delete case" asks first, deletes the row and loads the
  list again.
- The dataset modal loads the configs with a data table, the columns of the table and the fields
  of the execution. The user maps each column to an input or output field, or leaves it empty,
  and the modal adds the row.

## Differences from the original

1. **Booleans in the list of runs.** The list of the original fails with a type error when a run
   has a boolean metric. The fork shows `1.00` or `0.00`. The golden test leaves out this case.
2. **Runs with the same start time.** When the collections list loads the runs again, the list
   of runs of the original can show runs with the same start time in another order. The fork
   keeps the order. The golden test of the collections gives each run its own start time.

## Changes to ordinary files

- The import paths of the ordinary callers and of their tests, from
  `@/features/ai/evaluation.ee/` to `@/features/ai/evaluation/`: the router, `NodeView.vue`,
  `Modals.vue`, `FocusSidebar.vue`, `WorkflowProductionChecklist.vue`, the node creator
  (`useActionsGeneration.ts` and `viewsData.ts`), the executions preview, the agent builder
  (`useAgentBuilderMainTabs.ts`) and the n8n Assistant (`InstanceAiThreadView.vue`).
- `@n8n/i18n`: two texts that the original page had without a translation key,
  `evaluation.listRuns.runAt` ("Run at") and `evaluation.listRuns.selectMetric` ("Select metric").

## Tests

The golden tests are in `__tests__/golden`. Each snapshot was recorded against the enterprise
files, and the fork files give the same snapshot:

- `evaluation-page.golden.test.ts`: the licence states, the setup steps, the list of runs, the
  error codes, the concurrency, the polling, the detail of a run, the state that ordinary code
  reads (`useWorkflowEvaluationState`, `useEvaluationStore().isEvaluationEnabled` and
  `useEvaluationsLicense`).
- `canvas-panels.golden.test.ts`: the empty state of the Evaluations tab, the info card, the Tests
  panel (the first states, a case from an execution, a manual case, the checks, saved cases,
  the input fields, a second agent, an execution from the executions page, the saves, the runs
  and the errors) and the dataset modal. The fake server keeps data tables, configs and runs,
  and a new run completes 1.2 seconds after its start. The IDs of the checks are random, and
  the test replaces them with `<id>`. The exports of `panels-subject.ts` name the code under
  test.
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

The fork no longer has the enterprise files. To record a snapshot again after an upstream update,
use a checkout of the upstream commit in `scripts/sync-upstream.base`. Copy the folder
`__tests__/golden` into `features/ai/evaluation.ee/__tests__/` there, point the exports of
`subject.ts` and `panels-subject.ts` at the enterprise files, and run the test with
`--update=all`. Use `--update=all` with the equals sign: `-u` takes the next argument as its value
and then runs all tests of the package.

## Clean-room record

- I did not open an enterprise file of this folder.
- A search without the exclusion globs printed five lines of the enterprise file
  `features/integrations/externalSecrets.ee/views/SettingsExternalSecrets.vue`: an import line
  of design-system components and four template lines. The fork files do not use them.
