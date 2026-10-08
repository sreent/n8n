# The fork's sharing UI

Fork document (not in upstream n8n). Read it with [FORK.md](../../../FORK.md) and
[packages/cli/src/workflows/FORK.md](../../cli/src/workflows/FORK.md).

Five fork modules hold the sharing UI of the editor. They replace these enterprise files for all
ordinary code. This is the fourth pull request of step 3.

| Fork module (in `src/`)                                               | Enterprise file that it replaces             |
| --------------------------------------------------------------------- | -------------------------------------------- |
| `app/api/workflowSharing.ts`                                          | `app/api/workflows.ee.ts`                    |
| `features/credentials/credentialSharing.api.ts`                       | `features/credentials/credentials.ee.api.ts` |
| `app/stores/workflowSharing.store.ts`                                 | `app/stores/workflows.ee.store.ts`           |
| `features/workflows/components/WorkflowShareModal.vue`                | `WorkflowShareModal.ee.vue` in that folder   |
| `features/credentials/components/CredentialEdit/CredentialSharing.vue` | `CredentialSharing.ee.vue` in that folder    |

The exports keep their names. The store keeps its id (`STORES.WORKFLOWS_EE`) and the name
`useWorkflowsEEStore`. Thus the callers change only their import.

## Behaviour

### API helpers

- `setWorkflowSharedWith(context, id, data)` sends `PUT /workflows/:id/share` with `data`
  (`{ shareWithIds }`).
- `moveWorkflowToProject(context, id, body)` sends `PUT /workflows/:id/transfer` with `body`.
- `moveFolderToProject(context, projectId, folderId, destinationProjectId,
  destinationParentFolderId?, shareCredentials?)` sends
  `PUT /projects/:projectId/folders/:folderId/transfer`. Without a parent folder, the folder goes
  to the root of the project (`PROJECT_ROOT`).
- `setCredentialSharedWith(context, id, data)` sends `PUT /credentials/:id/share` with `data`.
- `moveCredentialToProject(context, id, destinationProjectId)` sends
  `PUT /credentials/:id/transfer` with `{ destinationProjectId }`.

Each helper gives the `data` of the response. An error goes to the caller.

### The `workflowsEE` store

- `getWorkflowOwnerName(workflowId, fallback?)` reads the workflow from the workflow list. It gives
  `Name (email)` for a home project with a name and an email. It gives the name or the email
  alone when the project has only one of them. Else it gives the fallback ("the owner").
- `setWorkflowSharedWith({ workflowId, sharedWithProjects })` sets the shares in the editor
  document of the workflow and in the workflow list.
- `saveWorkflowSharedWith(payload)` saves the ids of the projects, then sets the shares.

### The workflow share modal

The modal reads the workflow from two places: the workflow list, and the editor document of the
workflow. The owner project and the scopes come from the list first, then from the document. The
scopes of the list apply also when they are empty. The shares come from the document first, then
from the list. The select starts with these shares. A later load does not change the select.

Without the sharing licence, the modal tells that sharing needs a better plan. Its button opens
the upgrade page (`workflow_sharing`, `upgrade-workflow-sharing`). Cloud has other texts.

With the licence:

1. The first load. When the workflow list has the workflow, the modal loads the workflow again
   (`GET /workflows/:id`). Then, for a team project, the modal loads the project
   (`GET /projects/:id`) to count its members. The count is 0 until then.
2. Save is disabled and busy while the first load runs. When the load fails, the error goes to
   the error handler of Vue, and Save stays disabled and busy.
3. The title is "Shared with {project}" for a team project. Else it is "Sharing".
4. A user without `workflow:share` sees who can change the shares: the owner, from
   `getWorkflowOwnerName`. In the personal project of the user, the select is off, and its
   tooltip tells why.
5. The select offers only personal projects, and not the owner project. The role is "Editor".
   The select is read-only without `workflow:share`. It is static without `workflow:share` and for
   a team project.
6. A team project shows the number of members and a Close button. It has no Save button.
7. A change shows "You made changes" and turns on Save.
8. Save. A workflow that the workflow list does not have is new. For a new workflow, the editor
   first saves its workflow (`saveCurrentWorkflow({ id })`). When that fails, its toast shows,
   then the sharing error toast. After that save, the shares go to the workflow that the editor
   shows. Then the shares are saved. The toast "Sharing updated" shows, the hint goes, and the
   modal closes. When the save fails, an error toast shows, and the modal stays open.
9. A save waits for the first load. When the load failed, the save fails with the error of the
   load, and no toast shows. A click on Save while the modal loads or saves does nothing.
10. Close. With changes, a dialog asks to save first. "Save" saves, and the modal stays open when
    the save fails. "Close without saving" and a closed dialog close the modal.

