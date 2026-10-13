# The fork's project service

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md) and
[packages/cli/src/permissions/FORK.md](../permissions/FORK.md).

`project.service.ts` holds `ProjectService`, the service that lists, creates, changes and deletes
projects and their members. It replaces the enterprise `project.service.ee.ts` for all ordinary
code. This is the second pull request of step 3.

## Behaviour

### Scope checks

- `getProjectWithScope(user, projectId, scopes, trx?)` gives the project when the global role of
  the user holds all `scopes`, or when the role of the user in the project holds all of them.
  Else it gives `null`, also for a missing project. An empty `scopes` list never passes.
- `getProjectIdsWithScope(user, scopes, projectIds?)` gives the ids of those projects, out of
  `projectIds` when given. An empty `projectIds` list gives none. Through a project role, it gives
  only team projects: the callers add the personal project themselves.
- `findProjectsByIdsForUser(user, projectIds, scopes)` gives the projects with these ids where the
  user holds all `scopes`, personal projects too, in the order of creation.
- `getProjectScopesForUser(user, projectId)` gives the global scopes of the user and the scopes of
  their role in the project. `addUserScopes(user, projects)` adds the role and the scopes of the
  user to each project: the project role when there is one, else the global role.

### Reading

- `getProject` throws when the project is missing. `findProject` gives `null`.
- `getPersonalProject`, `getProjectRelationsForUser`, `getProjectRelations`,
  `findUserIdsByProjectId`, `findProjectsWorkflowIsIn`, `findExistingProjectIds` (a `Set`) and
  `getProjectCounts` read the database without an access check.
- `getProjectMembersAndCount(projectId, { offset, limit })` gives a page of the members, in the
  order that they joined the project.
- `getImplicitProjectMembers(project)` gives the enabled instance owners and admins of a team
  project. A personal project has none.
- A user whose global role holds `project:read` sees every project in `getAccessibleProjects`,
  `getAccessibleProjectsAndCount` and `getShareableProjectsAndCount`. Other users see the projects
  where they have a role. `getShareableProjectsAndCount` adds the personal projects of all users.
- `getMyProjects(user)` gives the projects where the user has a role, with that role and the
  scopes. With the global `project:read` scope, it adds the other team projects with the global
  role. `getProjectsAndCount` gives a page of all projects, for the public API.

### Changing projects

- `createTeamProject` adds the project and makes its creator the project admin, in one
  transaction (`ProjectRepository.insertTeamProjectWithAdmin`). At the team project quota it
  throws `TeamProjectOverQuotaError`. An id that is in use gives a `ConflictError` (409). It emits
  `team-project-created`.
- `updateProject` changes the name, icon, description or custom telemetry tags. It trims the keys
  of the tags, except for a package import (`preserveCustomTelemetryTags`). It emits
  `team-project-updated`, also when nothing changes.
- `deleteProject(user, projectId, { migrateToProject? })`:
  1. A migration to the same project is a `BadRequestError`.
  2. The user needs `project:delete` in the project, else `ProjectNotFoundError`. A personal
     project gives a `ForbiddenError`.
  3. For a migration, the user needs `credential:create`, `workflow:create` and
     `dataTable:create` in the target project, else `NotFoundError`. A personal target project
     cannot get end-user credentials (`BadRequestError` with their names).
  4. With a migration, the workflows and credentials that the project owns get the target project
     as owner. A share with the target project becomes ownership. The folders and the resources
     of modules (data tables) move too. Shares with the deleted project go with it.
  5. Without a migration, the workflows and credentials of the project are deleted one at a time
     through their services, so a published workflow stops the deletion part of the way. Then the
     resources of modules are deleted.
  6. When the external secrets module is active, the same transaction as the project deletion
     deletes the secrets provider connections that the project owns, disables the connections
     that it uses, and removes its access rows.
  7. It emits `team-project-deleted`.

### Changing members

All member methods work on team projects only. A missing or personal project gives
`ProjectNotFoundError`. A role that does not exist gives a `BadRequestError`. A role that is not
licensed gives `UnlicensedProjectRoleError`, except a role that the user has in the project
already. Instance owners and admins reach every project, so the methods leave them out or refuse
to change them. The methods emit `team-project-updated` with all members of the project.

- `addUsersToProject` adds users or changes their role. It refuses the personal owner role.
- `addUsersWithConflictSemantics` adds only new users. A member with another role is a conflict.
- `syncProjectRelations` replaces all members. It emits no event.
- `changeUserRoleInProject` refuses the personal owner role and instance owners and admins. A user
  outside the project gives `ProjectNotFoundError`.
- `deleteUserFromProject` refuses instance owners and admins and a personal owner relation.
- `addUser` adds a user or changes their role, without checks.

## Clean-room sources

- The ordinary code that calls the service: 69 files, and the controllers that turn its errors
  into status codes.
- The ordinary tests: `test/integration/project.api.test.ts`,
  `test/integration/public-api/projects.test.ts`, `test/integration/services/project.service.test.ts`,
  `test/integration/project.service.integration.test.ts`,
  `test/integration/external-secrets/project-deletion.api.test.ts` and
  `src/controllers/__tests__/project.controller.test.ts`.
- The ordinary repositories and services that the service uses, for example
  `ProjectRepository`, `ProjectRelationRepository.findAllByUser` and `RoleService`.
- The behaviour of the original service, recorded black-box by
  `__tests__/project.service.integration.test.ts` (below).

The enterprise file and its tests were not read. In step 2, a search printed 6 lines of
`project.service.ee.ts` by mistake ([sreent/n8n#13](https://github.com/sreent/n8n/pull/13)). They
named types and one helper that this service does not use.

## The golden test

`__tests__/project.service.integration.test.ts` calls the service on a real database. The fixture
has 12 users (owner, admins, members, a chat user, a pending user and custom global roles), team
and personal projects with built-in and custom project roles, owned and shared workflows and
credentials, end-user credentials, folders, data tables and secrets provider connections.

- The reading test calls each reading method for each user and project: about 3,600 calls.
- The changing test seeds the fixture again for each of 205 cases. It covers each changing
  method, the licence states, the team project quota, the external secrets module, and the order
  of the checks.

For each call, the snapshot records the result, the error (class chain, message, status code),
the events, the calls to `ActiveWorkflowManager`, and each row that the call adds to or removes
from any table. Ids become labels and dates become placeholders.

The snapshot was recorded against the original service. The fork service gives the same snapshot.
The fork no longer has the original file. To record the snapshot again after an upstream update, use
a checkout of the upstream commit in `scripts/sync-upstream.base`: copy the test there, point its
import at `@/services/project.service.ee`, run it with `-u`, and use its snapshot.

## Notes

- The fork deleted `project.service.ee.ts` and its test in step 4.
- The CLI lint allowlist for `EntityManager` imports from `@n8n/db` lists this file: the
  `trx` parameters of `getProjectWithScope` and `addUser` keep the type that their callers pass.
  Remove the entry when they become an `OperationContext`. The migration in `deleteProject` uses
  `ProjectRepository.runInTransaction`, because `makeOwner`, the folder transfer and the module
  handlers take an `EntityManager`, as in `OwnershipTransferService`.
- `TeamProjectRepository` (`packages/@n8n/db/src/repositories/team-project.repository.ts`) holds
  the two transactions: the replacement of the members and the project deletion. For the secrets
  provider connections, it uses the fork repositories of the connections and their `target`, so
  the rollback tests of `project-deletion.api.test.ts` still apply.
