# Send a copy

Fork module (not in upstream n8n). A user sends an independent copy of a workflow to
colleagues. Each colleague gets a new, unpublished workflow in their personal space. This is
not live sharing: a change to the original does not change the copies, and a change to a copy
does not change the original.

The frontend module `packages/modules/send-copy/frontend` adds **Send a copy** to the workflow
menu and to the workflow cards. Its README describes the editor part.

To turn the module off, add `send-copy` to `N8N_DISABLED_MODULES`.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `GET /rest/send-copy/recipients` | Global scope `user:list` | Lists the users who can receive a copy |
| `POST /rest/send-copy/workflows/:workflowId` | Project scope `workflow:read` | Sends a copy of the workflow to the recipients |

- `GET /recipients` takes `search` (at most 100 characters) and `limit` (1 to 50, default 20).
  It gives `id`, `firstName`, `lastName` and `email` only, and leaves out the sender.
- `POST /workflows/:workflowId` takes `recipientIds`: 1 to 20 user IDs. A user can send at most
  30 requests in one minute.
- As the workflow routes of n8n do, the route answers 403 when the sender cannot read the
  workflow, and 404 when the workflow does not exist.

The answer of `POST` has one result for each recipient, in the order of the request. A failure
for one recipient does not stop the copies for the other recipients.

| Status | Reason | Cause |
|---|---|---|
| `sent` | | The recipient has the copy. The result gives `workflowId` and `workflowName` |
| `failed` | `self` | The recipient is the sender |
| `failed` | `not-found` | The user does not exist |
| `failed` | `not-eligible` | The user is disabled, has not accepted the invitation, or is a chat user |
| `failed` | `error` | n8n could not make the copy. The result gives the message |

## What the copy keeps

`workflow-copy.builder.ts` builds the copy from an allow-list of fields:

- The name becomes `<original name> (from <sender>)`, cut to the length of the column.
- The description tells where the copy comes from, then gives the original description.
- The nodes and the connections stay. The values typed into node parameters stay too, and the
  modal of the editor tells the sender so.
- The nodes lose their credentials. A recipient selects their own credentials.
- A webhook node gets a new webhook ID. When its path is not an expression, the path becomes the
  new ID, so the copy does not use the URLs of the original.
- The settings stay, except the settings that point to resources of the sender:
  `errorWorkflow`, `callerIds`, `callerPolicy`, `credentialResolverId` and `availableInMCP`.
- The node groups and the tags stay.

The copy does not keep pinned data, static data, metadata, versions, the publish state, the
folder, the sharing or `sourceWorkflowId`. Package import matches workflows by
`sourceWorkflowId`, so a copy must not claim the identity of the original.

## How the copy is made

The service makes each copy as the recipient, through `WorkflowCreationService`, in the personal
project of the recipient. Thus the usual permission and policy checks of that project apply.
When a check stops the copy, the result of that recipient is `failed` with the reason `error`.

n8n sends the event `workflow-created` with `uiContext: 'send-copy'` for each copy. The audit
log and log streaming thus record each copy as `n8n.audit.workflow.created`, with the recipient
as the user.

## Tests

- `__tests__/workflow-copy.builder.test.ts`: the fields of the copy.
- `__tests__/send-copy.service.test.ts`: the results for each recipient.
- `__tests__/send-copy.integration.test.ts`: the routes, the access checks and the copies in the
  database. Run it with `--config vitest.config.integration.ts`.
