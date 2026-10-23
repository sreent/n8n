# The fork's entities in @n8n/db

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md).

## The workflow review tables

The enterprise module of workflow reviews is gone (step 1 of FORK.md). Its six database entities
stayed, because ordinary repositories use them. The fork replaced them in step 4 with its own
entities, with the same names and exports. Later in step 4, the fork rebuilt the module
(`packages/cli/src/modules/workflow-reviews`), which uses the ordinary repositories:

| Fork file | Table | Enterprise file that it replaces |
| --- | --- | --- |
| `workflow-review-request.ts` | `workflow_review_request` | `workflow-review-request.ee.ts` |
| `workflow-review-request-workflow.ts` | `workflow_review_request_workflow` | `workflow-review-request-workflow.ee.ts` |
| `workflow-review-request-reviewer.ts` | `workflow_review_request_reviewers` | `workflow-review-request-reviewer.ee.ts` |
| `workflow-review-request-author.ts` | `workflow_review_request_authors` | `workflow-review-request-author.ee.ts` |
| `workflow-review-activity.ts` | `workflow_review_activity` | `workflow-review-activity.ee.ts` |
| `workflow-review-activity-comment.ts` | `workflow_review_activity_comment` | `workflow-review-activity-comment.ee.ts` |

`workflow-review-request.ts` also exports `WorkflowReviewRequestStateList`,
`WorkflowReviewRequestState`, `WorkflowReviewRequestDecisionList` and
`WorkflowReviewRequestDecision`, as the enterprise file did.

### Sources

- The columns, their types and their defaults: the ordinary migrations
  `CreateWorkflowReviewRequestTables1784000000052`,
  `CreateWorkflowReviewActivityTablesAndBaseline1785843640527` and
  `DropWorkflowReviewActivityTypeCheckAndWorkflowIdColumn1787089039727`.
- The property names, the ID generation and the timestamps: the ordinary repositories
  `workflow-review-*.repository.ts` and `workflow-history.repository.ts`, the ordinary migration
  test of the activity tables, and the ordinary integration test of `WorkflowHistoryRepository`.
- The type of an activity entry: `WorkflowReviewActivityType` in `@n8n/api-types`.

### Behaviour

- The entities have columns only, with no relations: the ordinary repositories join the tables
  with explicit conditions. The migrations keep the foreign keys and the indexes.
- A request and a request workflow get a nano ID when the caller gives none
  (`WithStringId`). A request has `createdAt` and `updatedAt`, and `save()` updates `updatedAt`.
- An activity entry and a comment get an auto-increment ID and `createdAt`. `typeVersion` takes
  the database default `1`. `data` and `history` are JSON. The `updatedAt` and `deletedAt` of a
  comment are plain dates that the code sets.

### Tests

- `packages/cli/test/integration/database/repositories/workflow-review.repositories.test.ts` (fork
  test) runs each ordinary review repository on the fork entities.
- The ordinary migration test of the activity tables and the ordinary integration test of
  `WorkflowHistoryRepository` save and read rows through these entities.
- The ordinary unit tests of the review repositories in `../repositories/__tests__` use the fork
  entities.

### Clean-room record

Early in step 4, one search without the exclusion globs printed one decorator line of two of the
replaced enterprise files: `@PrimaryColumn({ type: 'uuid' })` of the reviewer and author entities.
The fork reported it in pull request 35. These entities take the type of `userId` from the
migration (`column('userId').uuid.notNull.primary`).

## The execution annotation tables

