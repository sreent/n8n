# @n8n/frontend-module-open-triggers

Fork module (not in upstream n8n). It adds three things to the editor:

- **The modal of the fixes.** When the publish check of open triggers stops a publish, the editor
  shows the open triggers with a one-click fix for each one, and the button **Request approval**.
- **The notice of a test URL.** While an open trigger listens for a test event, the panel tells
  the builder that its test URL refuses calls from outside n8n, and offers the one-click fix.
- **The page Settings > Open triggers.** The owner and the admins see the open triggers of the
  published workflows, with their approvals.

The backend module is `packages/cli/src/modules/open-triggers`. Its README tells which triggers
are open, when the check stops a publish, and how an approval works.

## The modal of the fixes

`components/OpenTriggerFixesModal.vue`, with the modal key `openTriggerFixes`.

1. When the user selects **Publish**, the header saves the workflow and asks
   `GET /rest/open-triggers/workflows/:workflowId/violations` (`getPublishViolations`) before it
   opens the dialog of a review or of the version (`useOpenTriggerFixes().checkBeforePublish`).
   With violations, this modal opens first. When the request fails, the publish goes on, and the
   publish runs the check again. A publish that answers 403 with violations of the kind
   `open-trigger` also gets the modal: `useWorkflowActivate.ts` of editor-ui gives the violations
   to `useOpenTriggerFixes().showFixes`
   (`packages/frontend/editor-ui/src/app/composables/useOpenTriggerFixes.ts`). For a workflow on
   the canvas, it closes the publish modal and opens this modal. Else the usual toast shows the
   violations.
2. Each open trigger shows its message and its fix (`openTriggerFixFor` in
   `open-triggers.fixes.ts`):

   | Node | Fix | What changes |
   |---|---|---|
   | Webhook | **Add header authentication** | A new Header Auth credential with the header `Authorization` and the value `Bearer <token>`, and `authentication: headerAuth` |
   | MCP Server Trigger | **Add bearer authentication** | A new Bearer Auth credential with the token, and `authentication: bearerAuth` |
   | Form Trigger 2.6 and later, Chat Trigger | **Require n8n sign-in** | `authentication: n8nUserAuth` |
   | Form Trigger before 2.6 | none | The modal tells the user to set Basic Auth or to replace the node |

   The token has 32 random bytes in base64url. The credential goes to the project of the
   workflow, with the name "Token of <node> in <workflow>". The modal shows the header once, with a
   copy button: the credential hides the value later. n8n hides the header `Authorization` in the
   output of the trigger.
3. A fix changes the workflow on the canvas, but does not save it. **Publish** (when all triggers
   have a fix) starts the publish again: the header of the canvas saves the workflow first.
   **Request approval** (when workflow reviews are on) opens the dialog of a workflow review for the
   saved version. The header saves the workflow first here too.
4. The modal lists the other violations of the same publish, for example a blocked node type. Then
   **Publish** stays off.

The modal cannot import the stores of editor-ui, so it calls two capabilities
(`open-triggers.capabilities.ts`). editor-ui provides them in `src/app/capabilities.manifest.ts`:
`openTriggersModalCloser` closes the modal, and `openTriggerActions` applies a fix, starts the
publish, opens the review dialog and selects a node on the canvas.

## The notice of a test URL

`components/OpenTriggerTestUrlNotice.vue`. `TriggerPanel.vue` of editor-ui shows it while a trigger
listens for a test event: under the test URL of a webhook, and under the hint of the other
triggers. It shows when the module setting `needApproval` is on and the node is open, with the
same rule as the backend check (`openTriggerKindOf` of `@n8n/api-types`, with the module setting
`publicChatDisabled`).

- The callout tells that only n8n users who may run the workflow can call the test URL, and that
  other calls get the status 403.
- The button applies the one-click fix of the node through the capability `openTriggerActions`,
  as the modal does. The notice then shows the token once, and tells the builder to stop listening
  and listen again, so that the test URL uses the authentication.
- A Form Trigger before version 2.6 has no fix. The notice tells the builder what to do.

## The page

`views/SettingsOpenTriggersView.vue`. The route is `/settings/open-triggers`. The `rbac` middleware
needs the global scope `workflow:list`, which the owner and the admins have. The settings sidebar
shows the page when the backend module is on and the user has the scope.

- A callout tells whether the publish check is on (the module setting `needApproval`).
- The table shows each open trigger of a published workflow: the workflow (a link to it), the
  project or the personal space, the node, the type, the path and the approval. The page sizes
  are 25, 50 and 100.
- `GET /rest/open-triggers` gives all items at once. The page pages them in the browser.

## Changes outside the module

- The four registrations of a frontend module: the alias in `@n8n/frontend-vite-config`, and the
  dependency, the `paths` and the manifest entry in editor-ui.
- `packages/frontend/editor-ui/src/app/composables/useOpenTriggerFixes.ts` (fork file): the
  actions of the modal on the stores of editor-ui.
- Upstream files with fork lines: `src/app/capabilities.manifest.ts` (the two capabilities),
  `src/app/composables/useWorkflowActivate.ts` (the modal instead of the toast),
  `src/app/event-bus/node-view.ts` (the event `submitWorkflowForReview`),
  `src/app/components/MainHeader/WorkflowHeaderDraftPublishActions.vue` (the event opens the review
  dialog, and the check before the dialogs of a publish) and
  `src/features/ndv/panel/components/TriggerPanel.vue` (the notice of a test URL). Their tests
  have fork tests.
- The texts `openTriggers.*` in `packages/frontend/@n8n/i18n/src/locales/en.json`.
- The module settings `'open-triggers'` in `FrontendModuleSettings` of `@n8n/api-types`, and the
  shared rule `openTriggerKindOf` (`utils/open-trigger-kind.ts`) in its index.

## Commands

Frontend feature module. Consumed from source by the editor-ui shell through
`src/app/modules.manifest.ts`; there is no build step and no `dist`.

Read the full guide at `packages/@n8n/module-cli/frontend-module-guide.md`. It gives the
descriptor contract, the registration points and the known problems. This README gives a
summary only.

```bash
pnpm turbo typecheck --filter=@n8n/frontend-module-open-triggers
pnpm turbo lint --filter=@n8n/frontend-module-open-triggers
pnpm turbo lint:styles --filter=@n8n/frontend-module-open-triggers
pnpm turbo test --filter=@n8n/frontend-module-open-triggers
```
