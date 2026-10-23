# FORK.md

This repository is `sreent/n8n`, a private fork of `n8n-io/n8n`. This file is for agents and
people who work on the fork. Where it differs from `AGENTS.md`, this file wins.

## Feature freeze

The owner stopped new features in the fork on 2026-10-17. The fork gets only security fixes,
upstream merges and the fixes that these need. It keeps running for our organisation until a7c
can replace it.

The owner accepted one exception on 2026-10-19: pull request #53. It adds Forgejo, the safer
defaults of `deploy/` with a Move button for a blocked publish, the publish check for open triggers
and the platform setup tool.

The owner accepted a second exception on 2026-10-21: four more deployment options in `deploy/`,
next to the VM. They are Google Cloud Run, Amazon ECS, Azure Container Apps and Kubernetes.

The owner accepted the uniformity fixes on 2026-10-23. Core n8n, the rebuilt enterprise features
and the features of the fork must work as one product: the same tech stack, architecture,
patterns, design system, copy and user experience. The fixes close the gaps that an audit found.
`deploy/` also stops the telemetry, the "What's new" notes and the update notices of n8n.

a7c is a new product in `sreent/a7c`. Other companies will use it, so it contains no n8n code.
The licence of n8n allows changes for internal business use only (`LICENSE.md`).

## What the fork adds

- **Git sync** and **Send a copy**: backend modules in `packages/cli/src/modules/git-sync` and
  `packages/cli/src/modules/send-copy`, and frontend modules in
  `packages/modules/git-sync/frontend` and `packages/modules/send-copy/frontend`. Their READMEs
  describe them.
- **Audit log**: the backend module `packages/cli/src/modules/audit-log` keeps the audit events of
  n8n for 90 days and gives them in the public API (`/api/v1/audit-log`), and the frontend module
  `packages/modules/audit-log/frontend` shows them on the page Settings > Audit log. Their READMEs
  describe them.
- **Public API routes**: `/api/v1/audit-log` (see the audit log) and `/api/v1/insights/by-workflow`,
  the insights of each workflow
  (`packages/cli/src/public-api/v1/controllers/insights-by-workflow.public.controller.ts`). For
  reviews: `/api/v1/inventory/workflows` (each workflow with its owner, status, node types,
  credentials, triggers and newest executions), `/api/v1/api-keys` (the API keys of all users) and
  the field `lastActiveAt` of `/api/v1/users`.
  [packages/cli/src/governance/README.md](packages/cli/src/governance/README.md) describes them.
- **Log streaming**: the backend module `packages/cli/src/modules/log-streaming` sends the events
  of n8n to webhook, syslog and Sentry destinations, and the page Settings > Log streaming
  (`packages/frontend/editor-ui/src/features/integrations/logStreaming`) manages them. The README
  of the module and the FORK.md of the page describe them.
