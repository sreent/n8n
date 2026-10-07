# The fork's sharing services

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md),
[packages/cli/src/permissions/FORK.md](../permissions/FORK.md) and
[packages/cli/src/services/FORK.md](../services/FORK.md).

Two fork services share, check and move workflows and credentials. They replace the enterprise
`workflow.service.ee.ts` and `credentials.service.ee.ts` for all ordinary code. This is the third
pull request of step 3.

- `enterprise-workflow.service.ts` holds `EnterpriseWorkflowService`.
- `../credentials/enterprise-credentials.service.ts` holds `EnterpriseCredentialsService`.
- `SharingRepository` (`packages/@n8n/db/src/repositories/sharing.repository.ts`) holds the queries
  that need operators or a transaction.

The class names stay, so that the callers change only their import.

## Behaviour

### Credential references

A node references a credential in three places. The checks below cover all of them.

1. `node.credentials`. A reference by name only (no `id`) gives nothing. A Gateway credential
   (`id: null` with `__aiGatewayManaged: true`) gives nothing, because n8n manages it. Another
   `null` or `''` id is a reference that n8n cannot check.
2. The inline agent of a node (`parameters.inlineAgent`, an object or a JSON string), on any node
   type: `config.credential` and the `credentials` of each `config.tools[].node`. Only a non-empty
   string is a reference. Other values give nothing.
3. The inline sub-workflow (`parameters.workflowJson`, a JSON string) of an Execute Workflow,
   Workflow Tool or Workflow Retriever node. Its nodes give their references by these three rules,
   also for a sub-workflow in a sub-workflow.

- `collectCredentialReferences(workflow)` gives the ids, and `hasUnresolved` when a reference has
  no id that n8n can check.
- `validateCredentialPermissionsToUser(workflow, allowedIds)` throws a `UserError` when a reference
  is unresolved or outside `allowedIds`.
- The lists of used credentials and `getWorkflowIdsWithResolvableCredentials` read only
  `node.credentials`.

### Workflows

- `shareWithProjects(workflowId, projectIds, entityManager)` shares the workflow as editor with the
  personal projects in the list, in the transaction of the caller. Team projects, the owner project
  and existing shares get nothing.
- `addOwnerAndSharings(workflow)` adds `homeProject`, `sharedWithProjects` and an empty
  `usedCredentials` list.
- `addCredentialsToWorkflow(workflow, user)` and `getFolderUsedCredentials(user, folderId,
  projectId)` describe the credentials that the workflows use. `currentUserCanUse` is true for a
  credential that the user can use in the workflow or project. With credential sharing
  (`N8N_ENV_FEAT_CRED_SHARING`), it is true for each credential that the user can read. The folder
  version reads the workflows in the folder and its subfolders that the user can read. A folder
  outside the project gives `FolderNotFoundError`.
- `getWorkflowIdsWithResolvableCredentials(workflowIds)` gives the workflows that use an end-user
  credential.
- `preventTampering(workflow, workflowId, user)` checks the nodes of an update before n8n saves it:
  1. A missing workflow gives `NotFoundError`. An update without nodes stays as it is.
  2. A `null` credential in `node.credentials` gives a `BadRequestError`.
  3. A node whose references the user can all use in the workflow stays as it is.
  4. A stored node with a reference that the user cannot use is read-only. When exactly one node of
     the update has its id, that node gets the stored version back, with the new `name`,
     `position` and `disabled` flag.
  5. Another node with such a reference gives a `BadRequestError` that names the node.
- `transferWorkflow(user, workflowId, projectId, shareCredentials?, parentFolderId?)`:
  1. The user needs `workflow:move` on the workflow and `workflow:create` in the destination
     project, else `NotFoundError`.
  2. A destination folder outside the project gives `TransferWorkflowError`. The same project and
     folder give `TransferWorkflowError`.
  3. The transfer policy of the destination project must allow the workflow.
  4. The destination project becomes the owner, and all other shares go. The workflow goes into
     the folder, or into the root of the project. The credentials in `shareCredentials` that the
     user may share (`credential:share`) get a `credential:user` share with the project.
  5. An active workflow stops before the transfer and starts again after it. When the start fails,
     the workflow stays inactive and the publish history records the deactivation by the user. A
     `WorkflowActivationError` is the result (`{ error }`). Another error goes to the caller.
