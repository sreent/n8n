# FORK-FEATURES.md

The register of the n8n enterprise features, and what the fork does about each one. Read it with
[FORK.md](FORK.md). When a pull request removes enterprise code or adds a fork feature, it updates
this file in the same pull request.

## How to build a fork feature

1. **Write the spec first.** Put it in the README of the new fork module, before the code. Name
   the sources that you used.
2. **Use only clean-room sources:**
   - The public n8n documentation (links below).
   - Ordinary code (no `.ee` in the name): the interfaces, proxies and settings that call the
     feature, the DTOs in `@n8n/api-types`, and the database entities and migrations.
   - The ordinary files that the fork removed, for example the public API specs. Read them at the
     upstream commit before the removal: `e8b9821f4a9a7ee634d394ada7b695bdebfafa86` in
     `n8n-io/n8n`.
   - The behaviour of a running n8n without a licence.

   Never use enterprise files, their tests or their build output, also not in the Git history or
   in upstream.
3. **Write the tests from the spec.** Test the REST API and the UI as a user sees them.
4. **Build a fork module** in `packages/cli/src/modules/<name>` and
   `packages/modules/<name>/frontend`, as Git sync and Send a copy do. Follow the rules in
   FORK.md: add permission scopes as `packages/@n8n/permissions/FORK.md` tells, and make no
   changes to licence checks around enterprise code.
5. **Update this file:** the status, the module and the spec.

## Priorities

The owner chose these on 2026-10-04:

1. Team projects and roles (sharing, project roles, the admin role, custom roles, API key scopes).
   Needs step 2 (our own permission core, done) and step 3 (our own project and sharing
   services, done). Sharing, team projects, the project roles, the admin role and custom roles
   turn on in step 5 of FORK.md, when no enterprise code is left (the owner chose this on
   2026-10-09).
2. SSO: OIDC first, then SAML, with role provisioning. A drop-in replacement of the enterprise SSO
   that turns on in step 5 of FORK.md (the owner chose this on 2026-10-09).
3. External secrets: a drop-in replacement with all six providers that turns on in step 5 of
   FORK.md (the owner chose this on 2026-10-10).
4. An audit log export (in place of log streaming). The owner chose these on 2026-10-11: the fork
   builds an audit log (the audit events in the database, a settings page, and a CSV or JSON
   export) and a new log streaming (webhook, syslog and Sentry destinations). Both are on by
   default, without a licence check, as Git sync is. The audit log keeps the events for 90 days.

## Status values

| Status | Meaning |
|---|---|
| Removed | The fork deleted the enterprise code (`scripts/removed-enterprise-paths.txt`). |
| Kept, enterprise code | Enterprise files for the feature are still in the fork. They do nothing without a licence. |
| Gated, ordinary code | Ordinary code behind a licence check. The fork keeps these checks until no enterprise code is left (FORK.md, step 5). |
| Free with a key | n8n turns the feature on for free with a registered community key (**Settings > Usage and plan > Unlock**). |
| Fork | The fork has its own feature. |
| Not checked | Nobody looked at the code of this feature yet. |

## Licence features

