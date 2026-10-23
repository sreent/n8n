# The fork's executions service and execution annotations

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md) and
[packages/cli/src/workflows/FORK.md](../workflows/FORK.md).

This document has two parts: the executions service (step 3 of FORK.md) and
[the execution annotations](#execution-annotations) (step 4).

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
snapshot. The fork no longer has the original file. To record the snapshot again after an upstream
update, record it in a checkout of upstream n8n, as FORK.md tells ("Upstream updates"), with the
service import of the test at `@/executions/execution.service.ee`.

## Removed enterprise files

- The fork deleted `execution.service.ee.ts` in step 4.

## Execution annotations

An execution annotation is a vote (`up` or `down`) and a list of tags on one execution. The list of
executions can filter by them. The execution preview shows them, and also the highlighted data of
the execution (the custom data that the Execution Data node saves). The owner chose on 2026-10-12
to rebuild them. The fork files replace the enterprise files with the same names and exports, so
that ordinary code changes only its import lines:

| Package | Fork file | Enterprise file that it replaces |
| --- | --- | --- |
| `@n8n/db` | `entities/annotation-tag-entity.ts` | `annotation-tag-entity.ee.ts` |
| `@n8n/db` | `entities/annotation-tag-mapping.ts` | `annotation-tag-mapping.ee.ts` |
| `@n8n/db` | `entities/execution-annotation.ts` | `execution-annotation.ee.ts` |
| `@n8n/db` | `repositories/annotation-tag.repository.ts` | `annotation-tag.repository.ee.ts` |
| `@n8n/db` | `repositories/annotation-tag-mapping.repository.ts` | `annotation-tag-mapping.repository.ee.ts` |
| `cli` | `services/annotation-tag.service.ts` | `annotation-tag.service.ee.ts` |
| `cli` | `controllers/annotation-tags.controller.ts` | `annotation-tags.controller.ee.ts` |
| editor | `features/shared/tags/components/AnnotationTagsDropdown.vue` | `AnnotationTagsDropdown.ee.vue` |
| editor | `features/shared/tags/components/TagsManager/AnnotationTagsManager.vue` | `AnnotationTagsManager.ee.vue` |
| editor | `features/execution/executions/components/workflow/WorkflowExecutionAnnotationTags.vue` | `WorkflowExecutionAnnotationTags.ee.vue` |
| editor | `features/execution/executions/components/workflow/WorkflowExecutionAnnotationPanel.vue` | `WorkflowExecutionAnnotationPanel.ee.vue` |

The fork removed the enterprise files and their two enterprise editor tests
(`AnnotationTagsDropdown.ee.test.ts` and `WorkflowExecutionAnnotationTags.ee.test.ts`).
`scripts/removed-enterprise-paths.txt` lists them.

### Behaviour of the backend

- The tables come from the ordinary migrations `CreateAnnotationTables1724753530828` and
  `AddMissingPrimaryKeyOnAnnotationTagMapping1728659839644`: `annotation_tag_entity`,
  `execution_annotations` and `execution_annotation_tags`.
- A tag has a nano ID, a unique name of 1 to 24 characters, and timestamps. An execution has one
  annotation or none. The database deletes the annotation with its execution, and the tag links
  with their tag.
- `AnnotationTagMappingRepository.overwriteTags(annotationId, tagIds)` replaces the tags of an
  annotation in one transaction. When an insert fails (a tag that does not exist, or the same tag
  two times), the tags do not change.
- `AnnotationTagRepository.findAllWithUsageCount()` gives all tags, each with `usageCount`: the
  number of annotations with the tag.
- The REST API `/rest/annotation-tags` has four routes. The owner, the admins and the members have
  their scopes.

  | Route | Scope | Result |
  | --- | --- | --- |
  | `GET /` | `annotationTag:list` | All tags. With `withUsageCount=true`, each tag also has `usageCount`. |
  | `POST /` | `annotationTag:create` | The new tag. |
  | `PATCH /:id` | `annotationTag:update` | The tag with the new name. |
  | `DELETE /:id` | `annotationTag:delete` | `true`. |

- The service trims the name. A name that is empty or longer than 24 characters gives the status
  400 and "Tag name must be 1 to 24 characters long.". A name that another tag has gives the
  status 500 and "There is already an entry with this name". A missing name, or a name that is not
  a string, gives the status 500.
- `PATCH` with an ID that does not exist makes a tag with that ID. `DELETE` with an ID that does
  not exist gives `true`. The original did the same.
- The routes have no licence check, as in the original. The ordinary code checks the licence
  feature `feat:advancedExecutionFilters` (Advanced execution filters): the list of executions
  ignores the annotation filters without it.
- Ordinary code sets the vote and the tags of an execution: `PATCH /rest/executions/:id` and the
  public API `/executions/{executionId}/tags` call `ExecutionService`, which uses the fork
  repositories.

### Behaviour of the editor

- `AnnotationTagsDropdown` wraps `TagsDropdown` as `WorkflowTagsDropdown` does, with the
  annotation tags store. A user can create a tag when the `createEnabled` prop is set and the user
  has the `annotationTag:create` scope. "Manage tags" needs the manage permission of
  `useAnnotationTagPermissions`, and opens the modal of the annotation tags manager.
- `AnnotationTagsManager` wraps `TagsManager` as `WorkflowTagsManager` does, with the annotation
  tags store, the texts of the annotation tags and the same toasts.
- `WorkflowExecutionAnnotationTags` shows the tags of an execution and an add button. A click opens
  the dropdown. A blur saves a changed selection with `executionsStore.annotateExecution`. Escape
  cancels. When the save fails, a toast shows the text of `executionAnnotationView.tag.error`.
- `WorkflowExecutionAnnotationPanel` is a button with the number of items of highlighted data. The
  user must have the `workflow:update` scope on the workflow. The dropdown of the button shows the
  key and the value of each item, or a note when there are no items.
- The ordinary preview and the ordinary filter show these components only with the licence
  feature `feat:advancedExecutionFilters`. The fork keeps these checks until step 5.

### Differences from the original

The enterprise files were not read, so the fork cannot know all internal details. The golden tests
below give the same snapshots. Known points:

- The fork service sends no events. The event maps of the ordinary code have no events of
  annotation tags.
- The controller reads the raw request body, as the recorded API does: it has no DTO validation
  before the service.
- When a save of the tags fails, the original passes the i18n key
  `executionAnnotationView.tag.error` as the title of the toast, so the toast shows the key. The
  fork shows the text of the key (2026-10-23, a uniformity fix). The golden test of
  `WorkflowExecutionAnnotationTags` records the text, and a comment marks the change.

### Clean-room sources

- The ordinary migrations above, the ordinary repositories and services that use the entities
  (`ExecutionService`, `ExecutionRepository`, `ExecutionAnnotationRepository`), the test helper
  `annotateExecution`, the request types `AnnotationTagsRequest` in `requests.ts`, the
  `annotationTag:*` scopes of the permission data, and the endpoint group `annotationTags` of the
  test server.
- The editor: the annotation tags store and its REST client, `useAnnotationTagPermissions`,
  `WorkflowTagsDropdown`, `WorkflowTagsManager`, `TagsDropdown`, `TagsManager`,
  `WorkflowExecutionsPreview.vue`, `ExecutionsFilter.vue` and the i18n texts.
- The behaviour of the original code, recorded black-box by the golden tests below. The fork
  probed the original with stubbed stores to find which scopes the panel button needs.

### The golden tests

- `packages/cli/test/integration/annotation-tags.api.test.ts` calls each route as the owner and as
  a member, with and without the licence feature: names that are valid and not valid, duplicate
  names, IDs that do not exist, usage counts and deleted tags. It also sets, replaces and empties
  the tags of an execution through `ExecutionService`, with tags that do not exist, the same tag
  two times, and a workflow that the user cannot see. IDs and dates become placeholders. The
  snapshot of a failed insert has the error text of SQLite.
- `packages/frontend/editor-ui/src/features/shared/tags/components/__tests__/annotation-tags.golden.test.ts`
  renders the dropdown and the manager with stubs of `TagsDropdown` and `TagsManager`. It records
  the props that the stubs get, the store calls, the modals, the toasts and the events, with and
  without the scopes.
- `packages/frontend/editor-ui/src/features/execution/executions/components/workflow/__tests__/execution-annotation.golden.test.ts`
  renders the tags and the panel of an execution with a stub of `TagsDropdown`. It records the
  HTML, the store calls and the toasts: no tags, some tags, a changed and an unchanged selection,
  escape, a failed save, no data, some data, and the button with and without the
  `workflow:update` scope.

The snapshots were recorded against the enterprise files, and the fork files give the same
snapshots. The fork no longer has the enterprise files. To record a snapshot again after an
upstream update:

1. Make a checkout of the upstream commit in `scripts/sync-upstream.base`, outside this
   repository, and build it.
2. Copy the test and its snapshot into the same folder of the checkout. In an editor test, point
   the imports of the modules under test at the `.ee.vue` files. The backend test needs no change:
   the upstream test server loads the enterprise controller.
3. Run the test there with `-u`. Copy the snapshot back, and compare it with the old snapshot.
