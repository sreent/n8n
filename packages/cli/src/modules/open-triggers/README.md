# Open triggers

Fork module (not in upstream n8n). A trigger without authentication accepts calls from anyone who
knows its URL. This module finds these triggers, and it can stop a publish until a workflow review
approves them:

- **The publish check.** With `N8N_OPEN_TRIGGERS_NEED_APPROVAL=true`, a publish stops for a new
  open trigger. The user adds authentication, or gets an approval in a workflow review.
- **The guard of the test URLs.** With the same variable, the test URL of an open trigger takes
  calls only from n8n users who may run the workflow, until a review approves the trigger.
- **The list.** `GET /rest/open-triggers` (the page Settings > Open triggers) and
  `GET /api/v1/inventory/open-triggers` (the public API) give the open triggers of the published
  workflows, with their approvals.

The module starts by default, also with the check off. `N8N_DISABLED_MODULES=open-triggers` turns
it off.

## Set up

1. Set `N8N_OPEN_TRIGGERS_NEED_APPROVAL=true`. n8n reads the variable at the start.
2. Turn on workflow reviews: the setting `security.workflowReviews` (Settings > Security &
   policies, or `N8N_WORKFLOW_REVIEWS_ENABLED` with an env-managed security policy). Without
   reviews, nobody can approve an open trigger, and the message of the check says only "Add
   authentication".

`deploy/` sets both (`OPEN_TRIGGERS_NEED_APPROVAL` and `WORKFLOW_REVIEWS` in `.env`).

## Open triggers

The check reads four node types. A disabled node is never open. The rule is
`openTriggerKindOf` of `@n8n/api-types` (`utils/open-trigger-kind.ts`), so the backend and the
editor use the same one.

| Node | Open when | Closed by |
|---|---|---|
| Webhook (`n8n-nodes-base.webhook`) | `authentication` is `none`, missing, an expression or an unknown value | Basic Auth, Header Auth, JWT Auth, n8n User Auth (OAuth2) |
| Form Trigger (`n8n-nodes-base.formTrigger`) | version 1 (no authentication), or `authentication` as for the webhook | Basic Auth, n8n User Auth (version 2.6 and later in the editor) |
| Chat Trigger (`@n8n/n8n-nodes-langchain.chatTrigger`) | `public` is true or an expression, and `authentication` as for the webhook | Basic Auth, n8n User Auth, or a chat that is not public |
| MCP Server Trigger (`@n8n/n8n-nodes-langchain.mcpTrigger`) | `authentication` as for the webhook | Bearer Auth, Header Auth, n8n User Auth (OAuth2) |

- The values come from the code of the nodes. The shared webhook check of n8n-nodes-base lets an
  unknown value through without a check, so an unknown value is open.
- `N8N_DISABLE_PUBLIC_CHAT_TRIGGER=true` closes all chats.
- An IP allowlist of a node does not close it. A reviewer can approve such a trigger.
- Other trigger nodes, for example the GitHub Trigger, register their own URL with their service.
  The check does not read them.

## The publish check

`OpenTriggerCheck` (`open-trigger.check.ts`) is a `@PolicyCheck()` of the policy infrastructure at
the point `workflowPublish`. That point runs at each publish: the activate route, the publication
applier and the activation at startup. The check sees the nodes of the version to publish, but not
the user, so it stops the owner and the admins too.

The check allows an open trigger in two cases:

1. **It is in the published version.** A workflow that was published before the check was on keeps
   its open triggers, and a new version that keeps them publishes. The activation at startup reads
   the published version, so the check never stops a workflow that runs now.
2. **An approved workflow review pins a version with it.** A review is approved when its row in
   `workflow_review_request` has `approvedAt`. The version is the `workflowVersionId` of its row in
   `workflow_review_request_workflow`.

An approval covers a trigger node while it keeps its id and its node type, and while it stays open.
A change of the path or of the other nodes does not need a new approval. A new open trigger, or a
node that was closed in the approved version, needs one. `openTriggerKey` in
`open-trigger.detector.ts` makes the key.

Each other open trigger gives a violation, and the publish answers 403:

```json
{
  "kind": "open-trigger",
  "checkId": "open-triggers",
  "message": "The webhook \"Orders\" accepts calls without authentication. Add authentication, or get an approval in a workflow review.",
  "subject": "<node id>",
  "subjectType": "node"
}
```

The policy infrastructure writes the audit line and the log streaming event
`n8n.audit.policy.decision.blocked` for each stop.

### An approval

1. The editor stops the publish and shows the open triggers. **Request approval** opens the dialog
   of a workflow review for the saved version.