- **Google Cloud Storage**: the object store of `@n8n/blob-storage` keeps binary data and
  execution data in a bucket of Google Cloud Storage through its JSON API, and signs in with a
  service account (`N8N_EXTERNAL_STORAGE_GCS_BUCKET_NAME`, with the mode `s3`).
  [packages/@n8n/blob-storage/FORK.md](packages/@n8n/blob-storage/FORK.md#google-cloud-storage)
  describes it.
- **AI gateway**: the backend module `packages/cli/src/modules/ai-gateway` replaces the service of
  n8n Cloud for Gateway credits. Users run AI nodes without an API key of their own. The gateway
  calls the provider (or Azure OpenAI or Vertex AI) with a credential of an admin, records the
  cost of each call and stops the calls when a budget is spent. The frontend module
  `packages/modules/ai-gateway/frontend` adds the page Settings > Gateway credits admin. Their
  READMEs describe them.
- **Open triggers**: the backend module `packages/cli/src/modules/open-triggers` finds the
  webhooks, forms, public chats and MCP servers without authentication. With
  `N8N_OPEN_TRIGGERS_NEED_APPROVAL=true`, a publish stops for a new open trigger until a workflow
  review approves it, and the test URL of an open trigger takes calls only from n8n users who may
  run the workflow. The frontend module `packages/modules/open-triggers/frontend` offers
  one-click fixes and **Request approval** when the check stops a publish, and adds the page
  Settings > Open triggers. The public API gives the list at `/api/v1/inventory/open-triggers`.
  Their READMEs describe them.
- **Google Cloud OCR**: the node `packages/nodes-base/nodes/Google/CloudOcr` reads the text of
  images and documents with the Cloud Vision API and Document AI, with a service account, an API
  key or Gateway credits. Its README describes it.
- **No registration and no licence keys**: the fork turns on its features with the switch of step 5
  (below). It has no registration of the Community Edition, no request of an enterprise trial and
  no entry of licence keys (the owner chose this on 2026-10-13).
  [packages/cli/src/license/FORK.md](packages/cli/src/license/FORK.md) describes the change.
- `deploy/`: runs the fork on a Linux server with Docker Compose. `deploy/cloud-run/`,
  `deploy/ecs/` and `deploy/container-apps/` are Terraform modules for Google Cloud Run, Amazon ECS
  and Azure Container Apps, and `deploy/kubernetes/` is a Helm chart. They read the n8n settings of
  `deploy/settings.yaml`, which `deploy/settings.test.mjs` keeps equal to the settings of the VM.
  `deploy/workflows/governance-report.json` is a workflow that sends a weekly governance report.
  `deploy/forgejo/` runs Forgejo, a private Git server for the Git features of n8n, on its own VM
  in Google Cloud. `deploy/platform/setup.mjs` makes the team projects, the SSO group rules and the
  team credentials of an organisation from one config file, over the public API, and checks the
  setup. Their READMEs describe them.
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
   and Azure Blob storage (removed, with stand-ins, and rebuilt later, see
   [packages/@n8n/blob-storage/FORK.md](packages/@n8n/blob-storage/FORK.md)), the multi-main
   setup, the worker view and the worker pools (removed, with stand-ins, and rebuilt later, see
   [packages/cli/src/scaling/FORK.md](packages/cli/src/scaling/FORK.md)), and the entities of the
   workflow review tables (replaced, see
   [packages/@n8n/db/src/entities/FORK.md](packages/@n8n/db/src/entities/FORK.md)).
   Then the features that the owner chose to rebuild on 2026-10-12, in this order: execution
   annotations (done, see
   [packages/cli/src/executions/FORK.md](packages/cli/src/executions/FORK.md#execution-annotations)),
   variables (done, see
   [packages/cli/src/environments/variables/FORK.md](packages/cli/src/environments/variables/FORK.md)),
   evaluations (done, in four parts: the agent eval tables, see
   [packages/@n8n/db/src/entities/FORK.md](packages/@n8n/db/src/entities/FORK.md#the-agent-eval-tables),
   the Evaluation nodes, see
   [packages/nodes-base/nodes/Evaluation/FORK.md](packages/nodes-base/nodes/Evaluation/FORK.md),
   the backend, see
   [packages/cli/src/evaluation/FORK.md](packages/cli/src/evaluation/FORK.md), and the editor,
   see
   [the FORK.md of the editor folder](packages/frontend/editor-ui/src/features/ai/evaluation/FORK.md)),
   and the local parts of the AI workflow builder that the MCP tools of the workflow builder use
   (done, see
   [packages/@n8n/ai-workflow-builder/FORK.md](packages/@n8n/ai-workflow-builder/FORK.md)). The
   chat of the AI builder needs a service of n8n, and goes. Then the source control editor
   (removed, with stand-ins, and rebuilt later, see
   [the FORK.md of the folder](packages/frontend/editor-ui/src/features/integrations/sourceControl/FORK.md)),
   and last the enterprise files that fork code replaced (done). The fork has no enterprise code
   now. On 2026-10-14 the owner chose to rebuild the six features that the fork removed without a
   replacement, in the order of [FORK-FEATURES.md](FORK-FEATURES.md#parity-with-the-enterprise-edition):
   workflow reviews first (done, see
   [packages/cli/src/modules/workflow-reviews/README.md](packages/cli/src/modules/workflow-reviews/README.md)),
   then the S3 and Azure Blob storage (done, see
   [packages/@n8n/blob-storage/FORK.md](packages/@n8n/blob-storage/FORK.md)), then source control:
   the backend and its public API (done, see
   [packages/cli/src/modules/source-control/README.md](packages/cli/src/modules/source-control/README.md)),
   and the editor of source control (done, see
   [the FORK.md of the folder](packages/frontend/editor-ui/src/features/integrations/sourceControl/FORK.md)),
   then Git connections: the backend and its public API (done, see
   [packages/cli/src/modules/promotions/README.md](packages/cli/src/modules/promotions/README.md)),
   and their editor (done, see
   [the FORK.md of the folder](packages/frontend/editor-ui/src/features/integrations/promotions/FORK.md)),
   then multiple main instances, the worker view and worker pools (done, see
   [packages/cli/src/scaling/FORK.md](packages/cli/src/scaling/FORK.md) and
   [the FORK.md of the editor folder](packages/frontend/editor-ui/src/features/settings/orchestration/FORK.md)),
   then LDAP (done, see
   [packages/cli/src/modules/ldap/README.md](packages/cli/src/modules/ldap/README.md)), then
   dynamic credentials (done, see
   [packages/cli/src/modules/dynamic-credentials/README.md](packages/cli/src/modules/dynamic-credentials/README.md)).
5. When no enterprise code is left, turn on sharing, team projects (no limit), the project roles,
   the admin role, custom roles, SSO and external secrets. They are on by default, and an
   environment variable turns them off. The upstream tests run with them off. Done:
   `packages/cli/src/fork-features.ts` lists the licence values of these features, and `License`
   (`packages/cli/src/license.ts`) gives them while `N8N_FORK_FEATURES_ENABLED` is `true`, the
   default. With `N8N_FORK_FEATURES_ENABLED=false`, the licence decides, as in upstream n8n. The
   licence checks of ordinary code stay. The cli tests set the variable to `false`
   (`packages/cli/test/setup-fork-features.ts`). A test or the e2e controller that replaces
   `License.isLicensed` replaces the switch too. On 2026-10-13 the owner added variables, execution
   annotations and filters, evaluations (no limit of workflows), API key scopes, folders, debug in
   editor, insights (no limit of history), data redaction, the custom span attributes of
   OpenTelemetry, node type policies and the personal space policy to the list. Node type policies
   also need their module (`N8N_ENABLED_MODULES=type-availability-policies`), which `deploy/` sets.
   On 2026-10-14 the owner added MFA enforcement, the diffs and the names of workflow versions, the
   workflow history without a time limit, the private registry of community nodes and token
   exchange. Token exchange also needs `N8N_ENV_FEAT_TOKEN_EXCHANGE=true`, because upstream n8n marks
   it experimental, and `N8N_TOKEN_EXCHANGE_ENABLED=true` with trusted keys. The banner of a
   non-production instance is not in the list: an instance turns it on with
   `N8N_FORK_NON_PRODUCTION_BANNER=true`. The owner chose parity with the Enterprise Edition on
   2026-10-14: each of the six rebuilt features goes into the list when it is done. Workflow
   reviews, the S3 and Azure Blob storage of binary data and execution data, source control, Git
   connections, multiple main instances, the worker view, worker pools, LDAP and dynamic
   credentials are in the list. Git connections also need their module
   (`N8N_ENABLED_MODULES=promotions`), and their editor needs `N8N_ENV_FEAT_PROMOTIONS=true`, as in
   upstream n8n. `deploy/` sets both. The resolvers, the hooks and the check node of dynamic
   credentials need `N8N_ENV_FEAT_DYNAMIC_CREDENTIALS=true`, as in upstream n8n. `deploy/` sets it.
   Multiple main instances, the worker view and worker pools need queue mode, and multiple main
   instances and worker pools also need `N8N_MULTI_MAIN_SETUP_ENABLED=true` and
   `N8N_WORKER_POOLS_ENABLED=true`, as in upstream n8n. On 2026-10-15 the owner added the AI gateway
   (Gateway credits) to the list. Without a credential of a provider and without the switch on the
   page Settings > Gateway credits admin, the gateway stays off. On 2026-10-23 the owner added log streaming
   and the audit log (`feat:logStreaming`): they stay on by default, and the switch turns them off
   with the other rebuilt features.

[FORK-FEATURES.md](FORK-FEATURES.md) lists each enterprise feature: what it does, its status in the
fork, the plan, and the clean-room sources for a rebuild.

`scripts/removed-enterprise-paths.txt` lists the removed areas. `scripts/sync-upstream.sh` deletes
them again after each upstream update, and container CI checks that they stay deleted. An upstream
update can bring new enterprise files: see "Upstream updates".

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
- **Licence checks.** Keep the licence checks of ordinary code. The owner chose on 2026-10-09 to
  keep them until step 5, and step 5 keeps them too: the fork turns on a feature with its licence
  value in `packages/cli/src/fork-features.ts`, not by removing a check. Add a feature to that
  list only when the owner chooses it.
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
  Then run `scripts/container-ci.sh --fork`, and open a pull request.
- `scripts/sync-upstream.base` holds the upstream commit that the fork matches. Only
  `scripts/sync-upstream.sh` changes it.
- The script deletes the upstream files in the removed enterprise areas again. When an update
  breaks the build because ordinary code uses a removed area, change the ordinary code. Do not
  restore the enterprise files.
- An update can bring new enterprise files outside the removed areas. The owner chose on
  2026-10-13 not to delete them all. The script lists them by name. The owner decides about each
  one: delete it (add its path to `scripts/removed-enterprise-paths.txt`) or keep it. While the
  fork has enterprise files, keep the fork features off on a server
  (`N8N_FORK_FEATURES_ENABLED=false`): the switch can turn on enterprise code that checks one of
  the licence values of `packages/cli/src/fork-features.ts`.
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
  `packages/cli/test/integration/evaluation`), and of the evaluation editor (the golden tests in
  `packages/frontend/editor-ui/src/features/ai/evaluation/__tests__/golden`), and of the local
  parts of the AI workflow builder
  (`packages/cli/src/services/__tests__/golden/ai-workflow-builder.golden.test.ts`), and of the
  source control editor (the golden tests in
  `packages/frontend/editor-ui/src/features/integrations/sourceControl/__tests__/golden`), and of
  the workflow reviews
  (`packages/cli/test/integration/workflow-reviews/workflow-reviews.golden.test.ts`), and of the
  S3 and Azure Blob storage (the golden tests in `packages/@n8n/blob-storage/src/__tests__/golden`),
  and of source control (the golden tests in `packages/cli/test/integration/source-control`),
  and of Git connections (the golden tests in `packages/cli/test/integration/promotions`), and of
  the editor of Git connections (the golden tests in
  `packages/frontend/editor-ui/src/features/integrations/promotions/__tests__/golden`), and of the
  scaling code (the golden tests in `packages/cli/src/scaling/__tests__/golden` and
  `packages/cli/test/integration/worker-pools`), and of the worker view (the golden test in
  `packages/frontend/editor-ui/src/features/settings/orchestration/__tests__/golden`), and of
  LDAP (`packages/cli/test/integration/ldap/ldap.golden.test.ts`), and of dynamic credentials
  (the golden tests in `packages/cli/test/integration/dynamic-credentials`) fail
  when an update changes what a role may do, how projects, sharing, the sign-in method, the
  OIDC sign-in, the role provisioning, the SAML sign-in, the secrets providers, the queries of
  their connections, the external secrets module, the external secrets editor, the connections
  editor, the execution annotations, the variables, the agent eval tables, the Evaluation nodes,
  the evaluation backend, the evaluation editor, the local parts of the AI workflow builder, the
  source control editor, the workflow reviews, the S3 and Azure Blob storage, source control, Git
  connections, their editor, the multi-main setup, the worker status, the worker pools, the
  worker view, LDAP or dynamic credentials work.
  Compare the change with the upstream change, then update the fork code or the snapshot.
- To record a snapshot against the enterprise code, use a checkout of the upstream commit in
  `scripts/sync-upstream.base`, outside this repository, because the fork has no enterprise files.
  Build the checkout. Copy the test, its snapshot and the fork test helpers that it imports (for
  example `packages/cli/test/integration/shared/golden-recorder.ts`, or the harness that the
  FORK.md of an editor test names) to the same paths in the checkout. Point the imports of the
  code under test at the enterprise files that the comments of the test and the FORK.md files
  name. Run the test there with `-u`, copy the snapshot back, and compare it with the old
  snapshot. Keep the output of the run to test names, counts, error headlines and snapshot lines.
- When an upstream update changes the public API handler
  `packages/cli/src/public-api/v1/handlers/log-streaming/log-streaming.handler.ts`, keep the fork
  version, as `packages/cli/src/modules/log-streaming/README.md` tells.
- When an upstream update changes the public API controller
  `packages/cli/src/public-api/v1/controllers/source-control.public.controller.ts`, keep the import
  paths of the fork module, as `packages/cli/src/modules/source-control/README.md` tells.
- When an upstream update changes the public API controller
  `packages/cli/src/public-api/v1/controllers/promotions.public.controller.ts`, keep the import
  paths of the fork module and the user arguments of the audit events, as
  `packages/cli/src/modules/promotions/README.md` tells.
- When an upstream update changes the pubsub commands (`pubsub-metadata.ts` of `@n8n/decorators`,
  and `pubsub.event-map.ts` and `pubsub.types.ts` of `packages/cli/src/scaling/pubsub`), keep the
  fork command `reload-ldap-config`, as
  [packages/cli/src/modules/ldap/README.md](packages/cli/src/modules/ldap/README.md) tells.
- When an upstream update changes `packages/cli/src/server.ts`, the list `eventNamesAudit` of
  `packages/cli/src/eventbus/event-message-classes/index.ts` or the type `RelayEventMap`, keep the
  fork lines of the governance audit events (`ForkGovernanceEventRelay`), as
  [packages/cli/src/modules/audit-log/README.md](packages/cli/src/modules/audit-log/README.md)
  tells.
- When an upstream update changes `packages/cli/src/services/ai-gateway.service.ts`,
  `packages/cli/src/services/frontend.service.ts` or
  `packages/frontend/editor-ui/src/app/composables/useAiGatewayTopUp.ts`, keep the fork lines of the
  AI gateway. When it changes the protocol of the gateway or adds a provider to Gateway credits,
  change the fork module, as
  [packages/cli/src/modules/ai-gateway/README.md](packages/cli/src/modules/ai-gateway/README.md)
  tells.
- When an upstream update changes the lists of `packages/nodes-base/package.json`, keep the two
  lines of the node Google Cloud OCR and its credential type.
- When an upstream update changes `packages/cli/src/credentials/credentials.service.ts` or the
  ordinary tests of dynamic credentials, keep the import paths of the fork module, as
  `packages/cli/src/modules/dynamic-credentials/README.md` tells.
- When an upstream update changes how ordinary code uses the S3 and Azure classes of
  `@n8n/blob-storage`, change the fork classes. When it changes `initBinaryDataService` or
  `initObjectStoreIfConfigured` of `packages/cli/src/commands/base-command.ts`, keep the fork
  method `isObjectStoreConfigured`, which starts the object store for Google Cloud Storage too.
  When it changes how ordinary code uses the scaling classes `MultiMainSetup`,
  `WorkerStatusService`, `WorkerPoolsService` and `PoolConfigService`, change the fork classes, as
  [packages/cli/src/scaling/FORK.md](packages/cli/src/scaling/FORK.md) tells. When an upstream
  migration changes a workflow review table or the table `project_pool_settings`, change the fork
  entity. The FORK.md files of step 4 tell how.
- When an upstream update adds a public route for the audit log, for the insights of each
  workflow, for an inventory of workflows or for a list of all API keys, compare it with the fork
  route. Keep one of them.
- When an upstream update changes `packages/@n8n/api-types/src/dto/user/user-public.dto.ts` or
  `packages/cli/src/public-api/v1/controllers/users.public.controller.ts`, keep the fork field
  `lastActiveAt`, as [packages/cli/src/governance/README.md](packages/cli/src/governance/README.md)
  tells.
- When an upstream update makes ordinary code import a new name from `@n8n/ai-workflow-builder`,
  add it to the fork package, as
  [packages/@n8n/ai-workflow-builder/FORK.md](packages/@n8n/ai-workflow-builder/FORK.md) tells.
- When an upstream update changes scopes or roles, make the permission data again, as
  [packages/@n8n/permissions/FORK.md](packages/@n8n/permissions/FORK.md) tells. The scope
  snapshot test of `@n8n/permissions` fails when upstream adds a scope.
- When an upstream update changes `packages/cli/src/instance-settings-loader/instance-settings-loader.service.ts`,
  keep the fork loader of workflow reviews and the redaction floor, as
  [packages/cli/src/instance-settings-loader/FORK.md](packages/cli/src/instance-settings-loader/FORK.md)
  tells.
- When an upstream update changes `packages/frontend/editor-ui/src/app/composables/useWorkflowActivate.ts`,
  `src/app/capabilities.manifest.ts`, `src/app/event-bus/node-view.ts` or
  `src/app/components/MainHeader/WorkflowHeaderDraftPublishActions.vue` of editor-ui, keep the fork
  lines of the open-trigger fixes, as
  [packages/modules/open-triggers/frontend/README.md](packages/modules/open-triggers/frontend/README.md)
  tells. When it changes the authentication options of the Webhook, Form Trigger, Chat Trigger or
  MCP Server Trigger node, change `open-trigger.detector.ts` of the open-triggers module. When it
  changes `packages/cli/src/webhooks/test-webhooks.ts`, keep the fork line that asks
  `TestWebhookCallGuards` before the request loses its cookies, as the README of the
  open-triggers module tells. When it
  changes `WorkflowHeaderDraftPublishActions.vue`, `src/app/components/MainHeader/ActionsDropdownMenu.vue`
  or `src/app/event-bus/node-view.ts`, also keep the Move button of a blocked publish, as
  [packages/frontend/editor-ui/FORK.md](packages/frontend/editor-ui/FORK.md#the-move-button-of-a-blocked-publish)
  tells.
- When an upstream update changes `isLicensed` or `getValue` of `packages/cli/src/license.ts`, or
  the `setupFiles` of `packages/cli/vitest.config.base.ts`, keep the fork lines (step 5).
- When an upstream update changes the licence routes, the page Settings > Usage and plan or the
  registration of the Community Edition, keep the fork removal, as
  [packages/cli/src/license/FORK.md](packages/cli/src/license/FORK.md) tells.
- When an upstream update changes the wa-sqlite commit in
  `packages/frontend/editor-ui/package.json`, keep the upstream line. Then run
  `scripts/vendor-wa-sqlite.sh`.
