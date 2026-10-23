# The fork's role provisioning

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md),
[packages/cli/src/modules/sso-oidc/FORK.md](../sso-oidc/FORK.md) and
[FORK-FEATURES.md](../../../../../FORK-FEATURES.md).

This module replaces the enterprise module `provisioning.ee` for all ordinary code: the user
service, the project controllers, the public API, the instance settings loader, the test server and
the ordinary tests. It is the third pull request of step 4. The module name `provisioning` stays:
the module registry loads `modules/provisioning/` first, and the fork deleted
`modules/provisioning.ee/`. The class names and the methods that ordinary code calls stay too:

| File | Replaces | Kept names |
|---|---|---|
| `provisioning.service.ts` | `provisioning.service.ee.ts` | `ProvisioningService`: `init`, `getConfig`, `loadConfig`, `handleReloadSsoProvisioningConfiguration`, `isInstanceRoleManaged`, `isProjectRoleManaged`, and the field `provisioningConfig`, which ordinary tests change |
| `role-mapping-rule.service.ts` | `role-mapping-rule.service.ee.ts` | `RoleMappingRuleService`: `list`, `create`, `move`, `patch`, `delete`; the type `RoleMappingRuleResponse` |
| `role-deletion-checker.ts` | `role-deletion-checker.ee.ts` | `ProvisioningRoleDeletionChecker` |
| `constants.ts` | `constants.ts` of the enterprise folder | `PROVISIONING_PREFERENCES_DB_KEY` |
| `provisioning.controller.ts`, `role-mapping-rule.controller.ts`, `provisioning.module.ts` | the files of the same name | the routes and the module name |

The fork's OIDC and SAML sign-ins apply the roles. The module starts only with the `feat:saml` or
the `feat:oidc` licence, as before. While the fork switch is on (step 5 of FORK.md), the licence has
both, so the module starts by default.

## Behaviour

### The config

- The settings row `features.provisioning` (`loadOnStartup`) holds the config as JSON: the fields
  of `ProvisioningConfigDto` in their order. `defaultInstanceRole` is there only when it is set.
- With `N8N_SSO_MANAGED_BY_ENV=true` and the OIDC or SAML login on, the ordinary SSO instance
  settings loader writes this row at each start, from `N8N_SSO_USER_ROLE_PROVISIONING` and
  `sso.provisioning` of `GlobalConfig`.
- The config lives in memory. The first read loads it (`getConfig()`); the start of the module does
  not. `init()` and the `reload-sso-provisioning-configuration` command load it again, on each main
  instance in each role.
- `loadConfig()` reads the row and does not change the memory. Without a row, and with a row that
  is not JSON or that `ProvisioningConfigDto` refuses, it gives the values of the environment
  (`sso.provisioning` of `GlobalConfig`, without a default role).

### The config endpoints

`GET` and `PATCH /sso/provisioning/config`. The checks, in this order: a session (401), the scope
`provisioning:manage` (403), and then the licence: without `feat:saml` and `feat:oidc`, 403 with
the body `{ "message": "Provisioning is not licensed" }`.

`PATCH` does these steps:

1. It checks the body with `ProvisioningConfigPatchDto`. A failure is a 400 with the message of the
   zod error.
2. It merges the body into the config in memory: a key replaces the key, `null` removes the key. It
   does not read the row, so a change of another instance without the reload command is lost.
3. Expression mapping together with a direct-claim flag gives 400: "Expression-based mapping and
   direct-claim provisioning cannot both be enabled at the same time."
4. A default role must be `block:access` or an existing role of the role type `global` other than
   `global:owner` (the slug prefix does not count). Else 400: `defaultInstanceRole must be
   "block:access" or the slug of an assignable global role`. The check reads the merged value, so a
   stored invalid value blocks every `PATCH`.
5. The merged config must be a full `ProvisioningConfigDto`. Else the zod error goes to the caller
   (500), for example after a `null` for a required key.
6. It writes the row and the memory.
7. It deletes all project rules when the body has `deleteProjectRules: true`, or when the old config
   set project roles (from claims or by expression mapping) and the new one does not. Then the event
   `role-mapping-rules-bulk-deleted` (`ruleType: 'project'`, the count, also 0, and
   `reason: 'strategy-switch'`).
8. In multi-main mode, it sends the `reload-sso-provisioning-configuration` command.

The response is the config (`{ data }`).

### The rules

A rule has an expression, a role, a type (`instance` or `project`), an order and, for a project
rule, projects. The order values of a type are 0, 1, 2, ... (unique per type).

The endpoints of `/role-mapping-rule` check a session, the scopes `roleMappingRule:list`, `:create`,
`:update` and `:delete`, and then the licence, as the config endpoints. The public API calls the same
service.

