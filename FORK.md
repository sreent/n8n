# FORK.md

This repository is `sreent/n8n`, a private fork of `n8n-io/n8n`. This file is for agents and
people who work on the fork. Where it differs from `AGENTS.md`, this file wins.

## What the fork adds

- **Git sync** and **Send a copy**: backend modules in `packages/cli/src/modules/git-sync` and
  `packages/cli/src/modules/send-copy`, and frontend modules in
  `packages/modules/git-sync/frontend` and `packages/modules/send-copy/frontend`. Their READMEs
  describe them.
- **Audit log**: the backend module `packages/cli/src/modules/audit-log` keeps the audit events of
  n8n for 90 days, and the frontend module `packages/modules/audit-log/frontend` shows them on the
  page Settings > Audit log. Their READMEs describe them.
- **Log streaming**: the backend module `packages/cli/src/modules/log-streaming` sends the events
  of n8n to webhook, syslog and Sentry destinations, and the page Settings > Log streaming
  (`packages/frontend/editor-ui/src/features/integrations/logStreaming`) manages them. The README
  of the module and the FORK.md of the page describe them.
- `deploy/`: runs the fork on a Linux server with Docker Compose.
- `vendor/`: the wa-sqlite package that the editor app installs. Upstream installs it from
  GitHub, which a cloud session cannot do. `scripts/vendor-wa-sqlite.sh` packs it from the
  upstream commit and gives the same file again.
- `scripts/container-ci.sh`, `scripts/sync-upstream.sh`, `scripts/cloud-install.sh` and
  `scripts/build-images.sh`: CI, upstream updates, installs in cloud sessions, and the Docker
  images.

## Enterprise code

n8n keeps its enterprise code in `*.ee.*` files and `*.ee/` folders. The n8n Enterprise License
(`LICENSE_EE.md`) covers this code, and production use of it needs a paid licence. The rest of
n8n is under the Sustainable Use License (`LICENSE.md`), which allows changes for internal
business use.

The fork removes the enterprise code step by step, and builds its own versions of the features:

1. The rules and the tooling, and the enterprise modules that do nothing without a licence.
2. Our own permission core (scopes, roles and `hasScope`) in place of the enterprise files of
   `@n8n/permissions`. Done: see
   [packages/@n8n/permissions/FORK.md](packages/@n8n/permissions/FORK.md).
3. Our own project and sharing services. Done: the scope check `userHasScopes` (see
   [packages/cli/src/permissions/FORK.md](packages/cli/src/permissions/FORK.md)), the project
   service (see [packages/cli/src/services/FORK.md](packages/cli/src/services/FORK.md)), the
   sharing services (see [packages/cli/src/workflows/FORK.md](packages/cli/src/workflows/FORK.md)),
   the execution view (see
   [packages/cli/src/executions/FORK.md](packages/cli/src/executions/FORK.md)), and the sharing UI
   and the `EnterpriseEdition` gate of the editor (see
   [packages/frontend/editor-ui/FORK.md](packages/frontend/editor-ui/FORK.md)).
