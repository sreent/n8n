# The fork's evaluation backend

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md).

An evaluation runs a workflow once for each row of a test dataset, and keeps the metrics of each
row. This folder holds the backend: the test runner, the REST API of test runs, the evaluation
configs, the collections and the insights. It is part of the evaluations that the owner chose to
rebuild on 2026-10-12. The fork files replace the enterprise folder `cli/src/evaluation.ee`, with
the same class names, exports, routes, pubsub commands and telemetry events. Ordinary code
changes only its import paths.

| Fork file | What it does | Enterprise file that it replaces |
| --- | --- | --- |
| `test-runs.controller.ts` | The REST API of the test runs of a workflow | `test-runs.controller.ee.ts` |
| `test-runner/test-runner.service.ts` | Starts, runs and cancels test runs | `test-runner/test-runner.service.ee.ts` |
| `test-runner/test-run-cleanup.service.ts` | Marks the runs that a stop of n8n interrupted | `test-runner/test-run-cleanup.service.ee.ts` |
| `test-runner/workflow-compiler.service.ts` | Makes the workflow that a run of a config runs | `test-runner/workflow-compiler.service.ts` |
| `test-runner/evaluation-metrics.ts` | Adds up the metrics of the cases | `test-runner/evaluation-metrics.ee.ts` |
| `test-runner/errors.ts`, `test-runner/utils.ts` | The errors of a run and of a case, and two helpers | `test-runner/errors.ee.ts`, `test-runner/utils.ee.ts` |
| `evaluation-test-run.service.ts` | The queries of the public API of test runs | `evaluation-test-run.service.ts` |
| `evaluation-concurrency.helper.ts` | The number of cases that run at the same time | `evaluation-concurrency.helper.ts` |
| `evaluation-config.controller.ts` | The REST API of evaluation configs and their dataset routes | `evaluation-config.controller.ts` |
| `evaluation-config.service.ts`, `evaluation-config-validator.ts` | Saves and checks evaluation configs | the files with the same names |
| `evaluation-dataset.service.ts` | Adds a row from an execution to the dataset of a config | `evaluation-dataset.service.ts` |
| `evaluation-api-error.ts` | The error of the config API, with a typed code | `evaluation-api-error.ts` |
| `llm-judge-provider-registry.ts` | The chat models that an LLM judge can use | `llm-judge-provider-registry.ts` |
| `metric-scales.ts` | The scale of each metric of a run, for the charts | `metric-scales.ts` |
| `evaluation-collections.controller.ts`, `evaluation-collection.service.ts` | Collections of runs that compare versions of a workflow | `evaluation-collections.controller.ee.ts`, `evaluation-collection.service.ts` |
| `insights/eval-insights.controller.ts`, `insights/eval-insights.service.ts` | The insights of a collection | `insights/eval-insights.controller.ee.ts`, `insights/eval-insights.service.ts` |

The enterprise files `insights/insights-context-builder.ts`, `insights/insights-model-resolver.ts`
and `test-runs.types.ee.ts` have no fork file: the fork insights ask no language model, and the
request types are in the controllers.

