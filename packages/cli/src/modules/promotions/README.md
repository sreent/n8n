# Git connections (promotions)

Fork module (not in upstream n8n). It is a clean-room rebuild of the Git connections of the n8n
Enterprise Edition: the code calls them promotions. An instance promotes its team projects to a
Git branch, and another instance applies the branch. The module gives the 23 routes of the public
API under `/api/v1/promotions`.

The sources of the rebuild are the ordinary code of n8n (the public API controller, the DTOs of
`@n8n/api-types`, the migrations, the `@n8n/cli` client and its documentation
`packages/@n8n/cli/docs/commands/promotions.md`, the package engine of
`packages/cli/src/modules/n8n-packages`), and the behaviour of the original module. Black-box
golden tests recorded that behaviour through the public API (see "Tests").

## Turn it on

- The licence value `feat:gitConnections`. The fork switch gives it
  (`packages/cli/src/fork-features.ts`).
- The module: `N8N_ENABLED_MODULES=promotions`. It is not a default module, as in upstream n8n,
  and `deploy/` sets it. Without it, the routes answer 503 `Promotions module is not enabled`.
- The editor of Git connections (the settings page "Environments v2", which upstream n8n shows
  with `N8N_ENV_FEAT_PROMOTIONS=true`) is not in the fork yet. Use the public API.

The scopes `gitConnection:*` control the routes. The owner and the admin have all nine scopes. A
member has none of them.

## Parts

| Part | What it is | Table |
|---|---|---|
| Provider | The credentials for a Git host: an SSH key pair that n8n makes, or a username and a password for HTTPS. | `promotion_provider` |
| Connection | A remote URL and a provider. One `instance` connection at most, and any number of `projects` connections. | `promotion_connection` |
| Configuration | One for each direction of a connection. `apply` has a branch. `promote` has a base branch and `createBranchOnPromotion`. | `promotion_config` |
| Project link | A team project that uses a `projects` connection. A project has one link at most. | `promotion_connection_project` |
| Checkout | The local Git checkout of a configuration, on the instance that does the clone. | files |

## Providers

- `type` is `git`. `authType` is `ssh-key` or `token`. `token` is a username and a password for
  HTTP(S).
- For `ssh-key`, n8n makes the key pair: `ed25519` (the default) or `rsa` with 4096 bits. The
  public key has the OpenSSH format and the comment `n8n promotions`. The answer of the create
  gives it in `publicKey`, and `config` keeps it with `keyType`.
- The `config` of a `token` provider is `{ "schemaVersion": 1 }`. The `config` of an `ssh-key`
  provider is `{ "schemaVersion": 1, "publicKey", "keyType" }`.
- The column `auth` keeps the private key, or the username and the password, encrypted with
  `cipher.encryptV2`. No answer gives it.
- An update with `auth` of type `ssh-key` makes a new key pair. Without `keyType`, the new key has
  the type of the old key. An update cannot change the authentication method:
  `A provider cannot change its authentication method. Create another provider instead.` (400).
- A provider that a connection uses cannot be deleted: `This provider is used by a connection`
  (409).
- An unknown provider: `Promotion provider not found` (404).
- The list is in the order of the id. The page has `limit` (100 by default, 250 at most) and an
  offset cursor. `limit=0` gives no rows and no cursor. A bad cursor gives
  `An invalid cursor was provided` (400).

## Connections

- `scope` is `instance` or `projects`, and it cannot change.
- A second instance connection: `An instance promotion connection already exists` (409). A
  partial unique index of the table makes this safe when two requests come at the same time.
- An unknown connection: `Promotion connection not found` (404).
- The list is in the order of the id, with the filters `scope` and `providerId`. A row of the list
  has its configurations without `checkout`. The answer of one connection gives `checkout` for each
  configuration.
- A change of the provider checks the URL again with the new provider. When the check fails,
  nothing changes.
- A delete removes the configurations, the project links and the checkouts. The provider stays.

### Remote URLs

n8n trims the URL. Then it checks the URL against the authentication method of the provider:

