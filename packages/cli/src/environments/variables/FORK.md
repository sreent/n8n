# The fork's variables

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md) and
[the FORK.md of the variables editor](../../../../frontend/editor-ui/src/features/settings/environments/FORK.md).

Variables (`$vars`) are values for the workflows: global variables for the whole instance, and
project variables for one project. The owner chose on 2026-10-12 to rebuild them. The fork files
replace the enterprise folder `environments.ee` for all ordinary code. They keep the class names,
so the callers change only their import paths.

| Fork file                  | Enterprise file that it replaces                      |
| -------------------------- | ----------------------------------------------------- |
| `variables.service.ts`     | `environments.ee/variables/variables.service.ee.ts`    |
| `variables.controller.ts`  | `environments.ee/variables/variables.controller.ee.ts` |

The public API of variables (`variables.public.controller.ts`), the entity and the repository in
`@n8n/db`, the DTOs in `@n8n/api-types` and the two error classes in `src/errors` are ordinary code.
They stay.

## Behaviour

### The cache

`getAllCached()` gives all variables of the instance with their projects, from the cache key
`variables`. When the cache is empty, it reads them from the database. Each create, update and
delete of the service writes all variables to the cache again (`updateCache()`). A change in the
database outside of the service shows only after `updateCache()`. `getCached(id)` gives one
variable from the cache, or `null`.

### Who may do what

The service checks the scopes of the user. A global variable needs the global scope. A project
variable needs the project scope, in the global role of the user or in their role in its project
(`userHasScopes`).

| Action | Global variable | Project variable | Error |
| --- | --- | --- | --- |
| List | `variable:list` | `projectVariable:list` | The variable is not in the list. |
| Read one | `variable:read` | `projectVariable:read` | 403 "You are not allowed to access this variable" |
| Create | `variable:create` | `projectVariable:create`, and the project exists | 403 "You are not allowed to create a variable" or "... in this project" |
| Update | `variable:update` | `projectVariable:update` | 403 "You are not allowed to update this variable" |
| Move to another scope | `variable:create` | `projectVariable:create` in the new project, and the project exists | 403 "You are not allowed to move this variable to the global scope" or "... to the specified project" |
| Delete | `variable:delete` | `projectVariable:delete` | 403 "You are not allowed to delete this variable" |

With the permission data of the fork: the owner and the admins may do all. A member may read and
list the global variables. The admins and the editors of a project may do all with its
variables, and its viewers may read and list them. A personal project has no variable scopes.

The golden test cannot tell whether a move needs the create or the update scope of the new scope:
no role has one without the other. The fork uses the create scope.

### The rules

- A key is unique in its scope: among the global variables, or in one project. A project variable
  may have the key of a global variable, and then overrides it in the project.
  `VariableCountLimitReachedError` reports a key that is taken: "A global variable with key "X"
  already exists", or "A variable with key "X" already exists in the specified project". The
  import of packages (ordinary code) needs this error class for a key that is taken.
- The licence quota `quota:maxVariables` counts all variables together. When no variable is
  left, a create fails with `VariableCountLimitReachedError` "Variables limit reached". An update
  does not count. `getRemainingVariableQuota()` gives `{ limit, remaining }`, or `null` without a
  limit. Without a licence certificate, there is no limit.
- The order of the checks of a create: the permission, the quota, then the key.
- An update of an unknown ID fails with 404 "Variable with id X not found" before the permission
  check. A delete of an unknown ID needs `variable:delete`, then succeeds.
- An update may keep an old key that starts with a number. A new key in an update must match
  `NEW_VARIABLE_KEY_REGEX`, else `VariableValidationError`. The service does not check the keys of
  a create: the DTO of the REST API and of the public API checks them.
- An update without fields fails in the database with the status 500, as in the original.
- `deleteByIds` deletes without a check of the user and without events.

### Events

The service sends `variable-created`, `variable-updated` and `variable-deleted` with the user, the
ID and the key of the variable. A project variable also has `projectId`: for an update, the
project after the update. A delete of an unknown ID sends the event with an empty key.

### The REST API (`/rest/variables`)

| Route | Licence | Result |
| --- | --- | --- |
| `GET /` with `state=empty` and `projectId` | No | The variables that the user may list, with their projects. |
| `GET /:id` | No | One variable, with its project. |
| `POST /` | `feat:variables` | The new variable. A project variable has `project: { id }` and `projectId`. |
| `PATCH /:id` | `feat:variables` | The variable after the update, with its project. |
| `DELETE /:id` | `feat:variables` | `true`. |

Without the licence feature, the three changes answer 403 "Plan lacks license for this feature".
While the fork switch is on (step 5 of FORK.md), the licence has `feat:variables`.
The DTOs of `@n8n/api-types` check the body and the query. A taken key, a full quota and a key
that is not valid answer 400.

## Clean-room sources

- The ordinary code that uses the service: the public API controller and its integration test,
  the import and the export of packages (`n8n-packages`) and their tests, `workflow-helpers.ts`,
  the job processor, and the test helpers in `test/integration/shared/db/variables.ts`.
- The entity and the repository in `@n8n/db`, the DTOs in `@n8n/api-types`, the error classes in
  `src/errors`, the event map (`relay.event-map.ts`), the permission data, and the licence quota.
- The Playwright API helper of variables (`variables-api-helper.ts`).
- [The public documentation of variables](https://docs.n8n.io/code/variables/).
- The behaviour of the original files, recorded black-box by the golden test below. The enterprise
  files were not read.

## The golden test

`packages/cli/test/integration/variables.api.test.ts` calls the REST API as the owner, an admin,
a member, and the admin, the editor and the viewer of a project, with and without the licence
feature and with quotas. It also calls the service as ordinary code does. The snapshot records
the status and the body of each answer, the variable events, and the cache. IDs, dates and the
names of the users become labels.

The snapshot was recorded against the enterprise files, and the fork files give the same
snapshot. The fork no longer has the enterprise files. To record the snapshot again after an
upstream update, use a checkout of the upstream commit in `scripts/sync-upstream.base`: copy the
test and its snapshot into the same folder there, point the import of `VariablesService` at
`@/environments.ee/variables/variables.service.ee`, and run the test with `-u`. The test server
of upstream loads the enterprise controller.