The tables of test runs, test cases, configs and collections are in `@n8n/db`. Their entities and
the repositories of test runs and test cases are fork files too, see
[the entities FORK.md](../../../@n8n/db/src/entities/FORK.md#the-evaluation-tables).

## Sources

- The ordinary callers: the public API controller `public-api/v1/controllers/evaluations.public.controller.ts`,
  `commands/base-command.ts`, `concurrency/concurrency-control.service.ts`,
  `services/frontend.service.ts`, the modules `agent-evals` and `instance-ai`, `server.ts` and the
  test server.
- The contracts of `@n8n/api-types`: `schemas/evaluations.schema.ts`, the DTOs in
  `dto/evaluations` (the config, the error codes, the dataset rows and the providers of the LLM
  judges), `schemas/eval-collections.schema.ts` with its metric scales, and
  `schemas/eval-insights.schema.ts`.
- The ordinary migrations of the tables, the ordinary tests (`test/integration/evaluation/test-runs.api.test.ts`,
  `test/integration/public-api/evaluations.test.ts`, the repository tests of `@n8n/db` and the
  migration test of the scaling fields), and the test helpers in `test/integration/shared/db/evaluation.ts`.
- The ordinary engine code: `forceCustomOperation` of a node, the manual execution service, the
  workflow runner, the active executions and the evaluation queue of the concurrency control.
- The ordinary code of the Evaluation nodes (`nodes-base/nodes/Evaluation/utils`), and the skill
  `config-evals` of the n8n Assistant in `@n8n/instance-ai`.
- The public documentation of
  [metric-based evaluations](https://docs.n8n.io/advanced-ai/evaluations/metric-based-evaluations/).
- The behaviour of the original files, recorded black-box: the routes, the exports and the method
  names of the modules at run time, the mapping of the entities, and the golden tests below. The
  enterprise files were not read.

## Behaviour

### Test runs

- `POST /rest/workflows/:workflowId/test-runs/new` starts a run and answers 202 with
  `{ success: true, testRunId }`. The user needs `workflow:execute` on the workflow. The body can
  name an evaluation config, ask for the compiled workflow of the config, give the indices of the
  dataset rows to run, and ask for a number of parallel cases (`concurrency`, 1 by default). The
  REST API does not check the quota of workflows with evaluations. The public API checks it, as
  before.
- The other routes list the runs (newest first, with the number of cases and the final result),
  read a run and its cases, delete a run, cancel a run and cancel one pending case. Reads need
  `workflow:read`, changes need `workflow:execute`.
- A run does these steps:
  1. It sets the status `running` and the ID of this main instance.
  2. It loads the saved workflow, or the version of the workflow history that the run pins. A run
     of a config runs the compiled workflow (see below).
  3. It checks the workflow: an enabled Evaluation Trigger, Set Metrics nodes with metrics (or a
     connected chat model for a metric that a model scores), and Set Outputs nodes with outputs.
  4. It reads all rows of the dataset. The Evaluation Trigger runs its operation `getRows` in a
     manual execution that saves no data. n8n keeps it as a deleted execution, as in the
     original.
  5. It writes one case for each row, with the row as the inputs.
  6. It runs the cases in parallel, up to the limit. Each case is an execution in the mode
     `evaluation`, with the row as the pinned output of the trigger. The user can open it.
  7. A case keeps the metrics of the Set Metrics nodes, the token usage and the execution time,
     and the data of Set Inputs and Set Outputs. A case of a compiled run keeps the dataset row as
     its inputs and the output of the end node as its outputs.
  8. The run keeps the average of each metric, and ends as `completed`, `cancelled` or `error`
     with an error code.
- A cancel stops the cases of a run that this instance runs. For a run of another main instance,
  the run gets the cancellation flag and ends as `cancelled` at once, with its pending cases. The
  instance that runs it reads the flag before each case, and then stops the run. In multi-main
  mode, the cancel also sends the pubsub command `cancel-test-run` (for a collection,
  `cancel-collection`). The main instance that runs the run then stops its cases at once, also the
  cases that run now.
- When n8n starts, `TestRunCleanupService` marks the runs with the status `new` or `running` as
  `error` with the code `INTERRUPTED`.
- The limit of parallel cases: `N8N_CONCURRENCY_EVALUATION_LIMIT` when it is set, else the licence
  quota, else the plan: Community and Pro 1, Business 3, Enterprise 5. The fork switch gives no
  quota and the fork has no licence keys, so the plan is Community: without the variable, the cases
  run one at a time. `deploy/` sets the variable to 5, as the Enterprise plan.

### Evaluation configs

- A config pairs a workflow with a start node, an end node, metrics and a Data table. The REST API
  is `/rest/workflows/:workflowId/evaluation-configs`. Reads need `workflow:read`, changes need
  `workflow:update`.
- A new config checks, in this order: the start and end nodes exist, no node uses the prefix
  `__eval_`, the end node comes after the start node, the start node has one input at most, the
  dataset is a Data table, the metric IDs and names are unique, no metric input is only spaces, a
  boolean metric is a plain value or one expression, each LLM judge names a known chat model and a
  credential of its type that the user can read, and the Data table exists. The first check that
  fails gives an `EvaluationApiError`, and the REST API answers 500 with its message, as in the
  original.
- The first config of a workflow needs room in the quota of workflows with evaluations
  (`quota:evaluations:maxWorkflows`). A quota of 0 or of no limit checks nothing. The fork switch
  gives no limit.
- The compiler copies the workflow. It removes the Evaluation Triggers and disables the Set
  Metrics and Set Outputs nodes. It adds a dataset trigger before the start node, and one Set
  Metrics node for each metric after the end node, with a chat model below each LLM judge. Nodes
  after the end node do not run. When the workflow has lost the end node, the metric nodes have no
  input, and each case fails without metrics.
- A boolean metric gives 1 or 0. An expression gets a condition around it. A plain value that n8n
  reads as a boolean (`true`, `false`, `1`, `0`) becomes the number. The original runs of such a
  value were not recorded.
- The dataset routes give the fields of a successful execution with a suggested mapping, and add
  a row from the execution to the Data table of the config.

### Collections and insights

- A collection compares runs of one config on versions of the workflow: the current draft, or a
  version of the history. The REST API is `/rest/workflows/:workflowId/eval-collections` and
  `/rest/workflows/:workflowId/eval-versions`, with the project scopes of the original. The
  feature flag of collections (or `N8N_EVAL_COLLECTIONS_ENABLED`) turns these routes and the
  insights on. Without it, they answer 404. Without the telemetry of n8n (the default of
  `deploy/`), only the variable turns them on, and `deploy/` sets it. The routes of configs and test runs check no flag,
  as in the original.
- A rerun starts a new run for each version of a collection, and moves the old runs out of the
  collection. A second rerun of the same collection fails with 409 while the first starts its
  runs.
- The insights name the best run, the regressions of the other runs and a next experiment. The
  fork computes them from the metrics of the runs, so `modelUsed` is `deterministic` and the
  status is `fallback`. With the fork switch off, the route needs the licence of the AI assistant
  (`feat:aiAssistant`), as in the original. While the switch is on, it needs no licence, because the
  fork insights ask no language model.

## Differences from the original

1. **Insights ask no language model.** The original could ask a model of the AI assistant. The
   fork always gives the text that the original gave without a model (recorded in the golden
   test). The chat of the AI assistant needs a service of n8n, and the fork does not rebuild it.
2. **A rerun of a collection works on SQLite.** On SQLite, the original rerun waited 60 seconds
   for the write lock and failed. The fork has its own test of the rerun.
3. **No unhandled errors.** When the engine stopped a run before its first node (for example, a
   workflow with issues), the original left an unhandled promise rejection in the process. The
   fork ends the run with the same error code, and catches the error.
4. **Insights need no licence while the fork switch is on.** The original needs the licence of the
   AI assistant for the insights. The fork insights ask no language model, so the fork asks for
   this licence only while the fork switch is off. The golden test runs with the switch off and
   records the original behaviour. `insights/__tests__/eval-insights.controller.test.ts` tests both
   cases.

## Changes to ordinary files

- The import paths of the ordinary callers and tests (`@/evaluation.ee/...` to
  `@/evaluation/...`), and of the index files and the ordinary repositories of `@n8n/db`.
- `EvaluationConfigRepository.countWorkflowsWithConfigs` (a fork method): the number of
  workflows with configs. The ordinary `countDistinctWorkflowsWithConfigs` counts the configs,
  because `getCount()` of TypeORM counts distinct primary keys.

## Tests

The golden tests are in `test/integration/evaluation`. Each snapshot was recorded against the
enterprise files, before the switch, and the fork files give the same snapshot:

- `test-runs.api.golden.test.ts`: each route of the test runs as the owner, an admin, a member,
  and the admin, the editor and the viewer of a project.
- `test-runner.golden.test.ts` and `test-runner-extra.golden.test.ts`: real runs with the
  Evaluation nodes and a Data table: the runs, the cases, their executions, the dataset rows and
  the telemetry. They include runs that cannot start, failed cases, error workflows, Set Inputs,
  more than one Set Metrics node, row indices, a cancel while a case runs, and parallel cases.
- `evaluation-config.golden.test.ts` and `evaluation-config-extra.golden.test.ts`: the config
  service as the n8n Assistant calls it, the checks of a config, the quota, and a config whose
  workflow changes.
- `evaluation-features.golden.test.ts`: the REST API of configs, the dataset routes, the compiled
  runs, the collections, the versions and the insights, with the events and the telemetry.
- `evaluations.public.golden.test.ts`: the public API of test runs with the fork services.
- `evaluation-entities.golden.test.ts`: the mapping of the four entities.
- `test-run-cleanup.golden.test.ts`, `evaluation-concurrency.golden.test.ts` and
  `llm-judge-provider-registry.golden.test.ts`: the cleanup, the limit of parallel cases and the
  providers of the LLM judges.

Fork tests: `evaluation-collections.rerun.test.ts` (the rerun),
`test-runner/__tests__/workflow-compiler.service.test.ts` (the boolean metrics, a lost end node
and the version of the chat model), and `test-runner/__tests__/test-runner.service.test.ts` (the
cancel commands of multi-main mode). The ordinary tests of the REST API, the public API, the
repositories, the migration of the scaling fields, and the modules `agent-evals` and
`instance-ai` run on the fork files.

To record a snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`. Copy the golden test and its snapshot into
`packages/cli/test/integration/evaluation` there. Change the imports from `@/evaluation/` to
`@/evaluation.ee/`, and add `.ee` to the file names that have it upstream (the collections and
insights controllers, and the cleanup service). Then run the test with `-u`. The upstream index
files of `@n8n/db` export the enterprise entities and repositories.

## Clean-room record

- I did not open an enterprise file. I deleted the enterprise files by their names.
- While the fork prepared part 3, a scratchpad probe used recording proxies on the enterprise
  repositories. The entities FORK.md of `@n8n/db` describes this slip. The fork repositories come
  from the ordinary code and from black-box tests.
- One search without the exclusion globs printed three import lines of enterprise files of
  `@n8n/db`: the type `TestRunStatus` and the imports between the two enterprise entities. The
  fork entities take their relations from the recorded mapping, not from these lines.
- A recording of the original runner ended with an unhandled error. Vitest printed its stack
  trace: the enterprise file name, two method names and their line numbers. No source was
  printed.
- One search named the path of an enterprise file that step 2 removed. It read nothing.

## Upstream updates

`scripts/sync-upstream.sh` deletes the replaced enterprise files again. When an upstream update
changes a route, a DTO, the engine or the Evaluation nodes, a golden test can fail. Compare the
change with the upstream change, then update the fork code or the snapshot.