| Provider | URL | Answer |
|---|---|---|
| `token` | `http://` or `https://` with a host | accepted |
| `token` | a URL with a username or a password | `Remote URL must not contain credentials` (400) |
| `token` | another protocol: `git://`, `file://`, `ssh://` | `Username and password providers require an HTTP(S) remote URL` (400) |
| `token` | not a URL: `git@host:path`, `host/path`, `-u…` | `Remote URL must be a valid HTTP or HTTPS URL` (400) |
| `ssh-key` | `ssh://[user@]host[:port]/path`, `[user@]host:path` with a path | accepted |
| `ssh-key` | `ssh://` with a password | `Remote URL must not contain credentials` (400) |
| `ssh-key` | another form: `https://…`, `host:` with no path, `ext::…` | `SSH key providers require an ssh:// or [user@]host:path remote URL` (400) |

## Configurations

- The route names the direction. An unknown direction: `Unknown promotion direction: <direction>`
  (404).
- An upsert replaces the whole configuration and keeps its id. Without `name`, the name is
  `Apply` or `Promote`. Two first writes at the same time give one 200 and one 409.
- n8n checks each branch name with `git check-ref-format --branch <name>`. A bad name:
  `Invalid Git branch name: <name>` (400).
- The answer gives `checkout`: `hasCheckout` (this instance has a checkout) and `matchesConfig`
  (the checkout has the remote URL and the branch of the configuration).
- A delete removes the configuration and its checkout. Nothing changes in Git.

## Project links

- Only a `projects` connection has links:
  `Only a project-scoped connection can have project links` (400).
- Only a team project can have a link:
  `Only team projects can be linked to a promotion connection` (400). An unknown project:
  `Project not found` (404).
- A project that has a link to another connection:
  `This project is linked to another promotion connection` (409), also for a removal through the
  wrong connection. A link that exists already gives 200 again. A removal of no link gives 204.

## Checkouts

Each configuration has a folder `<n8n folder>/promotions/configs/<configuration id>/`:

- `repository/`: the Git checkout.
- `cache.json`: `{"schemaVersion":1,"connectionId","configId","remoteUrl","checkoutBranchName"}`.
  `matchesConfig` compares it with the connection and the configuration.
- `.ssh/known_hosts`: the host keys that SSH accepted (`StrictHostKeyChecking=accept-new`).

The clone:

1. n8n checks that the remote has the branch (`git ls-remote --heads`). When it does not:
   `Remote branch does not exist: <branch>` (400).
2. n8n removes the old checkout and makes a new one:
   `git clone --single-branch --branch <branch> --no-tags`.
3. n8n writes `cache.json`.

A disconnect removes `repository/` and `cache.json`. The folder and the known hosts stay. The
answer of a clone or a disconnect is `{ connectionId, configId, direction, branchName,
hasCheckout }`. A disconnect of a configuration without a checkout gives 200 too.

### Git

- Git runs with `PATH=/usr/bin:/bin` and `GIT_TERMINAL_PROMPT=0`, as in source control.
- For SSH, `GIT_SSH_COMMAND` gives `ssh` the private key in a temporary folder
  (`/tmp/n8n-promotions-XXXXXX/private-key`), the known hosts file of the configuration and
  `StrictHostKeyChecking=accept-new`. n8n removes the temporary folder after the call.
- For HTTPS, n8n gives the username and the password to Git through `GIT_ASKPASS`, not in the URL.
- When a Git call fails, the answer is `Could not complete the Git operation` (400). The log has
  the details.

## Operations

Each operation finds its connection and its configuration first, and checks them in this order:

1. A connection that the route names must exist: `Promotion connection not found` (404).
2. The configuration of the direction must exist: `This connection has no <direction>
   configuration` (404).
3. Promote and Apply work on the instance connection only: `Promote is only available on the
   instance connection. Project connections are not supported yet.` (400), and the same for Apply.