| Feature | Licence flag | What it does | Status | Fork plan | Sources |
|---|---|---|---|---|---|
| Sharing | `feat:sharing` | Share workflows and credentials with users and projects. | Sharing services: Fork (`cli/src/workflows/enterprise-workflow.service.ts`, `cli/src/credentials/enterprise-credentials.service.ts`, step 3). Editor sharing UI: Fork (the share modal, the sharing tab of the credential modal, their API helpers and the `workflowsEE` store, step 3). Execution view: Fork (`cli/src/executions/enterprise-execution.service.ts`, step 3). Licence gate of the editor: Fork (`EnterpriseEdition.vue`, step 3) | Priority 1. Turns on in step 5 of FORK.md. Today: Send a copy (copies, no live sharing). | [Workflows](https://docs.n8n.io/workflows/sharing/), [credentials](https://docs.n8n.io/credentials/credential-sharing/), `cli/src/workflows/FORK.md`, `editor-ui/FORK.md` |
| Project roles | `feat:projectRole:admin`, `:editor`, `:viewer` | Admin, editor and viewer roles in team projects. | Roles and scopes: Fork (`@n8n/permissions`, step 2). Scope check: Fork (`cli/src/permissions`, step 3). Project service: Fork (`cli/src/services/project.service.ts`, step 3) | Priority 1. Turns on in step 5 of FORK.md. | [Roles](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac/see-available-roles.md), [projects](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac/organize-work-in-projects.md), `@n8n/permissions/FORK.md`, `roles/all-roles.ts`, `@n8n/db` entities `project`, `project-relation`, `role` |
| Advanced permissions | `feat:advancedPermissions` | The global admin role and its permissions. | Role and scopes: Fork (`@n8n/permissions`, step 2). Licence checks: gated ordinary code | Priority 1. Turns on in step 5 of FORK.md. | [Roles](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac/see-available-roles.md) |
| Custom roles | `feat:customRoles` | Roles that an admin builds from scopes. | Scope data and editor options: Fork (`@n8n/permissions`, step 2). Role service: gated ordinary code | Priority 1. Turns on in step 5 of FORK.md. | [Custom roles](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac/create-custom-roles.md), `@n8n/permissions/FORK.md` |
| API key scopes | `feat:apiKeyScopes` | Limit an API key to some scopes. | API key scopes for each role: Fork (`@n8n/permissions`, step 2). Licence checks: gated ordinary code | Priority 1 | [API authentication](https://docs.n8n.io/api/authentication/) |
| OIDC SSO | `feat:oidc` | Sign-in with an OpenID Connect provider. | Fork (`cli/src/modules/sso-oidc/oidc.service.ts` and `oidc.controller.ts`, step 4), with the fork's role provisioning. SSO helpers: Fork (`cli/src/sso/sso-helpers.ts`, step 4). Licence checks: gated ordinary code | Priority 2. Drop-in replacement. Turns on in step 5 of FORK.md. | [OIDC](https://docs.n8n.io/user-management/oidc/), `packages/cli/src/modules/sso-oidc/FORK.md`, public API `sso-oidc.public.controller.ts` |
| SAML SSO | `feat:saml` | Sign-in with a SAML provider. | Fork (`cli/src/modules/sso-saml`, step 4): the service, the controller and the service provider, with the roles of the fork's role provisioning. The enterprise files stay, unused by ordinary code. SSO helpers: Fork (`cli/src/sso/sso-helpers.ts`, step 4). Licence checks: gated ordinary code | Priority 2. Drop-in replacement. Turns on in step 5 of FORK.md. | [SAML](https://docs.n8n.io/user-management/saml/), ordinary files in `packages/cli/src/modules/sso-saml`, public API `sso-saml.public.controller.ts` |
| Role provisioning | (part of SAML and OIDC) | Set roles from claims of the identity provider. | Fork (`cli/src/modules/provisioning`, step 4): the config, the rules, and the roles of an OIDC or SAML sign-in. The enterprise files (`modules/provisioning.ee`) stay, unused by ordinary code. Licence checks: gated ordinary code | Priority 2. Drop-in replacement. Turns on in step 5 of FORK.md. | [OIDC](https://docs.n8n.io/user-management/oidc/) and [SAML](https://docs.n8n.io/user-management/saml/) role provisioning, `packages/cli/src/modules/provisioning/FORK.md`, public API `role-mapping-rules.public.controller.ts` |
| MFA enforcement | `feat:mfaEnforcement` | Require two-factor sign-in for all users. | Not checked | With priority 2 | [Two-factor authentication](https://docs.n8n.io/user-management/two-factor-auth/) |
| External secrets | `feat:externalSecrets` | Credentials read values from a secret store (Vault, AWS, Azure, GCP and others). | Backend: Fork (`cli/src/modules/external-secrets`, step 4), used by ordinary code: the base class, all six providers (HashiCorp Vault, Infisical, 1Password Connect, AWS Secrets Manager, Azure Key Vault and GCP Secrets Manager), the manager, the settings API, the connections API, the project API, the completions, the provider types and the access check. Repositories of the connections: Fork (`@n8n/db`). The editor: Fork (`editor-ui/src/features/integrations/externalSecrets`, step 4), used by ordinary code: the REST clients, the store, and the settings page with one connection for each provider type, with its modal. The settings pages of the connections: Fork (`editor-ui/src/features/integrations/secretsProviders`, step 4), used by ordinary code: the settings page of the connections, the connection modal, the delete modal, and the composables that the settings of a project also use. The enterprise editor folders `externalSecrets.ee` and `secretsProviders.ee` and the enterprise REST clients stay, unused by ordinary code. The enterprise module `modules/external-secrets.ee` and the `@n8n/db` `*.repository.ee.ts` files stay, unused by ordinary code; container CI leaves out the tests of the enterprise module | Priority 3. Drop-in replacement with all six providers. Turns on in step 5 of FORK.md. | [External secrets](https://docs.n8n.io/administer/manage-credentials/use-external-secret-stores/), `packages/cli/src/modules/external-secrets/FORK.md`, `test/shared/external-secrets/utils.ts`, the frontend settings type of `@n8n/api-types`, ordinary tests in `test/integration/external-secrets`, `credentials-helper.ts`, `credentials/credential-dependency.service.ts`, `@n8n/db` entities `secrets-provider-connection`, `project-secrets-provider-access`, `ProjectExternalSecrets.vue`, `packages/frontend/editor-ui/src/features/integrations/externalSecrets/FORK.md`, `packages/frontend/editor-ui/src/features/integrations/secretsProviders/FORK.md` |
| Log streaming | `feat:logStreaming` | Send events to a webhook, syslog or Sentry. | Removed (backend and editor). Audit log: Fork (`cli/src/modules/audit-log` and `modules/audit-log/frontend`, step 4): the backend, which stores the audit events, deletes them after 90 days, and gives them with a CSV or JSON export in the REST API, and the page Settings > Audit log | Priority 4. Next: a new log streaming (the backend, the public API and the settings page). On by default, without a licence check. | [Log streaming](https://docs.n8n.io/log-streaming/), `packages/cli/src/eventbus`, destination schemas in `packages/workflow/src/message-event-bus.ts`, `N8N_LOG_STREAMING_*` in `InstanceSettingsLoaderConfig`, removed public API `handlers/log-streaming`, `packages/cli/src/modules/audit-log/README.md`, `packages/modules/audit-log/frontend/README.md` |
| Source control | `feat:sourceControl` | Git-based environments: push and pull, protected instances. | Removed (backend). The editor keeps `sourceControl.ee`: the enterprise evaluations and variables files use it. | Fork: Git sync (one project, workflows). No protected-instance mode yet. | [Source control](https://docs.n8n.io/source-control-environments/), `services/instance-write-access.service.ts`, removed public API `source-control.public.controller.ts`, Git sync README |
| Git connections | `feat:gitConnections` | Promotions: connect projects to Git and move packages between instances. | Removed (backend and editor) | Fork: Git sync | Removed public API `promotions.public.controller.ts`, promotion DTOs in `@n8n/api-types` |
| LDAP | `feat:ldap` | Sign-in and user sync with an LDAP directory. | Removed (backend). The LDAP settings page of the editor is ordinary code and stays. | Not planned. SSO covers sign-in. | [LDAP](https://docs.n8n.io/user-management/ldap/), `LdapConfig` in `@n8n/constants`, removed public API `ldap.public.controller.ts` |
| Dynamic credentials | `feat:dynamicCredentials` | Credentials resolved for the user of each run. | Removed | Not planned | `credentials/credential-connection-status-proxy.ts` |
| Workflow reviews | `feat:workflowReviews` | Review and approve workflow changes before publish. | Removed (module). The database entities, ordinary repositories and the editor feature stay. | Open | `@n8n/db` workflow-review repositories, `@n8n/api-types` workflow-review DTOs, `editor-ui/src/features/workflow-reviews` |
| Evaluations | `quota:evaluations:*` | Test AI workflows against datasets. | Kept, enterprise code (`cli/src/evaluation.ee`, editor `evaluation.ee`) | Open | |
| Variables | `feat:variables` | Variables (`$vars`) for the instance and projects. | Kept, enterprise code (editor `environments.ee`) | Open. Today: a Data table. | [Variables](https://docs.n8n.io/code/variables/) |
| Execution search and tagging | `feat:advancedExecutionFilters` | Search executions by custom data, and annotate them. | Free with a key | None needed | [Custom execution data](https://docs.n8n.io/workflows/executions/custom-executions-data/) |
| Debug in editor | `feat:debugInEditor` | Load the data of a past execution into the editor. | Free with a key | None needed | [Debug](https://docs.n8n.io/workflows/executions/debug/) |
| Folders | `feat:folders` | Nested folders for workflows. | Free with a key | None needed | No public page found |
| Workflow diffs | `feat:workflowDiffs` | Compare versions of a workflow. | Not checked | Open. Git sync keeps the history in Git. | [Workflow history](https://docs.n8n.io/workflows/history/) |
| Named versions | `feat:namedVersions` | Give a name to a workflow version. | Not checked | Open | [Workflow history](https://docs.n8n.io/workflows/history/) |
| Insights | `feat:insights:viewSummary`, `:viewDashboard`, `:viewHourlyData` | Execution counts, failure rates and time saved. | Gated, ordinary code (`modules/insights`) | Open | [Insights](https://docs.n8n.io/insights/) |
| Data redaction | `feat:dataRedaction` | Hide execution data. | Gated, ordinary code (`modules/redaction`) | Open | No public page found |
| OpenTelemetry span attributes | `feat:otel:customSpanAttributes` | Custom attributes on OpenTelemetry spans. | Gated, ordinary code (`modules/otel`) | Open | [OpenTelemetry](https://docs.n8n.io/hosting/logging-monitoring/opentelemetry/) |
| Node type policies | `feat:typeAvailabilityPolicies` | Limit the node and credential types that users can use. | Gated, ordinary code (`modules/type-availability-policies`) | Open | Public API `node-type-policies.public.controller.ts` |
| Token exchange | `feat:tokenExchange` | Sign-in with tokens from a trusted issuer. | Gated, ordinary code (`modules/token-exchange`) | Not planned | |
| Personal space policy | `feat:personalSpacePolicy` | Limit what users can do in their personal space. | Not checked | With priority 1 | |
| Non-production banner | `feat:showNonProdBanner` | A banner on instances that are not production. | Not checked | Open, small | |
| Custom community node registry | `feat:communityNodes:customRegistry` | Install community nodes from a private registry. | Not checked | Not planned | |
| API disabled | `feat:apiDisabled` | Turn the public API off (for some n8n plans). | Not checked | Not planned | |
| Binary and execution data in S3 or Azure | `feat:binaryDataS3`, `feat:binaryDataAz`, `feat:executionDataS3`, `feat:executionDataAz` | Keep files and execution data in object storage. | Kept, enterprise code (`@n8n/blob-storage`) | Not planned. One server keeps the data in PostgreSQL. | [External storage](https://docs.n8n.io/hosting/scaling/external-storage/) |
| Multiple main instances | `feat:multipleMainInstances` | More than one main process, for high availability. | Kept, enterprise code (`scaling/multi-main-setup.ee.ts`) | Not planned | [Queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) |
| Worker view and worker pools | `feat:workerView`, `feat:workerPools` | Worker status page, and execution routing to worker pools. | Kept, enterprise code (`scaling`, editor `orchestration.ee`) | Not planned | [Queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) |
| AI assistant and AI builder | `feat:aiAssistant`, `feat:askAi`, `feat:aiBuilder` | AI help in the editor, from a service of n8n. | Kept, enterprise code (`@n8n/ai-workflow-builder.ee`) | Not planned. They need the n8n service. | |
| AI credits and AI gateway | `feat:aiCredits`, `feat:aiGateway`, `feat:aiGatewayCloudUbb`, `feat:aiAssistantCloudUbbEntitlement` | Model access paid through n8n. | Not checked | Not planned. Use your own model credentials. | |

## Licence quotas

| Quota | Without a licence | Fork plan |
|---|---|---|
| `quota:maxTeamProjects` | 0 team projects | Priority 1. No limit from step 5 of FORK.md. |
| `quota:users`, `quota:activeWorkflows`, `quota:maxVariables` | No limit | None needed |
| `quota:workflowHistoryPrune` | 24 hours of workflow history | Open. Git sync keeps the history in Git. |
| `quota:insights:*` | Not checked | With insights |
| `quota:evaluations:*` | Not checked | Open (evaluations are enterprise code, `evaluation.ee`) |
| `quota:aiCredits` | 0 | Not planned |
| `quota:aiGatewayBudget` | Not checked | Not planned |
