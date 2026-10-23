# The fork's source control editor

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md).

The fork removed the source control backend (Settings > Environments) in step 1, and replaced its
editor with stand-ins in step 4. It rebuilt both on 2026-10-14. The backend is the module
`packages/cli/src/modules/source-control` (see its `README.md`). This folder is the editor. It
replaces the enterprise editor folder `sourceControl.ee`, with the same store ID, exports, texts,
REST calls, modal keys and test IDs.

## Files

| File | What it does |
| --- | --- |
| `sourceControl.store.ts` | The store `sourceControl`: the preferences, the licence flag, the key types, the last commit message and the requests. |
| `sourceControl.api.ts` | The requests of the REST API `/rest/source-control`. |
| `sourceControl.types.ts` | The preferences, the requests and the answers. |
| `sourceControl.utils.ts` | The order of the rows, the folder tree, the dates and the summaries of the toasts. |
| `sourceControl.constants.ts` | The three modal keys. |
| `sourceControl.eventBus.ts` | The event bus. A pull emits `pull`, and ordinary pages load their lists again. |
| `views/SettingsSourceControl.vue` | The page Settings > Environments. |
| `components/SourceControlPushModal.vue` | The modal "Commit and push changes". |
| `components/SourceControlPullModal.vue` | The modal "Pull changes". |
| `components/SourceControlPullResultModal.vue` | The modal "Auto-publish results". |
| `components/SourceControlInitializationErrorMessage.vue` | The message of the start-up toast. |

## Behaviour

- **The settings page.** The route needs the global scope `sourceControl:manage`. Git sync uses the
  same scope. Without the licence feature, the page shows the box "Available on the Enterprise
  plan". The fork switch (step 5 of FORK.md) gives the feature by default. With it, the page loads
  the preferences. A disconnected instance shows the
  connection type (SSH or HTTPS), the repository URL with its check, the SSH key (its type, the
  public key to copy and a button that makes a new key) or the HTTPS user name and personal access
  token, and the button "Connect". A connected instance shows the URL, the button "Disconnect
  Git", the SSH key, the branch (with a button that loads the branches again), the protected
  instance flag, the color and the button "Save settings". A disconnection and a new key ask for a
  confirmation first.
- **The push modal.** It loads the status for a push, and the projects (all projects, or the
  projects of the user without the global scope). It has a tab for workflows, credentials and data
  tables, with the count of the selected rows. Workflows show in their folders. Credentials and
  data tables start selected. Workflows start unselected, except the workflow of the page. A
  search by title, and filters by status, owner and folder, narrow the list. The owner filter
  lists only the projects in which the user has the scope `sourceControl:push`. A notice lists the
  variables, tags, folders and projects of the push, and warns about modified credentials. The
  push sends the selected rows and all variables, tags, folders and projects, with `force`. With
  workflow diffs, a button opens the diff of a workflow.
- **The pull modal.** It loads the status for a pull. It has the same tabs and folders, the mode of
  automatic publishing, the additional changes, the modified credentials notice and the data tables
  with schema changes. The button says "Pull and override" when a workflow is in conflict. After a
  pull, toasts ask to finish the set-up of new variables and credentials, the event bus emits
  `pull`, and the result modal shows the workflows that the pull tried to publish.
- **The result modal.** It has a tab of the workflows that failed to publish (with the error) and a
  tab of the published workflows.
- The route opens the push and pull modals (`?sourceControl=push|pull`, see
  `useWorkflowDiffRouting`). They close with `router.back()`.

## Differences from the original

The golden tests show no difference. Parts that the tests do not record, for example the styles,
can be different.

## Changes to ordinary files

- `Modals.vue`: the three source control modals are back, as in upstream, with the fork paths.
- `@n8n/i18n` (`en.json`): 9 texts that the original modals had in their code, under
  `settings.sourceControl.modals.*`.

## Sources

- The ordinary users of the folder (the stores of workflows, credentials, folders and data tables,
  the main sidebar, the workflow diff and its routing, the start-up code, the modals, the router)
  and their tests, the Playwright pages of source control, the texts in `@n8n/i18n`
  (`settings.sourceControl.*`) and the DTOs of `@n8n/api-types`.
- The public documentation:
  [Source control and environments](https://docs.n8n.io/source-control-environments/).
- The behaviour of the original files, recorded black-box: the store members and requests at run
  time, the rendered text, test IDs, controls and icons, the requests, the toasts, the telemetry,
  the navigation and the open modals. The enterprise files were not read.

## Tests

- `__tests__/golden/source-control.golden.test.ts` records the parts that ordinary code uses: the
  store, the modal keys, the event bus, the settings page without the licence feature and the
  start-up message.
- `__tests__/golden/source-control-ui.golden.test.ts` records the full editor: the store and the API
  module, the settings page (connections over SSH and HTTPS, the key, the branch, the protected
  instance, the color, the disconnection and the errors), the push modal (tabs, selection,
  folders, search, the filters by status, owner and folder, diffs, the push and its errors), the
  pull modal (tabs, folders, automatic publishing, diffs, the pull and its toasts and errors) and
  the result modal. A stub of `vue-virtual-scroller` renders all rows.

Both tests use the harness of the evaluation editor
(`features/ai/evaluation/__tests__/golden/harness.ts`). The snapshots were recorded against the
enterprise files, twice with the same result, and the fork files give the same snapshots.

The fork no longer has the enterprise files. To record the snapshots again after an upstream update,
use a checkout of the upstream commit in `scripts/sync-upstream.base`: copy this test folder and the
harness there, point the exports of `subject.ts` at `@/features/integrations/sourceControl.ee/`,
and run the tests with `--update=all`.

## Clean-room record

- I did not open an enterprise file of this folder. The probes of the original ran in a checkout of
  upstream n8n outside this repository. They printed only rendered text, test IDs, controls, icons,
  element outlines, requests, toasts and telemetry. I read the vitest output through its JSON
  report (test names and the first line of each failure).
