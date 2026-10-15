# The fork's editor of Git connections

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md) and
[the README of the backend module](../../../../../../cli/src/modules/promotions/README.md).

This folder holds the fork's editor of Git connections (the code calls them promotions): the
settings page "Environments v2", the banners of a team project, the selection modal of the changes
and the dialog of the missing credentials and variables. It replaces the enterprise folder
`promotions.ee`. The files that ordinary code imports keep the names and the exports of the
enterprise files. Thus the callers change only their import paths.

| Fork file                     | Ordinary code that imports it                                                  |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `module.descriptor.ts`        | `app/modules.manifest.ts`                                                      |
| `promotions.constants.ts`     | `app/composables/useSettingsItems.ts`                                          |
| `promotions.eventBus.ts`      | `ProjectNavigation.vue`, `WorkflowsView.vue`, `DataTableView.vue`              |
| `components/PromotionBanners.vue` | `ProjectHeader.vue`                                                        |

The other files are fork files: the requests (`promotions.api.ts`), the types
(`promotions.types.ts`), the views and components, and the composables. The variable modal of the
dialog of the missing items is the ordinary variable modal, with options that the fork added (see
[the FORK.md of the variables editor](../../settings/environments/FORK.md)).

## Turn it on

The editor shows when the module `promotions` is active and the rollout flag
`N8N_ENV_FEAT_PROMOTIONS` is `true` (`usePromotionsEnabled`, ordinary code). The settings page also
needs the five global scopes `gitConnection:list`, `read`, `create`, `update` and `delete`. The
owner and the admin have them. `deploy/` sets the module and the flag.

## Behaviour

### The requests

The editor sends the requests of the public API (`/api/v1/promotions/...`) with the session of the
user, through `rootStore.publicApiContext`. A list loads all its pages with the cursor. The change
list of a project uses one REST route of the backend module:
`GET /rest/promotions/:projectId/changes/:direction`.

### The settings page

The page has the route `/settings/promotions`, in the settings menu after "Environments" (the item
"Environments v2", with a preview badge). It loads the providers and the instance connection
together, then the detail of the connection. When a request fails, the toast "Couldn't load
providers" shows, and the section of the providers shows the empty state with "Retry". The other
sections stay empty.

- **Promote instance**: only when the instance connection has a Promote configuration. The button
  "Promote" is enabled when the checkout of Promote exists and matches the configuration. Otherwise
  a text tells the user to connect the Promote branch. The dialog asks for a commit message (the
  trimmed text cannot be empty), and names the base branch, or "a new branch" when Promote makes a
  branch. A promote shows the toast "Instance promoted" with the branch that the server gives, and
  closes the dialog. An error shows a toast, and the dialog stays open.
- **Git providers**: a row for each provider (the name and the authentication), and the row "Add
  provider". A click on a provider loads the provider and the connections that use it, and opens
  the provider dialog.
- **The provider dialog**: the name, the authentication (an SSH key or a username and a password)
  and, for a new SSH key provider, the key type (ED25519 or RSA). In the edit mode, the
  authentication cannot change. An SSH key provider shows its deploy key and the check box
  "Generate a new key". A username and a password provider asks for both or neither, and keeps the
  current credentials when both are empty. When connections use the provider, a notice names them,
  and Delete is disabled. After a save that makes a key, the dialog shows the deploy key with a
  copy button. Each change loads the page again.
- **Instance connection**: the provider, the name, the remote URL, and two rows with switches:
  Apply (a branch) and Promote (a base branch and "Create a branch on promote"). The editor does
  not check the remote URL: the server does. Each direction shows the state of its checkout:
  - "Save this connection before you connect." when the direction is not saved.
  - "Connected to {branch}" with "Disconnect".
  - "The remote or branch changed. Connect to update the local copy." with "Connect" and
    "Disconnect".
  - "Not connected" with "Connect", or "Save your changes before you connect." while the form has
    changes. "Connect" is disabled while the form has changes.
- **Save**: the save bar shows while the form has changes. Save is disabled until the provider,
  the name, the remote URL and the branch of each direction that is on have a value. A new
  connection is one request with its configurations. A change of a saved connection sends up to
  three requests, in this order: the connection (only the changed fields), Apply, and Promote (a
  save, or a delete when the switch is off). A failed request does not stop the next one. After a
  failure, the toast shows the first error, a notice names the parts that kept their earlier
  values, and the save bar shows "Retry". A retry sends only the parts that still differ. The form
  keeps the values that the user typed (the requests send trimmed values). "Discard changes" puts
  back the last saved values.
- The page does not ask before it closes with changes.

### The banners of a project

The banners show on a team project when the editor is on, and the user has the project scope
`project:export` and the global scope `gitConnection:read`. The editor loads the instance
connection once. The promote banner shows the number of changes to promote. The incoming banner
shows the number of incoming changes, or an error. "View changes" opens the selection modal.

### The selection modal

The modal lists the changes of the project for one direction, with a search, a refresh and the
time of the last refresh. For promote, the selection is a preview only: the submit button stays
disabled. For apply, "Apply all changes" asks for a confirmation, and applies the package of the
connection. When credentials or variables are missing, the modal shows the dialog of the missing
items. A source that changed, or an error, shows a toast and loads the changes again. After an
apply, the event bus sends `applied`, and the lists of the projects, the workflows and the data
tables load again. When the apply removed the project, the event bus sends `projectRemoved`, and
the editor goes to the home page.

### The dialog of the missing items

The dialog groups the missing credentials and variables by the workflows that use them. Each
missing item has a button that opens the credential editor or the variable modal, with the name or
the key and the destination project. The dialog also shows the items that need access, the
conflicts and the warnings. "Continue" is enabled when all items are ready, and continues the
apply.

## Clean-room sources

- The ordinary code that uses these files (the table above), `usePromotionsEnabled.ts`, the
  variable modal and the credential editor.
- The i18n texts `settings.promotions.*` and `promotions.*`.
- The DTOs of Git connections in `@n8n/api-types`, the public API controller of the backend
  module, and the documentation of the `@n8n/cli` client
  (`packages/@n8n/cli/docs/commands/promotions.md`).
- The behaviour of the original files, recorded black-box by the golden tests below. Before the
  tests, black-box probes recorded the exports of the modules, the rendered text, the test IDs,
  the controls and the requests. The enterprise files were not read.

## The golden tests

The tests in `__tests__/golden` run the editor against a fake server, with the harness of the
evaluation editor (`@/features/ai/evaluation/__tests__/golden/harness`). They click and type into
the controls, and record what a user sees (the text, the test IDs, the controls, the icons and the
hidden texts), the requests, the navigation, the toasts, the telemetry and the open dialogs. They
record no markup and no styles.

- `promotions-ui.golden.test.ts`: the module descriptor, the constants and the event bus, the
  banners, and the selection modal for promote and for apply (with the dialog of the missing
  items). 4 tests.
- `promotions-settings.golden.test.ts`: the provider dialog (18 flows), the instance connection
  (38 flows) and the promote of the instance (5 flows). 3 tests.

The snapshots were recorded against the enterprise files, two times with the same result, and the
fork files give the same snapshots. The permission data of the fork lists the scopes in another
order than upstream n8n. Thus the fixtures sort the scopes of a project (`sorted` in
`fixtures.ts`).

To record a snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`. Copy the folder `__tests__/golden` and the harness of the evaluation
editor into the same paths there. Point the exports of `subject.ts` at the files in
`@/features/integrations/promotions.ee/`, and run the test with `-u`.
