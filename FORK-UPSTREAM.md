# FORK-UPSTREAM.md

The checklist for an upstream update of the fork. [FORK.md](FORK.md#upstream-updates) tells the
steps of an update. This file tells what each update must keep and check.

When a pull request adds fork lines to an upstream file, it adds a row to the first table. When it
adds a golden test, it adds a row to the second table.

## Fork lines in upstream files

The fork changes about 470 upstream files. Most of the changes are import paths to fork code, and
a merge keeps them without help. The files in this table need more care. When an upstream update
changes one of them, do what the second column tells.

To list all the upstream files that the fork changes, fetch the base commit of
`scripts/sync-upstream.base` (the sync script does this), then run
`git diff --name-status <base> HEAD -- . ':!*.ee.*' ':!**/*.ee/**'`.

| When an upstream update changes | Do this | Details |
|---|---|---|
| `README.md` | Keep the README of the fork. | |
| `isLicensed` or `getValue` of `packages/cli/src/license.ts`, or the `setupFiles` of `packages/cli/vitest.config.base.ts` | Keep the fork lines of the fork switch. | [FORK.md](FORK.md#the-fork-switch) |
| The licence routes, the page Settings > Usage and plan, or the registration of the Community Edition | Keep the fork removal. | [packages/cli/src/license/FORK.md](packages/cli/src/license/FORK.md) |
| Scopes or roles | Make the permission data again. The scope snapshot test of `@n8n/permissions` fails when upstream adds a scope. | [packages/@n8n/permissions/FORK.md](packages/@n8n/permissions/FORK.md) |
| `packages/cli/src/instance-settings-loader/instance-settings-loader.service.ts` | Keep the fork loader of workflow reviews and the redaction floor. | [packages/cli/src/instance-settings-loader/FORK.md](packages/cli/src/instance-settings-loader/FORK.md) |
| `packages/cli/src/server.ts`, the list `eventNamesAudit` of `packages/cli/src/eventbus/event-message-classes/index.ts`, or the type `RelayEventMap` | Keep the fork lines of the governance audit events (`ForkGovernanceEventRelay`). | [packages/cli/src/modules/audit-log/README.md](packages/cli/src/modules/audit-log/README.md) |
| The public API handler `packages/cli/src/public-api/v1/handlers/log-streaming/log-streaming.handler.ts` | Keep the fork version. | [packages/cli/src/modules/log-streaming/README.md](packages/cli/src/modules/log-streaming/README.md) |
| The public API controller `packages/cli/src/public-api/v1/controllers/source-control.public.controller.ts` | Keep the import paths of the fork module. | [packages/cli/src/modules/source-control/README.md](packages/cli/src/modules/source-control/README.md) |
| The public API controller `packages/cli/src/public-api/v1/controllers/promotions.public.controller.ts` | Keep the import paths of the fork module and the user arguments of the audit events. | [packages/cli/src/modules/promotions/README.md](packages/cli/src/modules/promotions/README.md) |
| The pubsub commands: `pubsub-metadata.ts` of `@n8n/decorators`, and `pubsub.event-map.ts` and `pubsub.types.ts` of `packages/cli/src/scaling/pubsub` | Keep the fork command `reload-ldap-config`. | [packages/cli/src/modules/ldap/README.md](packages/cli/src/modules/ldap/README.md) |
| `packages/cli/src/credentials/credentials.service.ts`, or the ordinary tests of dynamic credentials | Keep the import paths of the fork module. | [packages/cli/src/modules/dynamic-credentials/README.md](packages/cli/src/modules/dynamic-credentials/README.md) |
| `packages/cli/src/services/ai-gateway.service.ts`, `packages/cli/src/services/frontend.service.ts`, `packages/frontend/editor-ui/src/app/composables/useAiGatewayTopUp.ts` or `packages/frontend/editor-ui/src/features/ai/gateway/components/AiGatewayTopUpModal.vue` | Keep the fork lines of the AI gateway. When the update changes the protocol of the gateway or adds a provider to Gateway credits, change the fork module. | [packages/cli/src/modules/ai-gateway/README.md](packages/cli/src/modules/ai-gateway/README.md) |
| The lists of `packages/nodes-base/package.json` | Keep the two lines of the node Google Cloud OCR and its credential type. | [packages/nodes-base/nodes/Google/CloudOcr/README.md](packages/nodes-base/nodes/Google/CloudOcr/README.md) |
| `packages/@n8n/api-types/src/dto/user/user-public.dto.ts` or `packages/cli/src/public-api/v1/controllers/users.public.controller.ts` | Keep the fork field `lastActiveAt`. | [packages/cli/src/governance/README.md](packages/cli/src/governance/README.md) |
| A new public route for the audit log, for the insights of each workflow, for an inventory of workflows or for a list of all API keys | Compare it with the fork route. Keep one of them. | [packages/cli/src/governance/README.md](packages/cli/src/governance/README.md) |
| How ordinary code uses the S3 and Azure classes of `@n8n/blob-storage` | Change the fork classes. | [packages/@n8n/blob-storage/FORK.md](packages/@n8n/blob-storage/FORK.md) |
| `initBinaryDataService` or `initObjectStoreIfConfigured` of `packages/cli/src/commands/base-command.ts` | Keep the fork method `isObjectStoreConfigured`, which starts the object store for Google Cloud Storage too. | [packages/@n8n/blob-storage/FORK.md](packages/@n8n/blob-storage/FORK.md#google-cloud-storage) |
| How ordinary code uses the scaling classes `MultiMainSetup`, `WorkerStatusService`, `WorkerPoolsService` and `PoolConfigService` | Change the fork classes. | [packages/cli/src/scaling/FORK.md](packages/cli/src/scaling/FORK.md) |
| A migration of a workflow review table or of the table `project_pool_settings` | Change the fork entity. | [packages/@n8n/db/src/entities/FORK.md](packages/@n8n/db/src/entities/FORK.md) |
| Ordinary code that imports a new name from `@n8n/ai-workflow-builder` | Add the name to the fork package. | [packages/@n8n/ai-workflow-builder/FORK.md](packages/@n8n/ai-workflow-builder/FORK.md) |
| `src/app/composables/useWorkflowActivate.ts`, `src/app/capabilities.manifest.ts`, `src/app/event-bus/node-view.ts`, `src/app/components/MainHeader/WorkflowHeaderDraftPublishActions.vue` or `src/features/ndv/panel/components/TriggerPanel.vue` of editor-ui | Keep the fork lines of the open-trigger fixes, the check before the dialogs of a publish and the notice of a test URL. | [packages/modules/open-triggers/frontend/README.md](packages/modules/open-triggers/frontend/README.md) |
| `src/app/components/MainHeader/WorkflowHeaderDraftPublishActions.vue`, `src/app/components/MainHeader/ActionsDropdownMenu.vue` or `src/app/event-bus/node-view.ts` of editor-ui | Keep the Move button of a blocked publish. | [packages/frontend/editor-ui/FORK.md](packages/frontend/editor-ui/FORK.md#the-move-button-of-a-blocked-publish) |
| The authentication options of the Webhook, Form Trigger, Chat Trigger or MCP Server Trigger node | Change `open-trigger.detector.ts` of the open-triggers module. | [packages/cli/src/modules/open-triggers/README.md](packages/cli/src/modules/open-triggers/README.md) |
| `packages/cli/src/webhooks/test-webhooks.ts` | Keep the fork line that asks `TestWebhookCallGuards` before the request loses its cookies. | [packages/cli/src/modules/open-triggers/README.md](packages/cli/src/modules/open-triggers/README.md) |
| The wa-sqlite commit in `packages/frontend/editor-ui/package.json` | Keep the upstream line. Then run `scripts/vendor-wa-sqlite.sh`. | `vendor/` in [FORK.md](FORK.md#what-the-fork-adds) |

## Snapshot tests of the rebuilt features

The golden tests record how the original enterprise code behaved. They fail when an update changes
what the rebuilt code must do. Compare the change with the upstream change, then update the fork
code or the snapshot. To record a snapshot again, follow [FORK.md](FORK.md#upstream-updates).

| Area | Tests | They fail when an update changes |
|---|---|---|
| Permissions | The snapshot tests of `packages/cli/src/permissions` | What a role may do |
| Projects | The snapshot tests of `packages/cli/src/services` | How projects work |
| Sharing | The snapshot tests of `packages/cli/src/workflows` | How sharing works |
| Execution view | The snapshot tests of `packages/cli/src/executions` | Which executions a user sees |
| Execution annotations | `packages/cli/test/integration/annotation-tags.api.test.ts` and the two editor tests that [packages/cli/src/executions/FORK.md](packages/cli/src/executions/FORK.md#execution-annotations) names | The annotations |
| Variables | `packages/cli/test/integration/variables.api.test.ts` and the editor test in `packages/frontend/editor-ui/src/features/settings/environments` | The variables |
| SSO | The snapshot tests of `packages/cli/src/sso`, `packages/cli/src/modules/sso-oidc`, `packages/cli/src/modules/provisioning` and `packages/cli/src/modules/sso-saml` | The sign-in method, the OIDC sign-in, the role provisioning or the SAML sign-in |
| LDAP | `packages/cli/test/integration/ldap/ldap.golden.test.ts` | LDAP |
| External secrets | The snapshot tests of `packages/cli/src/modules/external-secrets` | The secrets providers, the queries of their connections or the module |
| External secrets editor | The snapshot tests of `packages/frontend/editor-ui/src/features/integrations/externalSecrets` and `packages/frontend/editor-ui/src/features/integrations/secretsProviders` | The REST clients, the store, the settings page, or the settings pages of the connections |
| Sharing UI | The snapshot tests of `packages/frontend/editor-ui` that its [FORK.md](packages/frontend/editor-ui/FORK.md) names | The sharing UI and the `EnterpriseEdition` gate |
| Evaluations | `packages/cli/test/integration/database/repositories/agent-eval.repositories.test.ts`, `packages/nodes-base/nodes/Evaluation/test/Evaluation.golden.test.ts`, the `*.golden.test.ts` files in `packages/cli/test/integration/evaluation`, and the golden tests in `packages/frontend/editor-ui/src/features/ai/evaluation/__tests__/golden` | The agent eval tables, the Evaluation nodes, the evaluation backend or its editor |
| AI workflow builder | `packages/cli/src/services/__tests__/golden/ai-workflow-builder.golden.test.ts` | The local parts of the AI workflow builder |
| Workflow reviews | `packages/cli/test/integration/workflow-reviews/workflow-reviews.golden.test.ts` | The workflow reviews |
| Object storage | The golden tests in `packages/@n8n/blob-storage/src/__tests__/golden` | The S3 and Azure Blob storage |
| Source control | The golden tests in `packages/cli/test/integration/source-control` and `packages/frontend/editor-ui/src/features/integrations/sourceControl/__tests__/golden` | Source control or its editor |
| Git connections | The golden tests in `packages/cli/test/integration/promotions` and `packages/frontend/editor-ui/src/features/integrations/promotions/__tests__/golden` | Git connections or their editor |
| Scaling | The golden tests in `packages/cli/src/scaling/__tests__/golden`, `packages/cli/test/integration/worker-pools` and `packages/frontend/editor-ui/src/features/settings/orchestration/__tests__/golden` | The multi-main setup, the worker status, the worker pools or the worker view |
| Dynamic credentials | The golden tests in `packages/cli/test/integration/dynamic-credentials` | Dynamic credentials |
