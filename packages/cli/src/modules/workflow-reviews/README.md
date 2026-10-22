# Workflow reviews

Fork module (not in upstream n8n). It replaces the enterprise module `workflow-reviews.ee` of
upstream n8n, which the fork removed. A user submits a saved version of a workflow for a review. A
reviewer comments, requests changes or approves. An approval publishes the reviewed version. While
a review is open, nobody can publish the workflow.

The repository owner chose on 2026-10-14 to rebuild the enterprise features that the fork removed,
workflow reviews first (FORK-FEATURES.md, "Parity with the Enterprise Edition"). The editor part is
ordinary upstream code (`packages/frontend/editor-ui/src/features/workflow-reviews`), and so are
the DTOs (`@n8n/api-types`), the repositories and the migrations (`@n8n/db`). The fork rebuilt the
entities of the review tables before (`packages/@n8n/db/src/entities/FORK.md`). This module is the
backend: the REST API, the publish guard and the lifecycle of the reviews.

## Set up

- The licence value `feat:workflowReviews` turns the module on. The fork switch gives it
  (`packages/cli/src/fork-features.ts`), and `N8N_FORK_FEATURES_ENABLED=false` turns it off. The
  module starts only when n8n starts with the licence value.
- An instance admin turns reviews on at **Settings > Security & policies** (the setting
  `security.workflowReviews`, off by default). With `N8N_SECURITY_POLICY_MANAGED_BY_ENV=true`, the
  page cannot change it (ordinary code), and the fork variable `N8N_WORKFLOW_REVIEWS_ENABLED` sets
  it at each start (see
  [the FORK.md of the settings loaders](../../instance-settings-loader/FORK.md)). `deploy/` sets
  both.