4. Our own features, one at a time: SSO, external secrets and an audit log export. Then replace
   or remove the rest of the enterprise code. SSO is a drop-in replacement that behaves as the
   enterprise SSO and turns on in step 5. Order: the SSO helpers (done, see
   [packages/cli/src/sso/FORK.md](packages/cli/src/sso/FORK.md)), OIDC (done, see
   [packages/cli/src/modules/sso-oidc/FORK.md](packages/cli/src/modules/sso-oidc/FORK.md)), role
   provisioning (done, see
   [packages/cli/src/modules/provisioning/FORK.md](packages/cli/src/modules/provisioning/FORK.md)),
   and SAML (done, see
   [packages/cli/src/modules/sso-saml/FORK.md](packages/cli/src/modules/sso-saml/FORK.md)).
   External secrets are a drop-in replacement too, with all six providers, and turn on in step 5
   (the owner chose this on 2026-10-10). Order: the base class and the Vault, Infisical and
   1Password providers (done), the AWS, Azure and GCP providers (done), the repositories of the
   connections (done), the module (done), the REST clients, the store and the settings page with
   one connection for each provider type (done, see
   [the FORK.md of the editor folder](packages/frontend/editor-ui/src/features/integrations/externalSecrets/FORK.md)),
   and the settings pages of the connections (done, see
   [the FORK.md of the connections folder](packages/frontend/editor-ui/src/features/integrations/secretsProviders/FORK.md)).
   See
   [packages/cli/src/modules/external-secrets/FORK.md](packages/cli/src/modules/external-secrets/FORK.md).
   The audit log export comes as an audit log and a new log streaming. Both are on by default,
   without a licence check (the owner chose this on 2026-10-11). Order: the backend of the audit
   log (done, see
   [packages/cli/src/modules/audit-log/README.md](packages/cli/src/modules/audit-log/README.md)),
   the settings page of the audit log (done, see
   [packages/modules/audit-log/frontend/README.md](packages/modules/audit-log/frontend/README.md)),
   the backend of log streaming and its public API (done, see
   [packages/cli/src/modules/log-streaming/README.md](packages/cli/src/modules/log-streaming/README.md)),
   and its settings page (done, see
   [the FORK.md of the page](packages/frontend/editor-ui/src/features/integrations/logStreaming/FORK.md)).
   The rest of the enterprise code, first the parts that need no decision of the owner: the S3
   and Azure Blob storage (removed, with stand-ins, see
   [packages/@n8n/blob-storage/FORK.md](packages/@n8n/blob-storage/FORK.md)), the multi-main
   setup, the worker view and the worker pools (removed, with stand-ins, see
   [packages/cli/src/scaling/FORK.md](packages/cli/src/scaling/FORK.md)), and the entities of the
   workflow review tables (replaced, see
   [packages/@n8n/db/src/entities/FORK.md](packages/@n8n/db/src/entities/FORK.md)).
   Then the features that the owner chose to rebuild on 2026-10-12, in this order: execution
   annotations (done, see
   [packages/cli/src/executions/FORK.md](packages/cli/src/executions/FORK.md#execution-annotations)),
   variables (done, see
   [packages/cli/src/environments/variables/FORK.md](packages/cli/src/environments/variables/FORK.md)),
   evaluations (in parts: the agent eval tables are done, see
   [packages/@n8n/db/src/entities/FORK.md](packages/@n8n/db/src/entities/FORK.md#the-agent-eval-tables),
   the Evaluation nodes are done, see
   [packages/nodes-base/nodes/Evaluation/FORK.md](packages/nodes-base/nodes/Evaluation/FORK.md),
   and the backend is done, see
   [packages/cli/src/evaluation/FORK.md](packages/cli/src/evaluation/FORK.md); the editor comes
   next),
   and the local parts of the AI workflow builder that the MCP tools of the workflow builder use.
   The chat of the AI builder needs a service of n8n, and goes. Then the source control editor,
   and last the enterprise files that fork code replaced.
5. When no enterprise code is left, turn on sharing, team projects (no limit), the project roles,
   the admin role, custom roles, SSO and external secrets. They are on by default, and an
   environment variable turns them off. The upstream tests run with them off.

[FORK-FEATURES.md](FORK-FEATURES.md) lists each enterprise feature: what it does, its status in the
fork, the plan, and the clean-room sources for a rebuild.

`scripts/removed-enterprise-paths.txt` lists the removed areas. `scripts/sync-upstream.sh` deletes
them again after each upstream update, and container CI checks that they stay deleted.

## Rules

- **Clean room.** Do not open, read, edit, copy or search the contents of enterprise files
  (`*.ee.*` files and `*.ee/` folders), also not their build output in `dist/`, the Git history
  or upstream. Exclude them from searches, for example
  `rg <pattern> -g '*.ts' --glob '!*.ee.*' --glob '!**/*.ee/**'`. Put the exclusions last: in
  ripgrep, the last glob that matches a file wins. To remove enterprise code, work with the file
  names and with the ordinary code that uses them. To build a replacement, use the public n8n
  documentation, the ordinary code and the behaviour of a running n8n.
- **Licence checks.** Do not change or go around a licence check that turns on enterprise code
  that is still in the fork. Also keep the licence checks around ordinary code until step 5: the
  enterprise code that is still in the fork can read the same licence values, and the fork cannot
  check this without reading that code. The owner chose this on 2026-10-09.
- **Permission scopes.** The scope list and the role maps are fork code now. They come from a
  running n8n through `scripts/permission-snapshot.mjs`. Do not edit
  `packages/@n8n/permissions/src/permission-data.generated.ts` by hand. A fork feature that needs a
  scope adds it as packages/@n8n/permissions/FORK.md tells.
- **Notices.** Keep `LICENSE.md` and `LICENSE_EE.md`. This file is the notice that the fork
  changes n8n. Use the fork for internal business use only.
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
  `scripts/container-ci-skipped-tests.txt`: the enterprise SSO, role provisioning and external
  secrets tests, which the owner chose not to run on the fork code. It runs the integration tests
  with 2 workers, because more time out on the 4 CPUs of a cloud session.

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
  Then run `scripts/container-ci.sh --fork`, and open a pull request.
- `scripts/sync-upstream.base` holds the upstream commit that the fork matches. Only
  `scripts/sync-upstream.sh` changes it.
- The script deletes the upstream files in the removed enterprise areas again. When an update
  breaks the build because ordinary code uses a removed area, change the ordinary code. Do not
  restore the enterprise files.
- The snapshot tests of `packages/cli/src/permissions`, of the project service
  (`packages/cli/src/services`), of the sharing services (`packages/cli/src/workflows`), of the
  execution view (`packages/cli/src/executions`), of the SSO helpers (`packages/cli/src/sso`), of
  the OIDC sign-in (`packages/cli/src/modules/sso-oidc`), of the role provisioning
  (`packages/cli/src/modules/provisioning`), of the SAML sign-in
  (`packages/cli/src/modules/sso-saml`), of external secrets (the providers, the queries of their
  connections and the module, `packages/cli/src/modules/external-secrets`), of the external secrets
  editor (the REST clients, the store and the settings page,
  `packages/frontend/editor-ui/src/features/integrations/externalSecrets`), of the connections
  editor (the settings page of the connections, its modals and its composables,
  `packages/frontend/editor-ui/src/features/integrations/secretsProviders`), of the sharing UI
  and the `EnterpriseEdition` gate (`packages/frontend/editor-ui`), and of the execution
  annotations (`packages/cli/test/integration/annotation-tags.api.test.ts` and the two editor
  tests that `packages/cli/src/executions/FORK.md` names), and of variables
  (`packages/cli/test/integration/variables.api.test.ts` and the editor test in
  `packages/frontend/editor-ui/src/features/settings/environments`), and of the agent eval tables
  (`packages/cli/test/integration/database/repositories/agent-eval.repositories.test.ts`), and of
  the Evaluation nodes (`packages/nodes-base/nodes/Evaluation/test/Evaluation.golden.test.ts`),
  and of the evaluation backend (the `*.golden.test.ts` files in
  `packages/cli/test/integration/evaluation`) fail when an update changes
  what a role may do, how projects, sharing, the sign-in method, the OIDC sign-in, the role
  provisioning, the SAML sign-in, the secrets providers, the queries of their connections, the
  external secrets module, the external secrets editor, the connections editor, the execution
  annotations, the variables, the agent eval tables, the Evaluation nodes or the evaluation
  backend work.
  Compare the change with the upstream change, then update the fork code or the snapshot. The
  FORK.md files there tell how to record a snapshot against the enterprise code.
- When an upstream update changes the public API handler
  `packages/cli/src/public-api/v1/handlers/log-streaming/log-streaming.handler.ts`, keep the fork
  version, as `packages/cli/src/modules/log-streaming/README.md` tells.
- When an upstream update changes how ordinary code uses the S3 and Azure classes of
  `@n8n/blob-storage` or the scaling classes `MultiMainSetup`, `WorkerStatusService` and
  `PoolConfigService`, change the fork stand-ins. When an upstream migration changes a workflow
  review table, change the fork entity. The FORK.md files of step 4 tell how.
- When an upstream update changes `packages/cli/test/shared/external-secrets/utils.ts`, make the
  same change in `fork-providers.ts` next to it. The ordinary tests of external secrets use that
  fork copy, and the enterprise tests use `utils.ts`.
- When an upstream update changes scopes or roles, make the permission data again, as
  [packages/@n8n/permissions/FORK.md](packages/@n8n/permissions/FORK.md) tells. The scope
  snapshot test of `@n8n/permissions` fails when upstream adds a scope.
- When an upstream update changes the wa-sqlite commit in
  `packages/frontend/editor-ui/package.json`, keep the upstream line. Then run
  `scripts/vendor-wa-sqlite.sh`.
