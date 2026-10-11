# The fork's connections editor of external secrets

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md),
[the FORK.md of the external secrets module](../../../../../../cli/src/modules/external-secrets/FORK.md)
and [the FORK.md of the external secrets editor](../externalSecrets/FORK.md).

This folder holds the fork's settings page of the connections of external secrets, with its cards,
its empty state and the logos, the connection modal, the delete modal, and three composables. They
replace the enterprise folder `secretsProviders.ee` for all ordinary code. This is pull request 5b
of external secrets.

| Fork file                                       | Enterprise file that it replaces                     |
| ----------------------------------------------- | ---------------------------------------------------- |
| `views/SettingsSecretsProviders.vue`            | `views/SettingsSecretsProviders.ee.vue`              |
| `components/SecretsProviderConnectionCard.vue`  | `components/SecretsProviderConnectionCard.ee.vue`    |
| `components/SecretsProvidersEmptyState.vue`     | `components/SecretsProvidersEmptyState.ee.vue`       |
| `components/SecretsProviderImage.vue`           | `components/SecretsProviderImage.ee.vue`             |
| `components/SecretsProviderConnectionModal.vue` | `components/SecretsProviderConnectionModal.ee.vue`   |
| `components/DeleteSecretsProviderModal.vue`     | `components/DeleteSecretsProviderModal.ee.vue`       |
| `composables/useSecretsProvidersList.ts`        | `composables/useSecretsProvidersList.ee.ts`          |
| `composables/useSecretsProviderConnection.ts`   | `composables/useSecretsProviderConnection.ee.ts`     |
| `composables/useConnectionModal.ts`             | `composables/useConnectionModal.ee.ts`               |

The page, the two modals and the composables keep the names of their exports. Thus the callers
change only their import: the router, `Modals.vue`, and the settings of a project
(`ProjectExternalSecrets.vue`). The two modals take the props `modalName` and `data`, as
`Modals.vue` gives them. The card, the empty state, the image and the modal composable have other
props and other members than the enterprise files. Only the fork files use them.

The fork adds one text to `@n8n/i18n`: "More details" of the error callout of the connection
modal. The original shows the same text.

## Behaviour

### The list composable

`useSecretsProvidersList()` gives the provider types and the connections of the instance:

- `fetchProviderTypes()` reads the provider types (`GET /secret-providers/types`) into
  `providerTypes`. An error goes to the caller.
- `fetchActiveConnections()` reads the connections (`GET /secret-providers/connections`) into
  `activeProviders`, only with the global scope `externalSecretsProvider:list`. A failed read keeps
  the list and shows no message.
- `activeProviders` sorts the connections by name, from the last name to the first
  (`localeCompare`).
- `fetchConnection(key)` reads one connection with its settings and its secrets
  (`GET /secret-providers/connections/:key`). It puts the connection in place of its list item. It
  does not add a connection that is not in the list. An error goes to the caller.
- `isLoading` is true while the provider types or the connections load.
- `canCreate` and `canUpdate` are the global scopes `externalSecretsProvider:create` and
  `externalSecretsProvider:update`. `isEnterpriseExternalSecretsEnabled` is the licence flag of the
  store.
- `secrets` is an empty object. As in the original, it does not follow the store.

### The connection composable

`useSecretsProviderConnection(projectId?)` sends the requests for one connection, and keeps the
state of its last test:

- Without a project id, it uses the connections API of the instance. With a project id, the read,
  the create, the update and the test use the connections API of the project
  (`/secret-providers/projects/:projectId/connections`). The reload and the activation always use
  the API of the instance.
- `createConnection(data)` sends the data with `isGlobal: true` to the API of the instance. To the
  API of a project, it sends the key, the type, the settings and the project id.
- `activateConnection(key)` sends `PATCH /secret-providers/connections/:key` with
  `{ isEnabled: true }`. `reloadConnection(key)` sends
  `POST /secret-providers/connections/:key/reload`.
