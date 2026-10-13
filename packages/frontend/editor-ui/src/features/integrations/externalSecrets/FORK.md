# The fork's external secrets editor

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md) and
[the FORK.md of the external secrets module](../../../../../../cli/src/modules/external-secrets/FORK.md).

This folder holds the fork's settings page of external secrets with one connection for each
provider type, its modal, and the store of external secrets. With the two REST clients in
`@n8n/rest-api-client`, they replace these enterprise files for all ordinary code. This is pull
request 5a of external secrets. Pull request 5b replaced the settings pages of the connections
(`secretsProviders.ee`). See [the FORK.md of the connections folder](../secretsProviders/FORK.md).

| Fork file                                                | Enterprise file that it replaces                               |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `@n8n/rest-api-client/src/api/externalSecrets.ts`        | `externalSecrets.ee.ts` in that folder                         |
| `@n8n/rest-api-client/src/api/secretsProvider.ts`        | `secretsProvider.ee.ts` in that folder                         |
| `externalSecrets.store.ts`                               | `externalSecrets.ee/externalSecrets.ee.store.ts`               |
| `externalSecrets.types.ts`                               | `externalSecrets.ee/externalSecrets.types.ts`                  |
| `views/SettingsExternalSecrets.vue`                      | `externalSecrets.ee/views/SettingsExternalSecrets.vue`         |
| `components/ExternalSecretsProviderModal.vue`            | `ExternalSecretsProviderModal.ee.vue` in `components/`         |
| `components/ExternalSecretsProviderCard.vue`             | `ExternalSecretsProviderCard.ee.vue` in `components/`          |
| `components/ExternalSecretsProviderConnectionSwitch.vue` | `ExternalSecretsProviderConnectionSwitch.ee.vue` in `components/` |
| `components/ExternalSecretsProviderImage.vue`            | `ExternalSecretsProviderImage.ee.vue` in `components/`         |
| `composables/useExternalSecretsProvider.ts`              | `externalSecrets.ee/composables/useExternalSecretsProvider.ts` |
| `assets/images/`                                         | `externalSecrets.ee/assets/images/` (other logos, see below)   |

The REST clients, the store, the page and the modal keep the names of their exports. The store
keeps its id (`externalSecrets`). Thus the callers change only their import. The modal also takes
the prop `modalName`, which `Modals.vue` gives. The card, the switch, the image and the composable
have other props and arguments than the enterprise files. Only the fork page and the fork modal
use them.

## Behaviour

### The REST clients

Each export sends one request with `makeRestApiRequest` and gives the `data` of the response. An
error goes to the caller. The ids go into the path as they are, without encoding.

The settings API client (`externalSecrets.ts`):

| Export                                             | Request                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `getExternalSecrets(context)`                      | `GET /external-secrets/secrets`                                     |
| `getGlobalExternalSecrets(context)`                | `GET /secret-providers/completions/secrets/global`                  |
| `getGlobalExternalSecretsForProject(context, id)`  | `GET /secret-providers/completions/secrets/global/:id`              |
| `getProjectExternalSecrets(context, id)`           | `GET /secret-providers/completions/secrets/project/:id`             |
| `getExternalSecretsProviders(context)`             | `GET /external-secrets/providers`                                   |
| `getExternalSecretsProvider(context, id)`          | `GET /external-secrets/providers/:id`                               |
| `testExternalSecretsProviderConnection(context, id, data?)` | `POST /external-secrets/providers/:id/test` with `data` (without `data`, no body) |
| `updateProvider(context, id, data?)`               | `POST /external-secrets/providers/:id` with `data` (without `data`, no body) |
| `reloadProvider(context, id)`                      | `POST /external-secrets/providers/:id/update`                       |
| `connectProvider(context, id, connected)`          | `POST /external-secrets/providers/:id/connect` with `{ connected }` |
| `updateExternalSecretsSettings(context, settings)` | `POST /external-secrets/settings` with `settings`                   |

The connections API client (`secretsProvider.ts`) sends the requests of the connections API of the
module (`/secret-providers/types`, `/secret-providers/connections` and
`/secret-providers/projects/:projectId/connections`): read, create (`POST`), update (`PATCH`),
delete, test (`POST .../test`) and reload (`POST .../reload`). `enableSecretProviderConnection`
sends `PATCH /secret-providers/connections/:key` with `{ isEnabled: true }`.

### The store

- The state holds the provider types (`providers`), the secret names of the global connections
  (`secrets`), the secret names of the connections of a project (`projectSecrets`), and the
  connection state of each provider type (`connectionState`).
- `isEnterpriseExternalSecretsEnabled` is the licence flag `feat:externalSecrets`.
- `globalSecretsAsObject` and `projectSecretsAsObject` give the secret names as a tree for the
  completions: `a.b` of the provider `p` becomes `{ p: { a: { b: '*********' } } }`. A name cannot
  continue below another name: for `a` and `a.b`, the getter throws a `TypeError`.
  `secretsAsObject` merges the two trees. A provider key of the project replaces the same global
  key.