- `transferFolder(user, sourceProjectId, folderId, projectId, parentFolderId, shareCredentials?)`
  moves the folder, its subfolders and their workflows (archived ones too). The user needs
  `workflow:create` in the destination project. A folder outside its project gives the
  `EntityNotFoundError` of the database layer, as in the original. A workflow that the destination
  project owns already gives `TransferWorkflowError`. The shares, the credentials and the active
  workflows work as for one workflow, but an activation error does not stop the transfer and gives
  no result.

### Credentials

- `shareWithProjects(user, credentialId, projectIds, entityManager)` shares the credential as user,
  in the transaction of the caller. Personal projects always get the share. A team project gets it
  only when the user may list it (`project:list`). An instance credential or a missing credential
  gives `NotFoundError`.
- `getOneForUser(user, credentialId, includeDecryptedData)` gives the credential with its home
  project, its shares and its connection status. The decrypted data is there when the user may also
  update the credential. The data has a flag in place of the OAuth token: for an end-user
  credential, the flag shows the connection of the user. A credential that the user cannot see
  gives `NotFoundError`.
- `transferOne(user, credentialId, projectId)` moves the credential to the project. The user needs
  `credential:move` on the credential and `credential:create` in the project, else `NotFoundError`.
  The same project gives `TransferCredentialError`. An end-user credential needs a project that
  allows it, and a user who may manage it there.

## Clean-room sources

- The ordinary code that calls the services: the workflow and credential controllers, the folder
  controller, the public API, `workflow.service.ts`, `workflow-creation.service.ts` and the n8n
  Assistant adapter.
- The ordinary tests of that code, and the ordinary helpers that the services use, for example
  `CredentialsFinderService`, `CredentialsService.getCredentialsAUserCanUseInAWorkflow`,
  `ProjectService.getProjectWithScope`, `OwnershipService` and `FolderRepository`.
- The ordinary sources of the credential references: the test fixtures in
  `test/integration/shared/workflow.ts`, the inline agent schemas of `@n8n/api-types`, and
  `visitWorkflowCredentials` of the n8n packages module.
- The behaviour of the original services, recorded black-box by
  `__tests__/enterprise-sharing.integration.test.ts` (below).
- The pass and fail counts of the enterprise tests, run on the fork services.

The enterprise files and their tests were not read, with one exception: with the approval of the
repository owner, the titles (not the bodies or failure messages) of the 5 enterprise tests that
failed on the fork services were read. They named the credentials of inline agents and inline
sub-workflows, and the result of an activation error. For a time, the fork compared the counts of
the enterprise tests after a change to one rule of the fork services. A count change tells which
inputs the enterprise tests use, so the fork stopped this.

## The golden test

`__tests__/enterprise-sharing.integration.test.ts` calls the services on a real database. The
fixture has users with built-in and custom global roles, team and personal projects with built-in
and custom project roles, owned and shared workflows and credentials, end-user and instance
credentials, folders, active workflows, and workflows with inline agents and inline sub-workflows.
A fake policy backend records the transfer policy calls and denies some projects.

- The reading test calls each reading method and `preventTampering` for each user: about 2,700
  calls. 400 of them are random updates from a fixed seed.
- The changing test seeds the fixture again for each of 148 cases. It covers each changing method,
  the licence states, the activation errors and the order of the checks.

For each call, the snapshot records the result, the error (class chain, message, status code),
the events, the policy calls, the calls to `ActiveWorkflowManager`, and each row that the call adds
to or removes from any table. Ids become labels and dates become placeholders.

The snapshot was recorded against the original services. The fork services give the same
snapshot. To record it again after an upstream update, point the two service imports of the test
at `@/workflows/workflow.service.ee` and `@/credentials/credentials.service.ee`, run the test with
`-u`, and point the imports back.

## What stays

- `workflow.service.ee.ts` and `credentials.service.ee.ts` stay, unused by ordinary code. They go
  with the enterprise code.
- The CLI lint allowlist for `EntityManager` imports from `@n8n/db` lists the two fork services:
  the `entityManager` parameters of `shareWithProjects` keep the type that their callers pass.
  Remove the entries when the transaction becomes an `OperationContext`.