- **List** (`GET`): `{ count, items }` with the DTO `ListRoleMappingRuleQueryDto`: a type filter,
  `skip`, `take` (10 by default; 0 gives all) and `sortBy` (`order:asc` by default). Rules of the two
  types with the same order value come in no fixed order.
- **Create** (`POST`): the checks, in this order: `projectIds` must not be empty for a project rule
  (400 "projectIds is required when type is project") and must be empty for an instance rule (400
  "projectIds must be omitted or empty when type is instance"); the role must exist (404 `Could not
  find role with slug "<slug>"`); its role type must fit the rule (400 "Instance mapping rules must
  use a global role" or "Project mapping rules must use a project role"); the projects must exist,
  of any project type (400 "One or more projects were not found"). A project in the list twice
  counts once. `global:owner` and `project:personalOwner` are valid roles; `block:access` is not a
  role. The expression is not checked. The rule goes to the place `order` (to the end when it is
  missing or too large), and the rules after it move down. Event `role-mapping-rule-created`.
- **Change** (`PATCH /:id`): 400 "At least one field is required" without a known field; 404 "Could
  not find role mapping rule"; then the checks of create with the new values. The type can change.
  For a new type or a new order, the rule keeps its order value; when another rule of the type has
  that value: 409 `A role mapping rule already exists with type "<type>" and order <n>. Use a
  different order value.` Then the rules of each changed type close their gaps, in their order: so
  an order that no rule has, also a negative one or one after the end, moves the rule to the start
  or the end. Event `role-mapping-rule-updated` with the new type and the fields of the body, in
  the order expression, role, type, order, projectIds.
- **Move** (`POST /:id/move`): the rule goes to the place `targetIndex` (or the end), and the rules
  of its type get their order again. Event `role-mapping-rule-updated` with `patchedFields`
  `['order']`, also when the place does not change.
- **Delete** (`DELETE /:id`): the rules of the type close the gap. Event `role-mapping-rule-deleted`.
  The REST API gives `{ success: true }`; the public API gives the deleted rule.

Writes, which show in `updatedAt`: create and move write every rule of the type; a change writes the
rule only when a value changed, and writes every rule of a type that has to close a gap; delete
writes the other rules only when it leaves a gap.

### Managed roles and deleting a role

- `isInstanceRoleManaged()`: the instance role from claims, or expression mapping and at least one
  instance rule. `isProjectRoleManaged()`: the same for project roles. They do not check the licence.
  The user service and the project controllers use them (403 for manual changes).
- At its start, the module registers `ProvisioningRoleDeletionChecker` with the
  `RoleDeletionCheckProxy`: a role that rules give cannot be deleted ("referenced by 1 role mapping
  rule", "referenced by 2 role mapping rules").

### An SSO sign-in

The SSO service calls the provisioning in two steps.

1. **Before n8n links or creates the user**: it resolves the roles. When the resolved instance role
   is `block:access`, the sign-in stops with `SsoAccessDeniedError`, and nothing changes. The OIDC
   callback then sends `user-login-failed` without a reason and redirects to
   `/signin?ssoError=access-denied`. The owner is refused too.
2. **After n8n links or creates the user**: it applies the roles. A failure here (for example the
   only admin of a project who becomes a chat user, or a custom role without its licence) fails the
   sign-in after the link.

**Direct claims** (`scopesProvisionInstanceRole`, `scopesProvisionProjectRoles`): the claims come
from the id token only, with the claim names of the config. For SAML, they are the attributes with
these names, as the ordinary `getMappedSamlAttributesFromFlowResult` gives them: the instance role
when it is a single value, and the project roles as a list, also for a single value.

- The instance claim must be the slug of a role of the role type `global` other than `global:owner`.
  Else the default role applies; without a default role nothing changes.
- The project claim is a list of `<project id>:<role>`, for example `abc:editor`, where
  `project:<role>` is a role of the role type `project` and the id is a team project. n8n skips an
  entry that is not valid. A list without a valid entry, and an empty list, change nothing. For a
  project in the list twice, the last valid entry counts. The user gets exactly the team project
  roles of the valid entries and leaves the other team projects.

**Expression mapping** (`scopesUseExpressionMapping`):

- The expressions read `$claims` (the claims of the id token and of userinfo; userinfo wins), `$oidc`
  (`idToken` and `userInfo`) and `$provider` (`oidc`). These are deep copies, made once for a
  sign-in, so a value that a rule changes, the later rules read, but the sign-in does not. For SAML,
  `$claims` and `$saml.attributes` are the raw attributes of the response, and `$provider` is
  `saml` (see [the SAML sign-in](../sso-saml/FORK.md#the-assertion-consumer-service)).
- An expression evaluates as `Expression.resolveWithoutWorkflow` of `n8n-workflow` does (tournament,
  with only a few globals such as `Math`). It matches when the result is `true` or the text `true`.
  An expression that does not evaluate does not match.
- The first instance rule that matches gives the instance role; the later instance rules do not run.
  Without a match: the default role, else `global:member`. With `block:access`, the sign-in stops,
  also without rules. The instance role changes only when instance rules exist.
- For each project, the first project rule that matches and names the project gives the role. When
  project rules exist, the user gets exactly these team project roles.
- The event `expression-mapping-roles-resolved` comes after the changes. Its `changed` is true when
  instance rules exist and the role differs, also for the owner, whose role does not change.

**For both**: the global role changes through `UserService.changeUserRole` (so a chat user loses
the shared projects), never for the owner, and with the event `sso-user-instance-role-updated`. Then
the project roles change, without licence checks, and the event `sso-user-project-access-updated`
counts the target projects (`projectsAdded`) and the projects that the user left
(`projectsRemoved`), when one of them is not 0. The user object of the sign-in keeps its old role,
so the `user-logged-in` event shows it.

**The OIDC authorization request**: with direct claims, the scope is `openid email profile`, then
the scope name of the config (also when it is empty), then the extra scopes of the OIDC config. The
connection test uses the same scope.

## Clean-room sources

- The ordinary callers: the user service, the project controllers, the public API controllers of
  the rules and of the projects, the instance settings loader and its tests, the test server, and
  the module registry.
- The DTOs and constants in `@n8n/api-types`, the entity `RoleMappingRule`, its migration and
  repository, the relay event map, the role deletion proxy, the pub/sub event map, and the licence
  state (`isProvisioningLicensed`).
- The ordinary tests of the rules, the config, the public API, the users, the projects, the role
  service and the SAML account linking.
- The editor: the REST clients, the provisioning store and form, and the expression input, which
  shows the names of the expression context.
- The public n8n documentation of OIDC and SAML role provisioning.
- The behaviour of the original files, recorded black-box by the golden test (below).

The enterprise files and their tests were not read, and the enterprise tests were not run on the
fork code, as the repository owner chose. There were two slips:

1. A search put an include glob after the exclusions, and printed 14 lines of 5 enterprise files:
   rule expressions and `$provider` values in 3 enterprise tests, the types of `$claims` and
   `$provider` in `role-resolver-types.ts`, and how `claims-context.builder.ts` builds `$claims` for
   OIDC and SAML. The fork's expression context comes from the probes of the golden test, which
   record the same facts. Since then, searches use a wrapper that puts the exclusions last.
2. A lint call named the folder `sso-oidc`, so it also linted the two enterprise OIDC tests and
   printed about 35 of their warnings: rule names, line numbers and two type names. Since then, lint
   calls name only files without `.ee`.

## The golden test

`__tests__/provisioning.integration.test.ts` runs the endpoints, the public API, the service, the
start of the module, the deletion check and OIDC sign-ins on a real database, with a fake OIDC
provider (nock, RS256 keys). Its 7 parts cover:

- the config endpoints: each role and licence, many bodies and default roles, merges, the deletion
  of project rules, multi-main, and stored rows of each kind;
- the rule endpoints: each role and licence for each endpoint, and many bodies for create, list,
  change, move and delete, with the rules that each case wrote;
- the public API of the rules, and the deletion of custom roles;
- the service: the managed checks for each mode and set of rules, the first read, the environment
  values, rows of each kind, `init()`, and the reload command in each instance role;
- the start of the module for each licence and instance type;
- OIDC sign-ins: the scope, direct claims of each kind (also project claims with valid and not valid
  entries), expression mapping with instance and project rules, default roles, refused sign-ins,
  the order of the checks, and about 80 probes of the expression context and of how an expression
  evaluates.

For each case, the snapshot records the result, the events, the pub/sub commands and the rows that
changed. Where n8n gives no fixed order (rules with the same order value, the projects of a rule),
the test sorts.

The snapshot was recorded against the original files. The fork files give the same snapshot. The
fork no longer has the original files. To record the snapshot again after an upstream update, record
it in a checkout of upstream n8n, as FORK.md tells ("Upstream updates"), with the imports of the
code under test at the `.ee` files (`@/modules/provisioning.ee/...` and
`@/modules/sso-oidc/oidc.*.ee`). In the fork, the recording also needed `vi.mock` redirects from the
fork paths that ordinary code imports to the `.ee` files. Upstream code imports the `.ee` files, so
a recording there needs no redirects.

## Notes

- The fork deleted the files of `provisioning.ee` and their tests in step 4. Before, container CI
  left out their 9 tests.
- No lint allowlist or code-health baseline changes. The queries are in
  `database/provisioning-rule.repository.ts`, not in the services.