- `connectionState` starts as `initializing`. `testConnection(key)` sets it to `error` when the
  test state of the result is `error`, else to `connected`. It sets `connectionError` to the error
  of the result, and gives the state. A failed request sets the state to `error` and keeps the last
  error.
- `isLoading` is true while `getConnection` runs. `isTesting` is true while `testConnection` runs.
  `setConnectionState(state)` sets the state.

### The settings page

- The router shows the page when the module settings turn on multiple connections or project
  connections. The title of the document is "External Secrets - n8n".
- Without the licence, the page shows the box "Available on the Enterprise plan". The button "See
  plans" opens the upgrade page (source `external-secrets`, campaign `upgrade-external-secrets`).
  The page sends no request. Step 5 of FORK.md removes the box.
- With the licence, the page reads the provider types, the connections and all projects, at the
  same time. A failed read of the provider types or of the projects shows an error toast. While
  the page has no connection and the provider types or the connections load, it shows a loading
  placeholder.
- Without connections, the page shows the logos of the first and the third provider type, a text,
  "Learn more" (the documentation), and "Add secrets vault" for a user who may create connections.
- With connections, the page shows a description with a link to the documentation, "Add secrets
  vault" for a user who may create connections, and a card for each connection, by name.
- With role-based access in the module settings, a switch gives the project roles the scopes of
  external secrets, or takes them away. Before it takes them away, the page asks. The switch sends
  `POST /external-secrets/settings`, reads the module settings again, and shows a toast.
- A card shows the logo, the name, "Disconnected" for an active connection with the state `error`,
  "Inactive" for an inactive connection, the name of the provider type, the number of secrets and
  the date of creation. An active connection also shows "Global", or the name of its first project
  in the list of projects. A click on the card, but not on its menu, opens the connection modal,
  also for a user who may not change the connection.
- The menu of a card has, by the scopes of the user and the state of the connection: "Edit",
  "Activate" (inactive connections), "Share" (with project connections), "Reload" (connected
  connections) and "Delete".
- "Reload" reloads the secrets, shows a toast, and reads the connection again. "Activate" activates
  the connection, reads it again, and shows a toast. A failure shows an error toast.
- A close of the connection modal, and a delete, read the connections again.

### The connection modal

- The modal adds a connection, or edits one. The settings page of the instance and the settings of
  a project open it. In the settings of a project, it uses the connections API of the project.
- To edit, the modal reads the connection and hides the form while the read runs. A failed read
  shows an error toast. The modal then tests the connection when the user may change it: with the
  global scope `externalSecretsProvider:update`, or in a project, with the update permission of the
  connection when the project owns it.
- The header shows the logo, the name and the provider type. "Save" shows "Saved" when an edited
  connection has no changes, and "Saving..." while a save runs. The delete button shows for an
  edited connection that the user may delete.
- A callout shows the result of the test: the number of secrets and the expression to use them,
  or "Couldn't connect with these settings". "More details" shows the error of the server, when the
  server gave one.
- The name must start with a letter and use only letters and numbers. A new connection needs a
  name that no other connection uses. The modal shows the error of the name after the user leaves
  the field. The name and the provider type cannot change after the create.
- The form shows the fields of the provider type. A field that its display options hide stays in
  the page, hidden. A new provider type starts with the defaults of its fields. A save sends only
  the values of the shown fields.
- The tab "Share" shows for a user with the global scope `externalSecretsProvider:update`, when the
  module has project connections. The scope select has "Global" and the team projects of the list
  of projects, and the user can type to filter them. In the settings of a project, the select is
  disabled.
- In the settings of a project, a connection that the project does not own, or that the user may
  not change, is read-only: the modal shows a notice and no "Save".
- A save creates or updates the connection, and tests it again when the settings changed. A change
  of the scope only saves the scope. A failed save shows an error toast.
- As upstream n8n does, the modal reads the first project of the connection when the list of
  projects does not have it. The select does not use it.