The fork replaced the three entities of execution annotations in step 4 with its own entities,
with the same names and exports: `annotation-tag-entity.ts`, `annotation-tag-mapping.ts` and
`execution-annotation.ts`. Their repositories are `annotation-tag.repository.ts` and
`annotation-tag-mapping.repository.ts`.
[packages/cli/src/executions/FORK.md](../../../../cli/src/executions/FORK.md#execution-annotations)
describes them with the rest of the feature.

## The agent eval tables

Agent evals test an agent against the cases of a dataset. The ordinary module
`packages/cli/src/modules/agent-evals` runs them, and it is the only user of these tables. The
fork replaced the four entities and their repositories in step 4 with its own files, with the
same names and exports. They are part of the evaluations that the owner chose to rebuild on
2026-10-12.

| Fork file | Table | Enterprise file that it replaces |
| --- | --- | --- |
| `agent-eval-dataset.ts` | `agent_eval_dataset` | `agent-eval-dataset.ee.ts` |
| `agent-eval-run.ts` | `agent_eval_run` | `agent-eval-run.ee.ts` |
| `agent-eval-result.ts` | `agent_eval_result` | `agent-eval-result.ee.ts` |
| `agent-eval-rating.ts` | `agent_eval_rating` | `agent-eval-rating.ee.ts` |
| `../repositories/agent-eval-dataset.repository.ts` | | `agent-eval-dataset.repository.ee.ts` |
| `../repositories/agent-eval-run.repository.ts` | | `agent-eval-run.repository.ee.ts` |
| `../repositories/agent-eval-result.repository.ts` | | `agent-eval-result.repository.ee.ts` |
| `../repositories/agent-eval-rating.repository.ts` | | `agent-eval-rating.repository.ee.ts` |

The entity files also export the types `AgentEvalColumnMapping`, `AgentEvalRunStatus`,
`AgentEvalResultStatus` and `AgentEvalVote`, as the enterprise files did. They are the types of
`@n8n/api-types`.

### Sources

- The columns, their types, their defaults and their foreign keys: the ordinary migration
  `CreateAgentEvalTables1784815940112`.
- The methods of the repositories, their arguments and their queries: the ordinary unit tests of
  the four repositories in `../repositories/__tests__`, the ordinary module `agent-evals` and its
  unit and integration tests, and the record types in `@n8n/api-types`
  (`schemas/agent-evals.schema.ts`).
- The behaviour of the original files, recorded black-box by the golden test below. The
  enterprise files were not read.

### Behaviour

- Each entity has a nano ID, `createdAt` and `updatedAt`. JSON columns use `JsonColumn`, dates use
  `DateTimeColumn`.
- A run has a relation `dataset`, so that a query can check the agent of its dataset. A result has
  a relation `run`, and a rating has a relation `result`. The database deletes the runs of a
  deleted dataset, the results of a deleted run and the ratings of a deleted result.
- A dataset has no relation to its agent: the table of agents belongs to the agents module of the
  CLI. `agentId` is a column with a foreign key in the migration.
- `createDataset`, `createRun`, `seedResults` and `createRating` set the optional fields to `null`.
  A new run has the status `new`, and a seeded result has the status `new` and the position in the
  list as `runIndex` when the caller gives none.
- `updateDataset` writes only the fields that the patch gives (`null` clears a field), and gives
  the dataset after the update, or `null` when the agent has no such dataset.
- The state changes of a run and a result set the status and the time stamps. A finished run has
  no `runningInstanceId`. `markAllIncompleteAsError` gives the runs with the status `new` or
  `running` the status `error` with the code `interrupted`.
- The lists give the newest first, a page of runs breaks ties of `createdAt` with the ID, and the
  results of a run are in the order of `runIndex`. `countByStatus` counts in the database and gives
  a count for each status. `findLatestByRunId` gives the newest rating of each rated result of a
  run, with two queries.

### Tests

- `packages/cli/test/integration/database/repositories/agent-eval.repositories.test.ts` (fork test)
  calls each method as the module `agent-evals` does, and records the result and the changes to the
  rows of the four tables. The snapshot was recorded against the enterprise files, and the fork
  files give the same snapshot.
- The ordinary unit tests of the four repositories, and the ordinary unit and integration tests of
  the module `agent-evals`, run on the fork files.

To record the snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`. Copy the golden test and its snapshot into the same folder there, and
run the test with `-u`. The upstream index files export the enterprise files.

### Clean-room record

While the fork prepared these files, a scratchpad probe passed recording proxies as arguments to
the methods of the enterprise `TestRunRepository` and `TestCaseExecutionRepository` (the
evaluation tables, not the agent eval tables). The recorder printed each call argument as text, so
its log showed the source of two short callbacks (one line each) in two methods of
`test-case-execution.repository.ee.ts`, and the empty headers of two compiled entity classes with
the names of their base classes. The probe, its log and the recorder were deleted, and the fork
does not use recording proxies any more. The fork rebuilds those two repositories with the
evaluation backend, from the ordinary code and from black-box tests of the REST API.

## The evaluation tables

These tables keep the test runs of evaluations, their cases, the evaluation configs and the
collections. The fork backend in `packages/cli/src/evaluation` uses them, see
[its FORK.md](../../../../cli/src/evaluation/FORK.md). The fork replaced the four entities and
two repositories in step 4 with its own files, with the same names and exports. The
repositories of configs and collections are ordinary code and stay.

| Fork file | Table | Enterprise file that it replaces |
| --- | --- | --- |
| `test-run.ts` | `test_run` | `test-run.ee.ts` |
| `test-case-execution.ts` | `test_case_execution` | `test-case-execution.ee.ts` |
| `evaluation-config.ts` | `evaluation_config` | `evaluation-config.ee.ts` |
| `evaluation-collection.ts` | `evaluation_collection` | `evaluation-collection.ee.ts` |
| `../repositories/test-run.repository.ts` | | `test-run.repository.ee.ts` |
| `../repositories/test-case-execution.repository.ts` | | `test-case-execution.repository.ee.ts` |

`test-run.ts` and `test-case-execution.ts` also export the types `TestRunStatus` and
`TestCaseExecutionStatus`: the status types of `@n8n/api-types`. `test-run.repository.ts`
exports the type `TestRunSummary`.

### Sources

- The columns, their types, their defaults, their foreign keys and their indexes: the ordinary
  migrations of the four tables.
- The mapping of the entities (the columns, the relations and the indexes that TypeORM builds at
  run time), recorded black-box from the original entities.
- The methods of the repositories: the ordinary callers (the public API controller, the ordinary
  repositories of configs and collections, `license-metrics.repository.ts`), the ordinary tests,
  the test helpers in `cli/test/integration/shared/db/evaluation.ts`, and the golden tests of the
  backend.

### Behaviour

- A test run has a nano ID, `createdAt` and `updatedAt`, a relation `workflow` and a relation
  `testCaseExecutions`. `finalResult` is not a column: the summary queries set it.
- A test case has a nano ID and a relation `testRun`. The table has `createdAt` and `updatedAt`
  with database defaults, but the entity does not map them, as in the original. `executionId` is
  text in the entity and an integer in the table.
- A config and a collection have a string ID that the service gives, `createdAt` and
  `updatedAt`. A config has a relation `workflow` and is unique for its workflow and name.
- `TestRunRepository` writes the states of a run: `createTestRun` (status `new`), `markAsRunning`
  with the ID of the main instance, `markAsCompleted` with the metrics, `markAsError` with a code,
  `markAsCancelled`, and `markAllIncompleteAsFailed` (the runs with the status `new` or `running`
  become `error` with the code `INTERRUPTED`). It also keeps the flag of a cancellation. The lists
  give the newest first, with the number of cases and the final result of each run. The final
  result is the most severe status of the cases of a completed run.
- `TestCaseExecutionRepository` writes the pending cases of a run in one call, marks a pending
  case as running only once, keeps the result or the error of a case, and cancels the pending
  cases of a run. The cases of a run are in the order of the dataset (`runIndex`).

### Tests

- `packages/cli/test/integration/evaluation/evaluation-entities.golden.test.ts` (fork test)
  records the mapping of the four entities. The snapshot was recorded against the enterprise
  entities, and the fork entities give the same snapshot.
- The golden tests of the backend in the same folder record the rows of the four tables after
  each call and each run.
- The ordinary tests of the repositories of configs and collections, the ordinary tests of the
  REST API and the public API, and the migration test of the scaling fields run on the fork
  files.

### Clean-room record

The slip with the recording proxies on the enterprise repositories of these tables is described
in the section of the agent eval tables. The fork repositories come from the sources above.

## The project pool settings table

The table `project_pool_settings` keeps the worker pool of each project. The fork deleted its
enterprise entity and repository with the worker pools in step 4. It rebuilt them with the worker
pools (4 of 6 in
[FORK-FEATURES.md](../../../../../FORK-FEATURES.md#parity-with-the-enterprise-edition)), with the
same names and exports:

| Fork file | Table | Enterprise file that it replaces |
| --- | --- | --- |
| `project-pool-settings.ts` | `project_pool_settings` | `project-pool-settings.ee.ts` |
| `../repositories/project-pool-settings.repository.ts` | | `project-pool-settings.repository.ee.ts` |

- The columns come from the ordinary migration `CreateProjectPoolSettings1788445119183`: the
  project ID (the primary key), the pool (`defaultPool`, `null` for the default queue),
  `createdAt` and `updatedAt`. The foreign key deletes the row of a deleted project.
- `getDefaultPool` gives the pool of a project, or `null`. `setDefaultPool` inserts or updates the
  row of a project.
- `PoolConfigService` of the scaling code uses the repository.
  [packages/cli/src/scaling/FORK.md](../../../../cli/src/scaling/FORK.md) describes the worker
  pools. The golden test `packages/cli/test/integration/worker-pools/worker-pools.golden.test.ts`
  records the rows of the table.

## Upstream updates

`scripts/sync-upstream.sh` deletes the replaced enterprise files again. When an upstream migration
changes one of these tables, change the fork entity, and run the integration tests of the tables.
