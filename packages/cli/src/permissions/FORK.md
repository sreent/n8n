# The fork's scope check

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md) and
[packages/@n8n/permissions/FORK.md](../../../@n8n/permissions/FORK.md).

`check-access.ts` holds `userHasScopes`, the check behind every route with a project scope and
many services. It replaces the enterprise `permissions.ee/check-access.ts` for all ordinary code.
This is the first pull request of step 3.

## Behaviour

`userHasScopes(user, scopes, globalOnly, { credentialId, workflowId, dataTableId, projectId }, trx?)`

1. When the global role of the user holds all `scopes`, the answer is yes. An empty `scopes` list
   never passes this step.
2. With `globalOnly`, the answer is no.
3. One id names the resource. When several ids are given (route params can hold several), the
   first of credential, workflow, data table and project counts. Without an id, the check throws
   an `UnexpectedError`, because the route needs a global scope.
4. A missing credential, workflow or data table throws a `NotFoundError`, also for an empty
   `scopes` list. The controller registry turns it into a 404. A missing project gives no.
5. For a project or a data table (through the project of the data table): yes when the role of the
   user in that project holds all `scopes`.
6. For a credential or a workflow: yes when one of its shares has a role that holds all `scopes`,
   and the role of the user in the project of that share holds all `scopes` too.

A global scope and a project scope never add up: a scope set passes only when one role holds all
of it. `trx` reads inside a running transaction.

## Clean-room sources

- The ordinary code that calls the function: 49 imports and 8 test mocks, and the controller
  registries that pass the route params and turn a `NotFoundError` into a 404.
- The ordinary finders that answer the same question for lists, for example
  `buildSingleWorkflowReadWhere` in `workflows/workflow-finder.service.ts`: a global check in
  `allOf` mode, then roles with all scopes in the project and in the share.
- The behaviour of the original function, recorded black-box by
  `__tests__/check-access.integration.test.ts` (below).

The enterprise file and its test were not read.

## The golden test

`__tests__/check-access.integration.test.ts` calls the function on a real database. The users are
an owner, an admin, four members with different project roles, a chat user and two users with
custom global roles. The resources are personal and team projects, owned and shared workflows and
credentials, data tables, missing ids and pairs of ids. Each user and resource gets one row of
answers for 33 scope sets, about 14,500 checks in all. The test also records the errors and the
answers with `globalOnly`, and checks that a transaction gives the same answers.

The snapshot was recorded against the original function, and the fork function gives the same
snapshot. One intended difference: the message of the `UnexpectedError` for a route without an id
has the fork's own words. Only developers see it.

The enterprise unit test `permissions.ee/__tests__/check-access.test.ts` replaces the database with
mocks of the original's repository calls, so it cannot check another implementation. Its counts:
26 of 26 pass against the original, 26 of 26 fail against the fork.

## What stays

- `permissions.ee/check-access.ts` stays, unused by ordinary code: the enterprise evaluation code
  (`evaluation.ee/`) still imports it. It goes with that code.
- The CLI lint allowlist for `EntityManager` imports from `@n8n/db` lists the fork file next to the
  enterprise file. Both entries go when the transaction parameter becomes an `OperationContext`.