- `fetchGlobalSecrets(projectId?)` does nothing without module settings. With role-based access, it
  reads the global secrets for a user of the project, and does nothing without a project. With
  multiple connections or project connections, it reads the global completions. Else it reads
  `/external-secrets/secrets`. A failed read clears the names.
- `fetchProjectSecrets(projectId?)` reads the secrets of the project only when the module has
  project connections, the project id is set, and the user may read them: with the global scope
  `externalSecret:list`, or with that scope in the project. The current project, else the list of
  the projects of the user, gives the scopes of the project. A failed read clears the names.
- `fetchSecretsForProject(projectId?)` runs the two fetches at the same time.
- `getProviders()` replaces the list. `getProvider(id)` reads one provider type with the fields of
  its form, replaces it in the list (or adds it), and gives it.
- `updateProvider(id, { data })` stores the settings, then merges them into the provider type of
  the list. `updateProviderConnected(id, value)` connects or disconnects, then sets `connected` and
  the state (`connected` or `initializing`). `updateStoredProvider` merges values into a provider
  type of the list. A provider type that is not in the list gives a `TypeError`.
- `reloadProvider(id)` gives the `updated` flag of the server. `testProviderConnection(id, data)`
  gives the result of the test. `setConnectionState(id, state)` sets one connection state.

### The settings page

- The title of the document is "External secrets - n8n".
- Without the licence, the page shows the box "Available on the Enterprise plan" with the button
  "See plans". As on the enterprise page, the button does nothing. The page sends no request. Step 5
  of FORK.md removes the box.
- With the licence, the page shows an information callout with a link to the documentation, and a
  card for each provider type, in reverse order of the provider name. It reads the secret names
  (only with the global scope `externalSecret:list`) and the provider types, at the same time. It
  sets the connection state of each provider type from its `state`. When the providers request
  fails, the page shows no card and no message.
- A card shows the logo and the name. For a connected provider type, it also shows the number of
  secrets and the date of the connection ("Connected 02 Jan 2026"). Without a date, the card shows
  the date of today.
- A connected provider type, or one with stored settings, shows its switch ("Enabled" or
  "Disabled") and a menu. Else the card shows "Set Up", which opens the modal. The menu has "Edit
  connection" (the modal), and "Reload secrets" for a connected provider type. A reload shows a
  success toast, or an error toast when it fails.
- The switch shows a warning icon when the `state` of the provider type is `error`. A provider type
  that is not connected cannot be enabled when its connection state is `error`.
- To enable a provider type on its card, the switch reads the provider type again, and tests its
  stored settings. A failed test shows an error toast and sets the connection state to `error`.
  After a passing test, the switch connects the provider type and reads the secret names again. To
  disable, the switch disconnects and reads the secret names again.

### The provider modal

- The modal reads the provider type with the fields of its form. It shows the fields in their
  order: the notice, and a parameter input for each other field. A field that its display options
  hide stays in the page, hidden.
- The modal fills two values that older settings do not have: the environment `public` of Azure Key
  Vault, and the site URL `https://app.infisical.com` of Infisical. Then the settings count as
  changed.
- When the provider type is not connected and has stored settings, the modal tests them. When its
  state is `connected`, the modal reloads its secrets and reads the secret names again. A failed
  reload shows no message.
- A callout shows the connection state: success for `connected` and `tested` (for a connected
  provider type, with the number of secrets and the expression to use them), danger for `error`.
- "Save" is on when the settings changed, each required field that the form shows has a value, and
  no save runs. A save sends only the values of the shown fields, reads the secret names again,
  and tests the settings. While the save runs, the button shows "Saving". A failed save shows an
  error toast, keeps the changes, and still tests the settings.
- The switch of the modal connects or disconnects without a test first. It is disabled while the
  connection state is `initializing` or `error` and the provider type is not connected. After a
  change, the modal tests the settings of the form, also when they are not saved.
- A close with unsaved changes asks "Close without saving?". Only "Keep editing" keeps the modal
  open.

### The logos

`assets/images/README.md` lists the sources and the terms of the logos. The repository owner chose
the official logos of the vendors on 2026-10-11, also for the icons of AWS, Azure and Google Cloud,
whose terms name only diagrams and documentation. The logos are not the files of the enterprise
folder. 1Password, AWS Secrets Manager, Azure Key Vault and GCP Secrets Manager are inline SVG
elements. HashiCorp Vault and Infisical are images. The page selects the logo by the name of the
provider type, not by its icon. A provider type without a logo gets an image without a source,
with its name as the alternative text.

### Differences from the original

- The enterprise folder has a logo for a provider type `doppler`. Neither the fork module nor the
  enterprise module has this provider type. The fork has no Doppler logo. Thus the card of a
  provider type `doppler` shows an image without a source, as for other provider types without a
  logo.
- When the secret names have no entry for a connected provider type, the success callout of the
  modal shows "0 secrets". The original shows "undefined secrets". The server gives an entry for
  each connected provider type, so this does not occur with the fork module.
- When the providers request of the page fails, or the reload at the open of the modal fails, the
  original leaves the error unhandled in the browser console. The fork catches it. The user sees
  the same in both.

## Clean-room sources