4. The checkout must exist and match the configuration (`matchesConfig`):
   `This promote configuration is not cloned. Clone it before promoting.` (400), and
   `This apply configuration is not cloned. Clone it before applying.` (400).

The routes of a project (the change list and the selective promotion) find the connection of the
project:

1. The project must exist: `Project not found` (404). It must be a team project:
   `Only team projects can use a promotion connection` (400).
2. A project with a link uses its own connection. Another project uses the instance connection.
   Without a connection: `No promotion connection is configured for this instance` (404).
3. The configuration of the direction must exist: `The promotion connection for this project has
   no <direction> configuration` or `The instance promotion connection has no <direction>
   configuration` (400).
4. A selective promotion also needs the instance connection (step 3 above).
5. The checkout must match the configuration: `This <direction> configuration is not cloned. Clone
   it before listing branch files.` (400) for a change list, and the message of step 4 above for a
   selective promotion.

Each configuration runs one operation at a time on this instance.

### Promote

1. n8n exports every team project to `n8n-export/` of the checkout with the package engine
   (`exportPackageToDirectory`), with the archived workflows. Personal projects stay out. The old
   folder goes first, so a deleted or moved workflow leaves the branch.
2. The export bundles the values of the variables that the workflows use. The API key needs the
   scope `variable:list` for this. Without it, the engine refuses the export (403).
3. n8n commits all changes. The author and the committer are the user who promotes. A promotion
   without a change still makes a commit.
4. n8n pushes the commit to the base branch, or to a new branch
   `n8n-promotion/<time>` (for example `n8n-promotion/2026-10-14T20-17-11-728Z`) when
   `createBranchOnPromotion` is on. n8n does not pull first. When the remote branch has other
   commits, the push fails (`Could not complete the Git operation`) and the commit stays in the
   checkout. `force` pushes over the remote branch.

The answer gives the counts of the export and `git: { commitSha, branchName }`.

### Selective promote

`POST /promotions/projects/{projectId}/promote` changes only the chosen workflows of one team
project, without a message `Promote a selection of project changes`:

- A chosen workflow that the project owns (also an archived one) goes to the branch with its
  current state, with its folders, credentials, variables, data tables and tags.
- A chosen workflow that the project does not own leaves the branch. It must be on the branch:
  `Deleted workflows not found on the branch: <ids>` (400). It must be in the folder of the
  project on the branch: `Deleted workflows do not belong to the selected project: <ids>` (400).
- The manifest keeps the other workflows. The workflows are in the order of their folders. The
  requirements lose the uses of the chosen workflows, and get the uses of the new export.
- The counts are the counts of the export of the chosen workflows.

### Change list

`GET /promotions/projects/{projectId}/changes/{direction}` fetches the branch, and compares the
package that a promotion of the project writes now (with the Git hashes of the files) with the
files of the branch:

| Status | `promote` | `apply` |
|---|---|---|
| `new` | on this instance only | on the branch only |
| `deleted` | on the branch only | on this instance only |
| `modified` | the workflow or a dependency differs (see below) | the workflow or a dependency differs (see below) |
| `renamed` | the folder of the workflow differs | the folder of the workflow differs |
| `renamed-and-modified` | both | both |
| `archived` | archived here, and modified | archived on the branch, live here, and modified |

A workflow is modified when its `workflow.json` differs, or when a dependency differs. The
dependencies are the credentials, data tables, tags and variables that the requirements of the
package give for the workflow:

- A credential, a data table or a tag differs when its folder in the package or its file differs:
  for example a new name, another owner project, a new type, an expression in the data of a
  credential, or a new column. Data that the package does not export (a password) does not count.
- A variable counts by its scopes: the package has a global variable with the name, a variable
  of the project of the workflow with the name, or both. For `promote`, other scopes are a
  change. For `apply`, only a scope that the branch has and this instance does not have is a
  change, because an apply keeps the variables of this instance. The id, the folder and the value
  of a variable do not count.
- `workflow-metadata.json` (the version ids), sub-workflows and node types do not count.