- A close with unsaved changes asks "Close without saving?". Only "Keep editing" keeps the modal
  open.

### The delete modal

- The modal counts the credentials that use secrets of the connection
  (`GET /credentials` with `externalSecretsStore`). A failed count shows an error toast.
- Without such credentials, "Delete" is on. With such credentials, the modal shows the number of
  secrets and the impact, and the user must type the name of the connection. The number of
  credentials is a link to the credentials page, filtered to these credentials
  (`?externalSecretsStore=`), in a new tab.
- A delete uses the API of the project when the modal has a project id. It then shows a toast and
  closes the modal. A failed delete shows an error toast.

## Clean-room sources

- The ordinary code that uses the replaced files: `router.ts`, `Modals.vue`,
  `ProjectExternalSecrets.vue` and its test, and `ProjectSettings.vue`.
- The ordinary code that the fork files use: the REST clients and the store of pull request 5a,
  `credentials.api.ts`, the filter `externalSecretsStore` of `CredentialsView.vue`, the design
  system, `Modal.vue`, `SaveButton.vue`, `ParameterInputExpanded.vue`,
  `NodeHelpers.displayParameter`, `usePageRedirectionHelper`, the stores of the editor, the types
  of `@n8n/api-types`, and the texts `settings.secretsProviderConnections.*` and
  `settings.externalSecrets.*` of `@n8n/i18n`.
- The fork module of external secrets and its REST APIs.
- The public n8n documentation of external secrets.
- The behaviour of the original files, recorded black-box by the golden test (below).
- The runtime interface of the original files. A temporary test imported them and logged the names
  of the exports with their numbers of parameters, the names and kinds of the members that the
  composables give, and the names and kinds of the props and events of the components. The test
  is gone.
- Temporary probe tests with the harness of the golden test. They rendered the original files and
  logged only what the golden test also records, the state that the composables give, the props of
  the selects, and the tags and attribute names around the credentials link of the delete modal. A
  link stub showed the route of that link. The probes found, for example, that the `secrets` of the
  list composable stay empty, that the scope select does not show the project that the modal reads,
  that a user can filter the projects of the scope select, that a click on a badge of a card opens
  the modal, and that the credentials link opens the credentials page with the filter of the
  connection. The golden test now also records the filter and the clicks on a card. The probes are
  gone.

The enterprise files and their tests were not read. The output of the test runs with the original
files was filtered to test names, counts, error names and snapshot lines. The type checks printed
only file paths and error codes for files other than the fork files.

## The golden test

`__tests__/secretsProviders.settings.golden.test.ts` has 120 cases:

- 18 cases of the list composable and the connection composable: the users and their scopes, the
  licence, the instance and a project, failed requests, requests that wait, and the results of a
  test.
- 20 cases of the page: the licence, the users and their scopes, the module settings, the states
  of the connections, the names of the projects, and failed requests.
- 82 flows: the menus, a click on each part of a card, the reload, the activation, the add and the
  edit of connections, the share tab and its filter, the close dialog, the delete modal, the switch
  of the project roles, the connection modal of a project, and requests that fail or wait.

A fake server answers the requests. Each step records what a user sees (the texts, the test ids,
the controls with their state, the icons and the logos), the props of the modal frames, the data
of the modals, the requests, the toasts, the dialogs, the telemetry, the errors that reach the
error handler of Vue, and the store state. The first step of a case is complete. The later steps
record only what changed.

The snapshot was recorded against the original files. The fork files give the same snapshot. The
golden test and the probes found no difference in behaviour.

To record the snapshot again after an upstream update, point the imports of the code under test at
the top of the test at the enterprise files. Run the test with `-u`, then point the imports back.
Keep the output of the run to test names, counts, error names and snapshot lines.

## What stays

The enterprise folder `secretsProviders.ee` and its tests stay, for the recordings of the golden
test after upstream updates. Ordinary code does not import them. They go with the enterprise code.