- When the policy is off, each route of the module answers 403 ("Workflow reviews are disabled on
  this instance"), and an open review does not stop a publish.

## Sources

The fork wrote this module from these sources only:

- The public documentation: [Workflow reviews](https://docs.n8n.io/build/manage-workflows/workflow-reviews/).
- Ordinary code: the DTOs and the push message in `@n8n/api-types`, the entities, repositories and
  migrations of the review tables in `@n8n/db`, `WorkflowPublishGuardProxy`,
  `WorkflowMutationHooksProxy`, `WorkflowReviewPolicyService`, `WorkflowPublishBlockedError`, the
  events of the relays, `CollaborationService.broadcastWorkflowReviewStateChanged`, the editor
  feature and the Playwright test `tests/e2e/workflow-reviews`.
- The behaviour of the original module, as a black box: the golden test
  `packages/cli/test/integration/workflow-reviews/workflow-reviews.golden.test.ts` calls each route
  as users with each role, and records the answers, the rows of the tables, the events and the push
  signals. The snapshot was recorded against the original module in a checkout of the upstream
  commit of `scripts/sync-upstream.base`, and this module gives the same snapshot.

## Who may do what

| Action | Who |
|---|---|
| List the eligible reviewers, submit a review, submit a new version | Users with `workflow:publish` on the workflow |
| See the reviews of a workflow (`GET /workflow-review-requests?workflowId=`) | Users with `workflow:read` on the workflow. The review description shows only to users with `workflow:publish` |
| Open a review, its activity, comment | The instance owner and admins (all reviews). Other users: the admins of the project of the review (role `project:admin`), the authors and the reviewers, while they can read a linked workflow (or no workflow is left) |
| Decide (approve or request changes) | An assigned reviewer, an admin of the project of the review, the instance owner or an admin. An author who is none of these cannot decide |
| Be a reviewer | Users who can read the workflow, except the requester, pending users and disabled users |

- A custom project role is never a project admin for reviews, also with all the scopes of
  `project:admin`. Only the role `project:admin` counts.
- The authors of a review are the requester and each user who submitted a new version.
- `decidedVia` of the event is `assigned-reviewer` when the decider is an assigned reviewer, else
  `admin-override`.

## The REST API

All routes are below `/rest/workflow-review-requests`. They need the licence value (else the
licence answer, 403), and the policy (else 403). The checks run in the order of the lists.

### `GET /eligible-reviewers?workflowId=`

1. The caller needs `workflow:publish` on the workflow, else 404 "Could not find workflow".
2. The answer is `{ count, data }`. `data` holds `{ id, email, firstName, lastName }` of each user
   who can read the workflow: the users with a global role that reads all workflows, and the members
   of the projects that the workflow is shared with. It leaves out the caller, pending users and
   disabled users, and it is in the order of the e-mail addresses (a missing e-mail address sorts
   as the text `null`).

### `POST /` (submit a review)

The body is `CreateWorkflowReviewRequestDto`: a title, a description, one workflow with a version,
a version name and a version description, and up to 10 reviewers.

1. The caller needs `workflow:publish` on the workflow, else 404 "Could not find workflow".
2. An archived workflow: 400 "The workflow '<id>' is archived and cannot be submitted for review".
3. The version must be a version of the workflow, else 400 "Version '<version>' does not exist for
   workflow '<workflow>'".
4. The caller as a reviewer: 400 "You cannot assign yourself as a reviewer".
5. Reviewers who may not review (see above), and unknown users: 400 "These users are not eligible
   to review this workflow: <ids>", in the order of the request, separated by `, `.
6. An open review of the workflow: 409 "An open review request already exists for this workflow",
   with the hint "Update the existing review request instead of creating a new one" and
   `meta.workflowReviewRequestId`.
7. The module writes the request (in the owning project of the workflow, with a blank description
   as `null`), the link with the pinned version, the requester as the first author, the reviewers
   (each one once), and the activity `review.opened`. It gives the version the name and the
   description of the body (a blank description removes it). The answer is 201 with the summary
   `{ id, state, decision, workflowVersionId, createdAt, updatedAt }`.
8. The event `workflow-review-requested`, and the push signal of the workflow.

### `POST /:id/update-version` (submit a new version)

The body is `UpdateWorkflowReviewRequestVersionDto`.

1. An unknown request, or a workflow that the request does not link: 404 "Could not find review
   request".
2. The caller needs `workflow:publish` on the workflow, else 404 "Could not find workflow".
3. A closed request: 409 "The review request is no longer open".
4. An unknown version: 400 "Version '<version>' does not exist for workflow '<workflow>'".
5. The pinned version again: the module only sets the name and the description of the version and,
   when the body has one, the description of the review. A changed review description sends the
   push signal. Nothing else changes.
6. A new version: the link pins it, the decision goes back to `pending`, the caller becomes an
   author, the activity `review.version_updated` (`workflowId`, `fromWorkflowVersionId`,
   `toWorkflowVersionId`), the event `workflow-review-version-updated` and the push signal. A blank
   review description removes it.
7. The answer is the summary.

### `POST /:id/decision`

The body is `DecideWorkflowReviewRequestDto`: `approved` or `changes_requested`, and a note.

1. A request that the caller may not open: 404 "Could not find review request". A request without
   a linked workflow: also 404.
2. An author who may not decide: 403 "Authors cannot decide on their own review request".
3. A closed request: 409 "The review request is no longer open".
4. `changes_requested` without a note: 400 "A note is required when requesting changes".
5. `changes_requested`: the decision, the activity `review.changes_requested` (`workflowVersions`,
   `note`), the event `workflow-review-decided` and the push signal. The answer is the summary.
6. `approved`: the module closes the request with the decision `approved`, keeps the published
   version of the workflow as the baseline of the review, and writes the activity
   `review.approved`. Then it publishes the pinned version as the requester (source
   `review-approval`). The answer is the summary with `autoPublish`: `{ status: 'published' }`, or
   `{ status: 'failed', message }` when the requester is gone ("The review requester is no longer
   available"), may not publish ("The review requester no longer has permission to publish this
   workflow"), or the publish fails (its message). `closedById` is the decider, or `null` when the
   requester is gone or may not publish. The review stays approved when the publish fails.

### `POST /:id/comments`

1. A request that the caller may not open: 404 "Could not find review request".
2. A request without a linked workflow that the caller can read: 403 "You are not allowed to
   comment on this review".
3. A closed request: 409 "The review request is no longer open".
4. The module writes the activity `comment.created` with the message, and the event
   `workflow-review-comment-created`. The answer is 201 with the activity entry.

### The reads

- `GET /?workflowId=&state=&skip=&take=`: the reviews of a workflow, the newest first, with the
  name of the pinned version, `decisionBy` (the user who requested changes, while the decision is
  `changes_requested`) and `viewerCanOpen`.
- `GET /inbox?state=&category=&limit=&cursor=`: the reviews that the caller may open, the newest
  first, 15 by default. `waiting` holds the reviews where the caller is a reviewer or not an
  author, `authored` the others. The cursor is opaque. A bad cursor: 400 "Invalid pagination
  cursor".
- `GET /summary`: the number of open and closed reviews that the caller may open.
- `GET /:id`: the review with its workflows. `baselineVersion` is the published version while the
  review is open, and the version that the approval kept after that. `viewerCanDecide`,
  `viewerDecisionIneligibilityReason` and `viewerCanComment` follow the rules above.
- `GET /:id/activity?limit=&cursor=`: the feed, 25 entries by default, the newest page first, each
  page in the order of the entries.

The authors and the reviewers come in the order of their user ids.

## The lifecycle

The module registers providers on `WorkflowPublishGuardProxy` and `WorkflowMutationHooksProxy`:

- **Publish:** while the policy is on, an open review stops the publish of a new version with
  `WorkflowPublishBlockedError` (`review_pending`, or `changes_requested`). A publish of the
  published version again is not checked (ordinary code).
- **Published:** each publish adds the activity `workflow.published` to each review, open or
  closed, that pins the published version, and sends the push signal of the workflow.
- **Archived, moved, deleted:** the module adds `workflow.archived`, `workflow.moved` or
  `workflow.deleted` to the open reviews of the workflow. Then it closes each of them that has no
  reviewable workflow left (a workflow that exists, is not archived and is still in the project of
  the review) with the activity `review.closed` (`no-reviewable-workflows`), the event
  `workflow-review-closed` with the cause, and the push signal.
- At the start, the module closes the open reviews that have no reviewable workflow left, for
  example after a change that ran without the hooks. The cause is then `unknown`.

The changes of the reviews run one at a time, in a transaction with the database lock
`DbLock.WORKFLOW_REVIEW_MUTATION` of `@n8n/db` (an advisory lock on Postgres, an in-process lock on
SQLite). Under the lock, a submit checks again for an open review of the workflow, and a new
version, a decision and a comment check again that the review is open. Thus two calls at the same
time cannot both pass these checks.

## Files

| File | Purpose |
|---|---|
| `workflow-reviews.module.ts` | The module: the controller, the providers and the start-up sweep |
| `workflow-reviews.controller.ts` | The REST API |
| `workflow-review.service.ts` | Submit, new versions, decisions, comments and the auto-publish |
| `workflow-review-read.service.ts` | The reads and the eligible reviewers |
| `workflow-review-access.service.ts` | Who may open, decide and comment, and the inbox visibility |
| `workflow-review-lifecycle.service.ts` | The publish guard and the mutation hooks |
| `workflow-review-mapper.ts` | The users, summaries and activity entries of the answers |
| `workflow-review-cursor.ts` | The cursors of the inbox and the activity |
| `__tests__/` | Unit tests of the access rules and the cursors |

The golden test `packages/cli/test/integration/workflow-reviews/workflow-reviews.golden.test.ts`
covers the routes, the tables, the events, the push signals and the lifecycle.