- A row has the name of this instance for `promote`, and the name of the branch for `apply`. A
  workflow that is on the branch only, for `promote`, has the name of its folder (`old-flow`).
- `version` and `updatedAt` come from the workflow on this instance (`versionCounter`), and are
  `null` when this instance does not have it. `updatedBy` is `null`.
- `dependencyCount` counts the credentials, data tables, sub-workflows, variables and tags of the
  workflow in the requirements of the package (of this instance for `promote`, of the branch for
  `apply`).
- `commitSha` is the commit that the rows come from.
- `search` keeps the rows whose name contains the text, in any case. `sort` is `name`, `status`
  (in the order of the words) or `updatedAt` (`null` first), and `order` is `asc` or `desc`. Rows
  with the same value are in the order of their names.
- A branch without `n8n-export/manifest.json` gives `Could not complete the Git operation` (400)
  for `apply`, and for `promote` when a workflow is on this instance and on the branch.

### Apply and Continue

1. n8n fetches the branch, and moves the checkout to the newest commit (`reset --hard`).
2. With `expectedSource`, a different configuration, branch or commit gives `source-changed`, and
   nothing changes. Continue always sends `expectedSource`.
3. The preflight reads the package and checks what its workflows need on this instance (see
   below). A missing binding, an access requirement or a conflict gives `blocked` with the
   `preflight`, and nothing changes.
4. n8n imports the package with the package engine (`importPackageFromDirectory`). The package is
   the source of truth: projects (names and settings), folders and workflows follow it. A workflow
   that the package does not have goes, and a folder that is empty then goes. Published workflows
   follow the publication of the source. Data tables that are missing are made. A tag with
   another name gets the name of the package. Existing variables keep their values. A content
   policy can refuse the whole package (422).
5. n8n deletes the team projects of this instance that the package does not have, with their
   workflows and credentials.

The answer `applied` has the counts of the import and the warnings of the preflight.

### Preflight

| Result | When |
|---|---|
| `missingProjects` | A project of the package is not on this instance. The apply makes it. This does not block. |
| `missingBindings` credential | A workflow uses a credential id that is not on this instance. The credential file of the package gives the owner project. |
| `missingBindings` variable | A workflow uses a variable of the package that is not on this instance, in the same scope. `sourceValue` is the value of the package. |
| `accessRequirements` | The credential is on this instance, but the project of the workflow cannot use it. |
| conflict `missing-id` | A node uses a credential without an id. |
| conflict `conflicting-types` | The nodes use one credential id with two types. |
| conflict `unknown-type` | This instance does not know the credential type. |
| conflict `unknown-owner` | The credential is missing, and the package has no owner project for it. |
| conflict `type-mismatch` | The credential on this instance has another type (`targetType`). |
| conflict `incompatible-usage-scope` | The credential on this instance is not for workflows. |
| conflict `missing-definition` | A workflow uses a variable that neither the package nor this instance has. |
| conflict `project-not-team` | A project of the package is a personal project on this instance. |
| warning `variable-shadowed` | The package has a global variable, and the project of the workflow has a variable with the same name on this instance. This does not block. |

## Differences from the original

None is known. The golden tests show the same behaviour for each recorded case.

## Tests

- The golden tests `promotions-setup`, `promotions-operations`, `promotions-edges` and
  `promotions-dependencies` in `packages/cli/test/integration/promotions` use a local Git server
  over HTTPS (`test/integration/source-control/git-http-server.ts`). They were recorded against
  the original module, and the fork gives the same snapshots.
- `packages/cli/test/integration/public-api/promotions.test.ts` is the upstream test of the public
  API, with the import paths of the fork module.
- `__tests__/` has unit tests of the URL check and of the merge of the manifest.

## Upstream updates

When an upstream update changes the public API controller
`packages/cli/src/public-api/v1/controllers/promotions.public.controller.ts`, keep the import paths
of the fork module (`@/modules/promotions/`). When it changes the n8n-packages engine or the DTOs
of `@n8n/api-types/src/dto/promotions`, run the golden tests.
