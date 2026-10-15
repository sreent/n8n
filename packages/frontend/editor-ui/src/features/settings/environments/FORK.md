# The fork's variables editor

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md) and
[the FORK.md of the variables backend](../../../../../../cli/src/environments/variables/FORK.md).

This folder holds the fork's editor parts of variables (`$vars`). They replace the enterprise
folder `environments.ee` for all ordinary code. The files keep the names and the exports of the
enterprise files, and the store keeps its id (`environments`). Thus the callers change only their
import paths.

| Fork file                               | Enterprise file that it replaces                            |
| --------------------------------------- | ----------------------------------------------------------- |
| `environments.store.ts`                 | `environments.ee/environments.store.ts`                     |
| `environments.api.ts`                   | `environments.ee/environments.api.ts`                       |
| `environments.constants.ts`             | `environments.ee/environments.constants.ts`                 |
| `environments.types.ts`                 | `environments.ee/environments.types.ts`                     |
| `completions/variables.completions.ts`  | `environments.ee/completions/variables.completions.ts`      |
| `components/VariableModal.vue`          | `environments.ee/components/VariableModal.vue` and its form |
| `components/VariablesUsageBadge.vue`    | `environments.ee/components/VariablesUsageBadge.vue`        |

The page of the variables (`ProjectVariables.vue`) is ordinary code. It stays.

## Behaviour

### The REST client and the store

The REST client sends `GET /variables`, `POST /variables`, `PATCH /variables/:id` and
`DELETE /variables/:id` with `makeRestApiRequest`, and gives the `data` of the response. An error
goes to the caller, and the state of the store does not change.

`useEnvironmentsStore` (also the default export):

- `fetchAllVariables()` loads all variables that the user may read, and gives them.
- `createVariable({ key, value, projectId? })` sends the fields, and puts the new variable first.
- `updateVariable({ id, ...fields })` sends the fields without the ID, and replaces the variable
  with the same ID as the answer.
- `deleteVariable({ id })` deletes the variable, and gives the answer of the server.
- After a create or an update with a `projectId`, the project of the variable is `{ id, name }`
  from `projectsStore.availableProjects`. When the list does not have the project, the variable
  keeps the project that the server gave.
- The current project is `projectsStore.currentProject`, not the route.
  - `scopedVariables`: the global variables and the variables of the current project.
  - `variables`: with a current project, the same as `scopedVariables`. Without one, all
    variables.
  - `variablesAsObject`: the values of `$vars`, from `resolveVariables` of `n8n-workflow`. A
    variable of the current project wins over a global variable with the same key.
  - `getVariablesInScope(projectId?)`: the variables of that project, or the global variables
    when there is no project ID.

### The completions

`addVarType` marks a completion as a variable. `useVariablesCompletions().variablesCompletions`
completes `$vars.` (or another matcher) to `$vars.<key>` for each variable of `scopedVariables`,
with the value as the info. Without the dot, it gives no completions.

### The usage badge

`VariablesUsageBadge` shows `$vars.<name>`. A click copies it, and shows the toast "Copied to
clipboard".

### The variable modal

`Modals.vue` opens `VariableModal` with `{ mode: 'new' }`, `{ mode: 'new', projectId }` or
`{ mode: 'edit', variable }`. The modal is 600 pixels wide. It loads the projects of the user
(`GET /projects/my-projects`) and puts the focus on the key.

- **Key**: required, at most 50 characters, only letters, numbers and underscores. A new key
  cannot start with a number. An error shows when the field loses the focus.
- **Value**: at most 1000 characters. It can be empty.
- **Scope**: only for a new variable outside of a project page. The options are Global, Personal
  (the personal project) and the team projects of the user. An option is disabled when the user
  may not create a variable there: `variable:create` for Global, `projectVariable:create` in the
  project for a project. Without a choice, the variable is global.
- When another variable in the same scope has the key, the modal shows "The key already exists in
  this project", and Save is disabled. When a project variable has the key of a global variable,
  the modal warns that the project variable overrides it.
- Save, or Enter in a field, creates or updates the variable and closes the modal. An update sends
  the `projectId` of a project variable. When the save fails, the toast "Error while saving
  variable" shows, and the modal stays open. Cancel closes the modal. The modal does not ask before
  it closes.

The dialog of the missing items of Git connections opens the modal with more options (see
[the FORK.md of the editor of Git connections](../../integrations/promotions/FORK.md)):

- `projectId`: the scope of the new variable. `null` is a global variable. With this option, the
  modal does not show the scope.
- `fixedKey`: the key cannot change, and the modal does not put the focus on it.
- `initialValues`: the first key and value.
- `destination`: the project of the new variable. The modal shows its name. When the project does
  not exist yet, Save needs the permission to create it.
- `onCreate`: the modal calls it with the key, the value and the project ID, in place of the store.
  When it fails, the toast "Error while saving variable" shows, and the modal stays open.
- `appendToBody`: the modal opens in the body, above the dialog of Git connections.

## Clean-room sources

- The ordinary code that uses these files: `ProjectVariables.vue` and its test, `Modals.vue`,
  `ProjectHeader.vue`, `useGlobalEntityCreation.ts`, the completions of the Code node and of
  expressions (`datatype.completions.ts`), `useWorkflowHelpers.ts`, the mirage server of the tests
  (`__tests__/server`), and `resolveVariables` of `n8n-workflow`.
- The i18n texts `variables.*` and `codeNodeEditor.completer.$vars*`.
- The Playwright page objects of variables (`VariablesPage.ts`, `VariableModal.ts`) and their
  test.
- [The public documentation of variables](https://docs.n8n.io/code/variables/).
- The behaviour of the original files, recorded black-box by the golden test below. Before the
  test, black-box probes recorded the exports of the modules, the members of the store, and which
  state changes `scopedVariables`. The enterprise files were not read.

## The golden test

`__tests__/environments.golden.test.ts` runs the store, the completions, the badge and the modal
against a fake server. The modal renders in `ModalRoot`, with a stub of the ordinary `Modal`. The
snapshot records the requests, the state and the getters of the store, the completions, what a
user sees (the text, the test IDs, the controls, the icons and the focus), the toasts, the
telemetry and the clipboard. It records no markup and no styles.

The block "the variable modal of a binding" (10 tests) records the options of the dialog of the
missing items of Git connections.

The snapshot was recorded against the enterprise files, and the fork files give the same
snapshot. The fork no longer has the enterprise files. To record the snapshot again after an
upstream update, use a checkout of the upstream commit in `scripts/sync-upstream.base`: copy the
test and its snapshot into the same folder there, point the imports of the code under test at the
files in `@/features/settings/environments.ee/`, and run the test with `-u`.
