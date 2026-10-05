# The fork's permission core

Fork document (not in upstream n8n). Read it with [FORK.md](../../../FORK.md) and
[FORK-FEATURES.md](../../../FORK-FEATURES.md).

Step 2 of the fork replaced the enterprise files of this package with ordinary fork code. The
package has the same exports and the same behaviour as before. Ordinary code that imports it did
not change.

## What the fork replaced

Upstream keeps the scope list, the role maps, the schemas and the permission checks in `.ee` files
in `src/`. The fork deleted them. `scripts/removed-enterprise-paths.txt` lists them as
`packages/@n8n/permissions/src/**/*.ee.*`, so an upstream update cannot bring them back. The fork
modules have the same names without `.ee`:

| Module | Contents |
|---|---|
| `permission-data.generated.ts` | The data that a running n8n shows: the resources and their operations, the scopes of the system roles, the API key scopes, and the scopes that settings add. Generated, do not edit. |
| `constants.ts` | `RESOURCES`, `API_KEY_RESOURCES`, the role slugs and the three setting objects. |
| `types.ts` | `Scope`, `ApiKeyScope`, the role types, `AuthPrincipal`, `isApiKeyScope`, `isAssignableProjectRoleSlug`. |
| `schemas.ts` | The zod schemas of roles, role slugs and scopes. |
| `principal.ts` | `Principal`, `SecurityContext`, `AuthMethod`, `ResourceGrant`. |
| `public-api-permissions.ts` | `getApiKeyScopesForRole`, `getOwnerOnlyApiKeyScopes`, `OWNER_API_KEY_SCOPES`, `MEMBER_API_KEY_SCOPES`. |
| `roles/scopes/*.ts`, `roles/role-maps.ts` | The scope lists of the system roles, and the maps of each role namespace. |
| `roles/custom-role-scopes.ts` | What custom roles can hold, and the options of the role editors. |
| `utilities/*.ts` | `hasScope`, `hasGlobalScope`, `combineScopes`, `getRoleScopes`, `getAuthPrincipalScopes`, `getGlobalScopes`, `getResourcePermissions`, `staticRolesWithScope`. |

`src/index.ts`, `src/roles/all-roles.ts`, `src/scope-information.ts` and the tests are ordinary
upstream files. The fork changed only their import paths.

## Clean-room sources

| What | Source |
|---|---|
| The scopes and their order | The ordinary snapshot test `src/__tests__/__snapshots__/scope-information.test.ts.snap`. Upstream updates it with each new scope. |
| The scopes of the system roles | A running n8n: the `role` and `role_scope` tables after startup. |
| The setting keys | A running n8n: the debug log of `AuthRolesService` names the personal space keys. The SQL query log (`DB_LOGGING_ENABLED=true`, `DB_LOGGING_OPTIONS=query`) names `externalSecrets.systemRolesEnabled`. |
| The scopes that settings add | A running n8n: the roles after a start with each setting changed. |
| API key scopes | A running n8n: `GET /rest/api-keys/scopes` for each system role and for custom roles that the script writes to the database. |
| Function behaviour, types and schemas | The ordinary tests of this package, the ordinary code that imports it, and the DTO tests in `@n8n/api-types`. |
| Custom role data | The ordinary tests of this package and of the editor role views, the editor texts in `@n8n/i18n`, and the public [custom roles](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac/create-custom-roles.md) pages. |
| `isAssignableProjectRoleSlug` | The enterprise project service imports this name. With the owner's approval, the name came from one compiler message (TS2724). The behaviour comes from its type and `assignableProjectRoleSchema`. |

The enterprise files, their build output in `dist/` and their Git history were not used.

## How n8n computes API key scopes

The probes of `scripts/permission-snapshot.mjs` show this model, and the script checks it against
every recorded user:

- A chat user (`global:chatUser`) gets no API key scopes.
- Every other user gets the API key scopes of its role, in the order of the role, then
  `API_KEY_EXTRA_SCOPES`. The extra scopes give access to resources in the projects of the user.
  Custom roles follow the same rule.
- `MEMBER_API_KEY_SCOPES` is this result for the member role. `OWNER_API_KEY_SCOPES` is this
  result for the owner role without the community package scopes: the ordinary tests of the
  community packages API expect a key with only this list to be refused there.
- `getOwnerOnlyApiKeyScopes()` is the full result for the owner role without the member list. A
  user who becomes a member loses these scopes from their API keys.

## Custom roles

Custom roles need a licence, so a running n8n without a licence cannot show their data. The fork
designed `roles/custom-role-scopes.ts` to pass the ordinary tests and to match the public
documentation. Where these sources say nothing, the data is a fork decision. The main one: the
**Instance settings: Manage** option holds the scopes of the instance settings that the admin role
holds, except the scopes of the other options and the baseline scopes. Step 3 builds the fork's own
custom roles on this data.

## Make the data again after an upstream update

1. Record a snapshot of the new upstream version. Use one of these:
   - The official image, when the fork matches a release: `node scripts/permission-snapshot.mjs
     record --image n8nio/n8n:<version> --out /tmp/snapshot.json`. Start `dockerd` first. A
     release image can be older than an upstream commit on `master`. For example, the image of
     2.42.0 did not yet give members API keys for `variable:create`, `variable:update` and
     `variable:delete`.
   - A build of the upstream commit in `scripts/sync-upstream.base`, in a separate checkout:
     `node scripts/permission-snapshot.mjs record --n8n <checkout>/packages/cli/bin/n8n --out
     /tmp/snapshot.json`. Do not use a build of the fork: it shows the old fork data.
2. Copy the snapshot to `packages/@n8n/permissions/permission-snapshot.json`, then run
   `node scripts/permission-snapshot.mjs generate packages/@n8n/permissions/permission-snapshot.json`.
3. Read the diff of both files. A new scope or a new grant must match an upstream change.
4. Run the tests of this package and the type check of the repository. Container CI runs
   `generate --check`, which fails when the data file does not match the snapshot.

Signals that the data is old: the scope snapshot test of this package fails when upstream adds a
scope, and the type check fails when ordinary code names a scope that the data does not have.

## Fork scopes

The generated data is only upstream data. A fork feature that needs a new scope adds it in a
separate fork list next to the generated data, with a test, in the pull request of the feature. No
fork feature needs a scope yet, so that list does not exist yet.

## Acceptance of step 2

- The 16 ordinary test files of the package pass. Only their import paths changed.
- **Golden comparison.** A snapshot of the build before the change and a snapshot of the build
  after it are identical byte for byte: the scopes, all roles, the effect of each setting, and the
  login scopes and API key scopes of the owner, admin, member, chat user and six custom roles.
- The type check of every package that uses `@n8n/permissions` passes, also the editor app.
- The editor role views pass their tests (300 tests).
