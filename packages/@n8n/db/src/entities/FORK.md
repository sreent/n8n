# The fork's entities in @n8n/db

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md).

## The workflow review tables

The enterprise module of workflow reviews is gone (step 1 of FORK.md). Its six database entities
stayed, because ordinary repositories use them. The fork replaced them in step 4 with its own
entities, with the same names and exports:

| Fork file | Table | Enterprise file that it replaces |
| --- | --- | --- |
| `workflow-review-request.ts` | `workflow_review_request` | `workflow-review-request.ee.ts` |
| `workflow-review-request-workflow.ts` | `workflow_review_request_workflow` | `workflow-review-request-workflow.ee.ts` |
| `workflow-review-request-reviewer.ts` | `workflow_review_request_reviewers` | `workflow-review-request-reviewer.ee.ts` |
| `workflow-review-request-author.ts` | `workflow_review_request_authors` | `workflow-review-request-author.ee.ts` |
| `workflow-review-activity.ts` | `workflow_review_activity` | `workflow-review-activity.ee.ts` |
| `workflow-review-activity-comment.ts` | `workflow_review_activity_comment` | `workflow-review-activity-comment.ee.ts` |

`workflow-review-request.ts` also exports `WorkflowReviewRequestStateList`,
`WorkflowReviewRequestState`, `WorkflowReviewRequestDecisionList` and
`WorkflowReviewRequestDecision`, as the enterprise file did.

### Sources

- The columns, their types and their defaults: the ordinary migrations
  `CreateWorkflowReviewRequestTables1784000000052`,
  `CreateWorkflowReviewActivityTablesAndBaseline1785843640527` and
  `DropWorkflowReviewActivityTypeCheckAndWorkflowIdColumn1787089039727`.
- The property names, the ID generation and the timestamps: the ordinary repositories
  `workflow-review-*.repository.ts` and `workflow-history.repository.ts`, the ordinary migration
  test of the activity tables, and the ordinary integration test of `WorkflowHistoryRepository`.
- The type of an activity entry: `WorkflowReviewActivityType` in `@n8n/api-types`.

### Behaviour

- The entities have columns only, with no relations: the ordinary repositories join the tables
  with explicit conditions. The migrations keep the foreign keys and the indexes.
- A request and a request workflow get a nano ID when the caller gives none
  (`WithStringId`). A request has `createdAt` and `updatedAt`, and `save()` updates `updatedAt`.
- An activity entry and a comment get an auto-increment ID and `createdAt`. `typeVersion` takes
  the database default `1`. `data` and `history` are JSON. The `updatedAt` and `deletedAt` of a
  comment are plain dates that the code sets.

### Tests

- `packages/cli/test/integration/database/repositories/workflow-review.repositories.test.ts` (fork
  test) runs each ordinary review repository on the fork entities.
- The ordinary migration test of the activity tables and the ordinary integration test of
  `WorkflowHistoryRepository` save and read rows through these entities.

### Clean-room record

Early in step 4, one search without the exclusion globs printed one decorator line of two of the
replaced enterprise files: `@PrimaryColumn({ type: 'uuid' })` of the reviewer and author entities.
The fork reported it in pull request 35. These entities take the type of `userId` from the
migration (`column('userId').uuid.notNull.primary`).

## The execution annotation tables

The fork replaced the three entities of execution annotations in step 4 with its own entities,
with the same names and exports: `annotation-tag-entity.ts`, `annotation-tag-mapping.ts` and
`execution-annotation.ts`. Their repositories are `annotation-tag.repository.ts` and
`annotation-tag-mapping.repository.ts`.
[packages/cli/src/executions/FORK.md](../../../../cli/src/executions/FORK.md#execution-annotations)
describes them with the rest of the feature.

## Upstream updates

`scripts/sync-upstream.sh` deletes the replaced enterprise files again. When an upstream migration
changes one of these tables, change the fork entity, and run the integration tests of the tables.
