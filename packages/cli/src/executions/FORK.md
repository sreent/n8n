# The fork's executions service

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md) and
[packages/cli/src/workflows/FORK.md](../workflows/FORK.md).

`enterprise-execution.service.ts` holds `EnterpriseExecutionsService`. It replaces the enterprise
`execution.service.ee.ts` for all ordinary code. The class name stays, so that the executions
controller changes only its import.

## Behaviour

With the sharing licence, `GET /executions/:id` gets the execution from
`EnterpriseExecutionsService.findOne(req, workflowIds)`. Without the licence, it gets it from
`ExecutionService.findOne`. The controller makes this choice.

`findOne` does these steps:

1. It gets the execution from `ExecutionService.findOne` with the same arguments. When that gives
   nothing, `findOne` gives nothing. An error of that call goes to the caller.
2. It reads the workflow of the execution from the database, as the workflow is now. When the
   workflow is gone, `findOne` gives nothing.
3. It adds three fields to the workflow data of the execution. The other fields stay as the run
   kept them, also for an engine v2 execution.
   - `homeProject`: `null`. The service reads the workflow without its shares.
   - `sharedWithProjects`: an empty list, for the same reason.
   - `usedCredentials`: the credentials that the workflow uses now, not as it ran, from
     `EnterpriseWorkflowService.addCredentialsToWorkflow`. `currentUserCanUse` is for the user of
     the request. A credential that is gone is not in the list. A credential that more than one
     node uses is in the list once.

The licence does not change what `findOne` does.

## Clean-room sources

- The ordinary code that calls the service: `executions.controller.ts`.
- The ordinary code next to it: `ExecutionService.findOne`, the execution types of `@n8n/db`
  (`IExecutionResponse.workflowData` can be a `WorkflowWithSharingsAndCredentials`),
  `OwnershipService.addOwnedByAndSharedWith`, the fork's `EnterpriseWorkflowService`, and the
  ordinary integration tests of the executions controller.
- The behaviour of the original service, recorded black-box by
  `__tests__/enterprise-executions.integration.test.ts` (below). The same test also ran with
  `ExecutionService` in place of the service under test, to show what the service adds.

The enterprise file was not read. There is no enterprise test of this service. There was one
slip: a search without the enterprise exclusions printed 9 lines of
`workflows/workflow.service.ee.ts`, a file that the fork replaced in step 3 (method names and
lines that set or read `usedCredentials`). The fork service does not use them.

## The golden test

`__tests__/enterprise-executions.integration.test.ts` calls `findOne` on a real database. The
fixture has users with built-in and custom global roles, and team and personal projects with
built-in and custom project roles. Its workflows are owned, shared with a user and with projects,
archived, changed after their run, and with a credential that is gone. Its executions succeeded,
failed, wait, are too large to show, or are deleted. There are also an engine v2 execution, ids
that do not exist, and an engine v2 execution of a workflow that is gone.

The test reads each execution as each user, with and without the sharing licence, and with the
redaction query: about 230 calls. For each call, the snapshot records the workflows that the user
may read, the result (with the run data parsed) or the error, and the rows that the calls changed
(none). Ids become labels and dates become placeholders.

The snapshot was recorded against the original service. The fork service gives the same
snapshot. To record it again after an upstream update, point the service import of the test at
`@/executions/execution.service.ee`, run the test with `-u`, and point the import back.

## What stays

- `execution.service.ee.ts` stays, unused by ordinary code. It goes with the enterprise code.
