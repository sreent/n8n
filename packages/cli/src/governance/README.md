# Governance routes of the public API

Fork code (not in upstream n8n). These routes help the owner and the admins review the instance:
what users build, who has API keys, and which accounts nobody uses. They use the services and the
repositories of upstream n8n. They add no table and no module.

| Route | API key scopes | What it gives |
|---|---|---|
| `GET /api/v1/inventory/workflows` | `workflow:list` and `execution:list` | Each workflow with its status, home project, owner, shares, node types, credentials, triggers and newest executions |
| `GET /api/v1/api-keys` | `apiKey:manage` | The API keys of all users, with the user, the scopes, the expiry and the last use |
| `GET /api/v1/users`, `GET /api/v1/users/{id}` | `user:list`, `user:read` (upstream) | The field `lastActiveAt` (fork) |

## The inventory of workflows

`WorkflowInventoryService` (`workflow-inventory.service.ts`) and
`InventoryPublicController` (`../public-api/v1/controllers/inventory.public.controller.ts`).

- Each user gets the workflows that the user can read (`workflow:read`). The owner and the admins
  get all workflows, also the workflows in personal spaces.
- Query: `projectId` (the workflows of the project and the workflows shared with it), `executions`
  (0 to 20, default 5), `limit` (1 to 100, default 50) and `cursor`.
- The route sorts by workflow id. The ids are random, so the order is stable, but it is not the
  order of creation.
- `status` is `archived`, `published` (the workflow has an active version) or `unpublished`.
  `hasUnpublishedChanges` is true when the saved version is not the published version.
- `owner` is the user of the personal space that owns the workflow. It is null for a workflow of a
  team project.
- `nodeTypes`, `credentials` and `triggers` come from the saved version, not from the published
  version.
- `credentials` gives the id, the name and the type that the nodes reference, each once. It never
  gives credential data.
- `triggers`: the description of the node type decides. When the instance does not have the node
  type (for example, a removed community node), the name of the type decides.
- `recentExecutions` gives the newest executions of each workflow, newest first. The service makes
  one query for each workflow, 10 workflows at a time, so that a busy workflow does not push out
  the executions of the other workflows.

## The list of API keys

`ApiKeyReviewService` (`api-key-review.service.ts`) and `ApiKeysPublicController`
(`../public-api/v1/controllers/api-keys.public.controller.ts`).

- Only the owner, the admins and a custom role with the option **API keys: Manage all** can use the
  route. The key needs the scope `apiKey:manage`, and the user needs the global scope
  `apiKey:manage`. So a member gets 403, also with the scope on the key.
- `apiKey:manage` is an upstream scope. The fork adds it as an API key scope (see
  [packages/@n8n/permissions/FORK.md](../../../@n8n/permissions/FORK.md#fork-scopes)).
- Query: `userId`, `audience` (`public-api` or `mcp-server-api`), `limit` (1 to 250, default 100)
  and `cursor`. The route sorts the keys newest first.
- The response never gives the value of a key.
- `expiresAt` comes from the key itself (a JWT). `expired` is true when that time is past. n8n
  rejects an expired key.
- `lastUsedAt`: n8n saves the time when a key signs in, at most once a minute. An expired key does
  not sign in, so its `lastUsedAt` does not change.
- A key of the MCP server has the audience `mcp-server-api` and no scopes.

## The last activity of users

- `GET /api/v1/users` and `GET /api/v1/users/{id}` give `lastActiveAt`: the day of the last
  request of the user (`YYYY-MM-DD`, in the time zone of the server), or null when the user never
  signed in.
- `LastActiveAtService` saves the day at most once a day, on requests to the REST API and to the
  public API.
- To find unused accounts, list the users, and look for an old day or null. Compare with
  `createdAt`, so that you do not flag a new user.

## A weekly report

`deploy/workflows/governance-report.json` is an n8n workflow that uses the three routes. Each
Monday at 08:00, in the time zone of the instance, it reads all pages of each route and sends a
report by email:

- the published workflows in personal spaces;
- the published workflows with failed executions in their last 5 executions;
- the published workflows with unpublished changes;
- the expired API keys, and the API keys that nobody used for 90 days;
- the users who were not active for 90 days, and the invitations that are open for more than
  14 days.

The node **Settings** holds the URL of the API, the addresses and the numbers of days. The three
**Get** nodes use an **n8n API** credential. Its key needs the scopes `workflow:list`,
`execution:list`, `apiKey:manage` and `user:list`, so only the owner, an admin or a custom role
with these scopes can make it. The node **Build report** writes the report as text and as HTML.
The report never holds the values of API keys.

## Changes outside this folder

- `packages/@n8n/api-types/src/dto/workflows/workflow-inventory-public.*.ts` and
  `packages/@n8n/api-types/src/dto/api-keys/api-key-review-public.*.ts`: the types and the OpenAPI
  docs of the two routes.
- `packages/cli/src/public-api/v1/controllers/inventory.public.controller.ts` and
  `api-keys.public.controller.ts`, and their imports in `controllers/index.ts`.
- `packages/cli/src/public-api/v1/openapi.yml`: the tag `ApiKey`. The cli build writes the specs of
  the routes (`*.generated.yml`).
- `packages/cli/src/public-api/v1/shared/services/offset-page.ts`: `assertOffsetPage` takes the
  largest page size of the route.
- The upstream files `packages/@n8n/api-types/src/dto/user/user-public.dto.ts` and
  `packages/cli/src/public-api/v1/controllers/users.public.controller.ts`: the field
  `lastActiveAt`.
- `packages/@n8n/permissions/src/fork-scopes.ts`: the API key scope `apiKey:manage`. The API key
  modal of the editor shows it
  (`packages/frontend/editor-ui/src/features/settings/apiKeys/apiKeys.constants.ts`).

## Tests

- `packages/cli/test/integration/public-api/workflow-inventory.test.ts`
- `packages/cli/test/integration/public-api/api-keys-review.test.ts`
- `packages/cli/test/integration/public-api/users-last-active.test.ts`
- `packages/@n8n/permissions/src/__tests__/fork-scopes.test.ts`
- `deploy/workflows/governance-report.test.mjs`, for the report workflow. Run it with
  `node --test deploy/workflows/governance-report.test.mjs`.
