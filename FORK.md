# FORK.md

This repository is `sreent/n8n`, a private fork of `n8n-io/n8n`. This file is for agents and
people who work on the fork. Where it differs from `AGENTS.md`, this file wins.

The other documents of the fork:

- [README.md](README.md): what the repository holds, and where to start.
- [FORK-FEATURES.md](FORK-FEATURES.md): each enterprise feature of n8n, what the fork does about
  it, and the history of the fork.
- [FORK-UPSTREAM.md](FORK-UPSTREAM.md): the checklist for an upstream update.
- [deploy/README.md](deploy/README.md): how to run the fork.

## Feature freeze

The owner stopped new features in the fork on 2026-10-17. The fork gets only security fixes,
upstream merges and the fixes that these need. It keeps running for our organisation until a7c
can replace it. The owner accepted three exceptions after the freeze. All three are done
([FORK-FEATURES.md](FORK-FEATURES.md#history)).

a7c is a new product in `sreent/a7c`. Other companies will use it, so it contains no n8n code.
The licence of n8n allows changes for internal business use only (`LICENSE.md`).

## What the fork adds

A README or a FORK.md in the folder of each item describes it.

- **Git sync** and **Send a copy**: the backend modules `packages/cli/src/modules/git-sync` and
  `packages/cli/src/modules/send-copy`, and the frontend modules
  `packages/modules/git-sync/frontend` and `packages/modules/send-copy/frontend`.
- **Audit log**: the module `packages/cli/src/modules/audit-log` keeps the audit events of n8n for
  90 days. The page Settings > Audit log (`packages/modules/audit-log/frontend`) and the public
  API (`/api/v1/audit-log`) give them.
- **Log streaming**: the module `packages/cli/src/modules/log-streaming` sends the events of n8n to
  webhook, syslog and Sentry destinations. The page Settings > Log streaming
  (`packages/frontend/editor-ui/src/features/integrations/logStreaming`) manages them.
- **Open triggers**: the module `packages/cli/src/modules/open-triggers` finds the webhooks, forms,
  public chats and MCP servers without authentication. With `N8N_OPEN_TRIGGERS_NEED_APPROVAL=true`,
  a publish stops for a new open trigger until a workflow review approves it. The frontend module
  `packages/modules/open-triggers/frontend` offers one-click fixes and adds the page
  Settings > Open triggers.
- **Gateway credits**: the module `packages/cli/src/modules/ai-gateway` replaces the service of n8n
  Cloud. Users run AI nodes without an API key of their own. The gateway calls the provider (or
  Azure OpenAI or Vertex AI) with a credential of an admin, records the cost of each call and stops
  the calls when a budget is spent. The page Settings > Gateway credits admin
  (`packages/modules/ai-gateway/frontend`) manages it.
- **Google Cloud OCR**: the node `packages/nodes-base/nodes/Google/CloudOcr` reads the text of
  images and documents with the Cloud Vision API and Document AI.
- **Google Cloud Storage**: `@n8n/blob-storage` keeps binary data and execution data in a bucket of
  Google Cloud Storage, and signs in with a service account
  ([packages/@n8n/blob-storage/FORK.md](packages/@n8n/blob-storage/FORK.md#google-cloud-storage)).
- **Public API routes for reviews**: `/api/v1/insights/by-workflow`, `/api/v1/inventory/workflows`,
  `/api/v1/inventory/open-triggers`, `/api/v1/api-keys`, and the field `lastActiveAt` of
  `/api/v1/users` ([packages/cli/src/governance/README.md](packages/cli/src/governance/README.md)).
- **No registration and no licence keys**: the fork switch turns on the features
  ([packages/cli/src/license/FORK.md](packages/cli/src/license/FORK.md)).
- `deploy/`: runs the fork on a Linux server with Docker Compose, on Google Cloud Run, on Amazon
  ECS, on Azure Container Apps or on Kubernetes. It also has Forgejo (a private Git server for the
  Git features of n8n), the platform setup tool and a workflow that sends a weekly governance
  report.
- `vendor/`: the wa-sqlite package that the editor app installs. Upstream installs it from GitHub,
  which a cloud session cannot do. `scripts/vendor-wa-sqlite.sh` packs it from the upstream commit
  and gives the same file again.
- `scripts/container-ci.sh`, `scripts/sync-upstream.sh`, `scripts/cloud-install.sh` and
  `scripts/build-images.sh`: CI, upstream updates, installs in cloud sessions, and the Docker
  images.

## Enterprise code

n8n keeps its enterprise code in `*.ee.*` files and `*.ee/` folders. The n8n Enterprise License
(`LICENSE_EE.md`) covers this code, and production use of it needs a paid licence. The rest of
n8n is under the Sustainable Use License (`LICENSE.md`), which allows changes for internal
business use.

The fork has no enterprise code. It removed the code and built its own versions of the features in
five steps:

1. The rules and the tooling, and the removal of the enterprise modules that do nothing without a
   licence.
2. Our own permission core: scopes, roles and `hasScope`
   ([packages/@n8n/permissions/FORK.md](packages/@n8n/permissions/FORK.md)).
3. Our own scope check, project service, sharing services, execution view and sharing UI.
4. Our own versions of the other enterprise features, and the removal of the rest of the
   enterprise code.
5. The fork switch, which turns on the rebuilt features (see "The fork switch").

[FORK-FEATURES.md](FORK-FEATURES.md) lists each enterprise feature with its status, its fork code
and its document. Its section "History" tells the order and the dates of the steps.

`scripts/removed-enterprise-paths.txt` lists the removed areas. `scripts/sync-upstream.sh` deletes
them again after each upstream update, and container CI checks that they stay deleted.

## The fork switch

`packages/cli/src/fork-features.ts` lists the licence values of the features that the fork turns
on. `License` (`packages/cli/src/license.ts`) gives them while `N8N_FORK_FEATURES_ENABLED` is
`true`, the default. With `N8N_FORK_FEATURES_ENABLED=false`, the licence decides, as in upstream
n8n. The licence checks of ordinary code stay.
[FORK-FEATURES.md](FORK-FEATURES.md#licence-features) tells which features the switch turns on.

Some features also need a setting, as in upstream n8n:

| Feature | Also needs | Set by `deploy/` |
|---|---|---|
| Git connections | `N8N_ENABLED_MODULES=promotions`, and `N8N_ENV_FEAT_PROMOTIONS=true` for the editor | Yes |
| Dynamic credentials | `N8N_ENV_FEAT_DYNAMIC_CREDENTIALS=true` for the resolvers, the hooks and the check node | Yes |
| Token exchange | `N8N_ENV_FEAT_TOKEN_EXCHANGE=true`, then `N8N_TOKEN_EXCHANGE_ENABLED=true` with trusted keys | No |
| Multiple main instances | Queue mode and `N8N_MULTI_MAIN_SETUP_ENABLED=true` | In queue mode, not on the VM |
| Worker view | Queue mode | In queue mode, not on the VM |
| Worker pools | Queue mode and `N8N_WORKER_POOLS_ENABLED=true` | No |
| Evaluation collections, config evaluations and agent evaluations | `N8N_EVAL_COLLECTIONS_ENABLED=true`, `N8N_CONFIG_EVALS_ENABLED=true` and `N8N_AGENT_EVALS_ENABLED=true`. They follow the feature flags of n8n, which come with the telemetry. Without the telemetry, only the variables turn them on. | Yes |
| More than one parallel case of an evaluation | `N8N_CONCURRENCY_EVALUATION_LIMIT`. Without it, the cases run one at a time. | Yes, 5 |
| Gateway credits | A credential of a provider, and the switch on the page Settings > Gateway credits admin | No |
| The banner of a non-production instance | `N8N_FORK_NON_PRODUCTION_BANNER=true`. The banner is not in the list, so it is off by default. | No |

The cli tests set `N8N_FORK_FEATURES_ENABLED` to `false`
(`packages/cli/test/setup-fork-features.ts`), so the upstream tests run with the fork features
off. A fork test that needs them on sets `ForkFeaturesConfig.enabled`. A test or the e2e
controller that replaces `License.isLicensed` replaces the switch too.

## Rules

- **No new features.** Do not add fork features (see "Feature freeze"). Put new work in a7c. Do
  not copy code from this fork into a7c.
- **Uniformity.** Build fork code as core n8n builds its code: the same stack, module
  architecture, patterns, design system and copy rules (`AGENTS.md`, the module guides and
  `.agents/skills`). When a safety default of the fork changes a core flow, the editor tells the
  user why and offers the fix at that place.
- **Clean room.** Do not open, read, edit, copy or search the contents of enterprise files
  (`*.ee.*` files and `*.ee/` folders), also not their build output in `dist/`, the Git history
  or upstream. Exclude them from searches, for example
  `rg <pattern> -g '*.ts' --glob '!*.ee.*' --glob '!**/*.ee/**'`. Put the exclusions last: in
  ripgrep, the last glob that matches a file wins. To remove enterprise code, work with the file
  names and with the ordinary code that uses them. To build a replacement, use the public n8n
  documentation, the ordinary code and the behaviour of a running n8n.
- **Licence checks.** Keep the licence checks of ordinary code. The fork turns on a feature with
  its licence value in `packages/cli/src/fork-features.ts`, not by removing a check. Add a feature
  to that list only when the owner chooses it.
- **Permission scopes.** The scope list and the role maps are fork code. They come from a running
  n8n through `scripts/permission-snapshot.mjs`. Do not edit
  `packages/@n8n/permissions/src/permission-data.generated.ts` by hand. A fork feature that needs a
  scope adds it as packages/@n8n/permissions/FORK.md tells.
- **Notices.** Keep `LICENSE.md` and `LICENSE_EE.md`. This file and `README.md` are the notice that
  the fork changes n8n. Use the fork for internal business use only.
- Keep the changes to upstream files small. Each upstream update must merge them again.
- Open pull requests as ready for review, not as drafts.

## Cloud sessions

- The repository needs Node 24 and pnpm 12. The scripts in `scripts/` install them in
  `/opt/node24` when they are missing (`scripts/cloud-node.sh`), so the environment needs no
  setup script. Put `/opt/node24/bin` first on the `PATH`.
- Install the dependencies with `scripts/cloud-install.sh`, not with `pnpm install`. In a cloud
  session, a plain install fails on `@vscode/ripgrep`. The script also stops with a clear error
  when a repository that it downloads from is not attached.
- GitHub Actions is off in this fork. Run `scripts/container-ci.sh` before you push. Use
  `--plan` to see which tests it selects. It leaves out the test files in
  `scripts/container-ci-skipped-tests.txt` (none now). It runs the integration tests with 2
  workers, because more time out on the 4 CPUs of a cloud session. When `deploy/` changes, it also
  runs the Node.js tests of `deploy/`. The tests of the Helm chart need Helm, and the tests of the
  Terraform modules need Terraform: run them by hand, as the READMEs of `deploy/` tell.

## Docker images

- `scripts/build-images.sh` builds the n8n image and the task runners image that `deploy/` runs.
  The tags are `<n8n version>-<commit>` and `latest`. Build from `master`, after the merge.
- `scripts/build-images.sh --push` also pushes the images to `ghcr.io/sreent`. It reads
  `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` (a personal access token (classic) with the
  `write:packages` scope) from the environment. Set them in the environment settings. Do not put
  the token in a chat or a command.
- In a cloud session, start the Docker daemon (`dockerd`) in the background first. The script
  handles the session proxy and the pull limits of Docker Hub.

## Upstream updates

- `scripts/sync-upstream.sh master` merges the newest upstream code into the current branch.
  Then work through [FORK-UPSTREAM.md](FORK-UPSTREAM.md), run `scripts/container-ci.sh --fork`,
  and open a pull request.
- `scripts/sync-upstream.base` holds the upstream commit that the fork matches. Only
  `scripts/sync-upstream.sh` changes it.
- The script deletes the upstream files in the removed enterprise areas again. When an update
  breaks the build because ordinary code uses a removed area, change the ordinary code. Do not
  restore the enterprise files.
- An update can bring new enterprise files outside the removed areas. The script lists them by
  name. The owner decides about each one: delete it (add its path to
  `scripts/removed-enterprise-paths.txt`) or keep it. While the fork has enterprise files, keep the
  fork features off on a server (`N8N_FORK_FEATURES_ENABLED=false`): the switch can turn on
  enterprise code that checks one of the licence values of `packages/cli/src/fork-features.ts`.
- The golden tests of the rebuilt features fail when an update changes what the rebuilt code must
  do. [FORK-UPSTREAM.md](FORK-UPSTREAM.md#snapshot-tests-of-the-rebuilt-features) lists them.
  Compare the change with the upstream change, then update the fork code or the snapshot.
- To record a snapshot against the enterprise code, use a checkout of the upstream commit in
  `scripts/sync-upstream.base`, outside this repository, because the fork has no enterprise files.
  Build the checkout. Copy the test, its snapshot and the fork test helpers that it imports (for
  example `packages/cli/test/integration/shared/golden-recorder.ts`, or the harness that the
  FORK.md of an editor test names) to the same paths in the checkout. Point the imports of the
  code under test at the enterprise files that the comments of the test and the FORK.md files
  name. Run the test there with `-u`, copy the snapshot back, and compare it with the old
  snapshot. Keep the output of the run to test names, counts, error headlines and snapshot lines.