- The ordinary code that uses the replaced files: `router.ts`, `Modals.vue`,
  `ParameterInputWrapper.vue`, `CredentialsView.vue`, `CredentialEdit.vue`, the completions
  (`datatype.completions.ts`, `dollar.completions.ts`), their tests, `ProjectExternalSecrets.vue`
  and `useSettingsItems.ts`.
- The ordinary code that the fork files use: `makeRestApiRequest`, the design system, `Modal.vue`,
  `ModalRoot.vue`, `ParameterInputExpanded.vue`, `NodeHelpers.displayParameter`, the stores and
  composables of the editor, the types of `@n8n/api-types`, and the texts
  `settings.externalSecrets.*` of `@n8n/i18n`.
- The fork module of external secrets and its REST APIs.
- The public n8n documentation of external secrets.
- The behaviour of the original files, recorded black-box by the three golden tests (below).
- The runtime interface of the original files. A temporary test imported them and logged the names
  of the exports with their numbers of parameters (`Function.length`), the store id, the names of
  the store members, and the names of the components with the names and kinds of their props and
  events. The test is gone.
- Temporary probe tests with the harness of the page golden test. They rendered the original page
  and modal, and logged only what the golden test also records: the texts, the controls, the
  requests, the toasts and the store state. They found, for example, which settings count as
  changed when the modal opens, the logos of other provider types, and that "See plans" calls no
  upgrade helper. The probes are gone.
- Type checks and test runs with enterprise files removed for a moment, to find which files use
  them. These runs printed only file paths and error codes, and the counts of the tests.

The enterprise files and their tests were not read. The output of the test runs with the original
files was filtered to test names, counts, error names and snapshot lines.

There were two slips:

- One type check printed two error messages about lines of the enterprise store:
  `ExternalSecretsProviderData | undefined` did not fit the settings parameter of the first fork
  client. The fork then made the `data` parameter of `updateProvider` optional. The store golden
  test records the same behaviour: an update without settings sends a request without a body.
  Later type checks printed only file paths and error codes.
- While the fork looked for the cause of two type errors of the enterprise store, one command
  printed 13 lines of the upstream file `@n8n/permissions/src/types.ee.ts` from the Git history:
  the types `ScopeLevels`, `MaskLevels` and `ScopeOptions`. The fork's permission core has had the
  same three types since step 2. This pull request does not use the lines.

Two type errors of the enterprise store stayed. A script with the TypeScript compiler API found
the called functions. For each error, it printed only the error code, the index of the argument,
and the name and the file of the called function of ordinary code: the settings argument of
`updateProvider` and of `testExternalSecretsProviderConnection`, in the build (`dist`) of
`@n8n/rest-api-client`. In the type check of the editor, the enterprise store reads the REST client
from that build, and the build in the session was old. The fork made the `data` parameter of
`testExternalSecretsProviderConnection` optional too. After a new build, the enterprise store has
no type errors. Container CI builds the packages before the type check.

## The golden tests

- `@n8n/rest-api-client/src/api/__tests__/external-secrets.golden.test.ts` calls each export of the
  two clients with probe arguments: texts, objects, a text with special characters, and an extra
  argument. It records the request that axios gets, and the result, or the error of the server.
- `__tests__/externalSecrets.store.golden.test.ts` (57 cases) calls the getters and the actions of
  the store for each licence state, mode of the module, user and project, against a fake server.
  It also covers the permission to read the secrets of a project, failed requests, and two fetches
  that run at the same time. It records the requests, the results and errors, the toasts, and the
  state and the getters after each step.
- `__tests__/externalSecrets.settings.golden.test.ts` renders the page and the modal with real
  stores (14 page cases and 24 flows). A fake server answers the requests. It covers the licence,
  the users and their scopes, the module settings, the states of the provider types, the menu, the
  switches, the reload, the set-up of AWS Secrets Manager, the edit and the save of 1Password, the
  close dialog, and requests that fail or wait. Each step records what a user sees (the texts, the
  test ids, the controls with their state, the icons and the logos), the props of the modal frame,
  the requests, the toasts, the dialogs, the telemetry and the store state. The first step of a
  case is complete. The later steps record only what changed.

The snapshots were recorded against the original files. The fork files give the same snapshots.
Mutation checks changed one detail of the fork at a time (for example the rule of the Set Up
button, the hidden fields, the values for older settings, the close dialog and the order of the
cards). The golden tests failed for each change.

The fork no longer has the enterprise files. To record a snapshot again after an upstream update,
record it in a checkout of upstream n8n, as the root FORK.md tells ("Upstream updates"), with the
imports of the code under test at the top of the test at the enterprise files. The test of the page
needs the enterprise page and modal (`externalSecrets.ee/views/` and
`ExternalSecretsProviderModal.ee.vue`) and the enterprise store. Keep the output of the run to test
names, counts, error names and snapshot lines. With the original files, the run ends with two
unhandled errors (see the differences above).

## Removed enterprise files

- The fork deleted the enterprise folder `externalSecrets.ee`, its tests, and the enterprise REST
  clients `externalSecrets.ee.ts` and `secretsProvider.ee.ts` in step 4.
- The index of `@n8n/rest-api-client` gives the fork clients.