2. A reviewer approves. The approval publishes the version as the requester, and the check allows
   the trigger, because the approved review now pins the version.
3. The approval stays: after an unpublish, the same version publishes again.

An admin can approve the review of an own workflow (`admin-override`, see
[the README of workflow reviews](../workflow-reviews/README.md)).

### Limits

- An unpublish removes the first case: an open trigger that was published before the check, and
  that no review approved, needs an approval after an unpublish.
- The check runs at publish only. An import from the CLI, source control or a Git connection does
  not run it. An imported workflow that is published at the import keeps its open triggers, because
  they are in the published version.
- `GET /rest/open-triggers/workflows/:workflowId/violations` gives the violations that the check
  would give for the saved workflow, with the same messages. It needs the project scope
  `workflow:publish`. The editor asks for them before it opens the dialogs of a publish, so the
  user fixes the triggers first. The publish runs the check again.
- Approvals stay on the instance. A Git connection does not copy them to another instance, so turn
  the check on where the builders publish, for example the development instance, and keep it off
  where the Git connection publishes.
- `n8n publish:workflow` runs no policy check (a gap of the policy infrastructure).

## The test URLs

While a builder listens for a test event, the test URL of a trigger (`/webhook-test/…`,
`/form-test/…`, `/mcp-test/…`) takes one call for at most 2 minutes. With
`N8N_OPEN_TRIGGERS_NEED_APPROVAL=true`, a call to an open trigger goes through only when:

- the caller is signed in to n8n and may run the workflow (`workflow:execute`). The browser of the
  editor sends the session cookie, so a test form or chat opens as before; or
- the published version or an approved version of the workflow has the trigger (the keys of the
  publish check).

n8n answers any other call with 403 and a message that tells the caller to sign in, to add
authentication or to get an approval. The listener stays open. A trigger with authentication does
not change: its node checks the credential, also without a session. A call from a system, for
example curl, Postman or the test event of a SaaS service, needs the authentication of the
trigger (the one-click fix) or an approval. While a trigger listens, the editor tells the builder
so, next to the test URL, and offers the one-click fix.

`TestWebhooks.executeWebhook` asks the guards of `TestWebhookCallGuards`
(`packages/cli/src/webhooks/test-webhook-call-guards.ts`, a fork file) before n8n removes the
cookies of n8n from the request. The module registers `OpenTriggerTestCallGuard` there at its
start. The guard reads the session cookie from the raw `Cookie` header, because the webhook routes
run before the cookie parser, and checks it with `AuthService.authenticateUserByCookie`, without
the browser id header, which a form page or curl does not send. The production URLs do not change:
the publish check covers them.

## The list

`OpenTriggersService.listPublished` gives one item for each open trigger of a published version,
sorted by the names of the workflows and of the nodes. Each user gets the workflows that the user
can read (`workflow:read`). The owner and the admins get all workflows.

| Route | Who | Query |
|---|---|---|
| `GET /rest/open-triggers` | Users with the global scope `workflow:list`: the owner and the admins | none, all items |
| `GET /api/v1/inventory/open-triggers` | API keys with the scope `workflow:list` | `projectId`, `limit` (1 to 250, default 100), `cursor` |

An item has the workflow (`workflowId`, `workflowName`, `homeProject`, `owner` for a personal
space), the node (`nodeId`, `nodeName`, `nodeType`, `typeVersion`), `kind` (`webhook`, `form`,
`chat` or `mcp`), `path` and `approved`. `path` is the path of the URL, the webhook id when the
path is empty, or null for an expression. `approved` is true when an approved review covers the
trigger. It is false for a trigger that was published before the check.

## Files

| File | What it does |
|---|---|
| `open-trigger.detector.ts` | Finds the open triggers in a list of nodes, and makes the key of an approval |
| `open-trigger.check.ts` | The publish check |
| `open-trigger-test-call.guard.ts` | The guard of the test URLs |
| `open-triggers.service.ts` | The allowed keys of a workflow, and the list |
| `database/open-trigger.repository.ts` | The published version and the approved versions of workflows |
| `open-triggers.controller.ts` | `GET /rest/open-triggers` and `GET /rest/open-triggers/workflows/:workflowId/violations` |
| `open-triggers.config.ts` | `N8N_OPEN_TRIGGERS_NEED_APPROVAL` |
| `open-triggers.module.ts` | The module, and the module settings `needApproval` and `publicChatDisabled` for the editor |

The public API route is in
`packages/cli/src/public-api/v1/controllers/open-triggers.public.controller.ts`, and the types are
in `@n8n/api-types` (`dto/workflows/open-trigger.dto.ts`).