### The sharing tab of the credential modal

Without the sharing licence, the tab tells that sharing needs a better plan. Its button opens the
upgrade page (`credential_sharing`, `upgrade-credentials-sharing`).

With the licence:

1. An info text. A user who may share, and a user in their own personal project, see the text for
   the owner. Other users see the text for a team project, or the name of the personal owner.
2. The select offers all projects except the owner project. The role is "User". The select is
   read-only and static without `credential:share`. Its placeholder is "Share with users or
   projects..." when the projects store lists team projects, else "Share with user(s)". "Share
   with all users" follows the global scope `credential:shareGlobally` of the user, not the scopes
   of the credential.
3. The tab emits `update:modelValue` with the projects, and `update:shareWithAllUsers`.

With credential sharing (`N8N_ENV_FEAT_CRED_SHARING`):

1. The role is "Can use", with a description. A removal asks first.
2. A user who may share sees each of their projects that has workflows that use the credential,
   but no share: "Used in {workflow}" or "Used in {count} workflows", and "Only you" or
   "Only {first name of the owner}". "Share" adds the project.
3. The tab loads the workflows when it opens (`POST /workflow-dependencies/details`), also without
   the licence and for a new credential. It keeps the last result for each credential until the
   page loads again. It shows that result at once, and keeps it when a request fails.

## Clean-room sources

- The ordinary code that uses the five modules: `Modals.vue`, `CredentialEdit.vue`,
  `WorkflowSettings.vue`, and the projects, folders and credentials stores.
- The ordinary code that the modules use, for example `ProjectSharing.vue`,
  `ProjectSharingInfo.vue`, `Modal.vue`, the workflow document store, `useWorkflowSaving`,
  `getResourceDependencies`, and the texts of `@n8n/i18n`.
- The public n8n documentation of workflow and credential sharing.
- The behaviour of the original files, recorded black-box by the golden test (below).
- The pass and fail counts of the enterprise component tests, run on the fork modules, also for
  each test file.

The enterprise files and their tests were not read, with two exceptions that the repository owner
approved: the names and the numbers of arguments of the exports of the original API helpers, and
the titles (not the bodies or failure messages) of the 9 enterprise component tests that failed on
a first version of the fork modules. The titles named the save of a new workflow before its
shares, a failed save of a new workflow, the save after the first load when the modal closes, the
"Can use" role, and the projects that use a credential.

Later checks of the enterprise component tests printed only the counts, and for each of the 9
known titles whether it failed. The output of the test runs with the original files was filtered
to error names and to stack frames of ordinary files.

There were two slips. One search without the enterprise exclusions printed one import line of
`workflows.ee.ts` (`import type { IDataObject } from 'n8n-workflow';`). A temporary log in the
ordinary `useWorkflowSaving.ts` printed the call stack of a save, in a test run with the original
files. The log is gone.

## The golden test

`src/features/workflows/components/__tests__/sharing-ui.golden.test.ts` renders the modal and the
tab with real stores. A fake server answers the requests. Stubs record the modal frame, the
toasts, the dialogs and the telemetry. The fixture has an owner, an admin and members, personal
and team projects, built-in and custom roles, and workflows in the editor, in the list and new. It
has credentials of each kind. It covers the licence states, cloud, and credential sharing.

- The API test calls each helper, and an error of the server.
- The store test calls the store for each user, place and workflow.
- The modal test (59 cases) and the credential test (114 cases) open the UI and act as a user. They
  search, add and remove projects, save, close, and click the buttons. Some cases make requests
  wait or fail.

Each step records what a user sees (the texts, the test ids, and the controls with their state),
the props of the modal frame and of `ProjectSharing`, the requests, the toasts, the dialogs, the
telemetry, the events and the store state. The first step of a case is complete. The later steps
record only what changed.

The snapshot was recorded against the original files. The fork modules give the same snapshot. To
record it again after an upstream update, point the five imports at the top of the test at the
enterprise files (`WorkflowShareModal.ee.vue`, `CredentialSharing.ee.vue`,
`@/app/api/workflows.ee`, `@/features/credentials/credentials.ee.api` and
`@/app/stores/workflows.ee.store`). Run the test with `-u`, then point the imports back.

## The enterprise component tests

The enterprise component tests pass 18 of 26 on the fork modules (26 of 26 on the original files).
7 of the 9 known titles fail: the 3 tests of the modal and the 4 tests of the projects that use a
credential. One more test of the modal fails. The golden test shows the same behaviour as the
original files for all its cases, also for what these titles name. The failing tests probably
make states that the golden test does not make, for example with stubbed stores. The fork did
not read them, so this is not known.

## What stays

- The five enterprise files and their tests stay, unused by ordinary code. They go with the
  enterprise code.
