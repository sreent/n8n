# The fork's changes to the n8n-packages module

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md).

The n8n-packages module is ordinary upstream code. Git sync and Git connections keep their packages
in Git repositories, so the fork adds one change.

## The requirements of older packages

Each requirement of a package (a credential, a data table, a workflow, an agent, a variable, a tag
or a node type) names its consumers. Before n8n 2.45, the field was `usedByWorkflows`, a list of
workflow IDs. n8n 2.45 replaced it with `usedBy`, a list of `{ kind, id }`, and kept
`packageFormatVersion` at `1`. Thus upstream n8n rejects a package that an older version wrote.

The repositories of Git sync and Git connections hold such packages. So the manifest schema of the
fork reads the old field first: `spec/legacy-requirements.ts` changes each `usedByWorkflows` into
`usedBy` entries with the kind `workflow`. A requirement that already has `usedBy` stays as it is.
The fork writes only the new field.

| File | What the fork changes |
| --- | --- |
| `spec/legacy-requirements.ts` | The reader of the old field (fork file). |
| `spec/manifest.schema.ts` | `requirements` goes through the reader before the schema checks it. |
| `spec/__tests__/legacy-requirements.test.ts` | The tests of the reader (fork file). |

## Upstream updates

When an update changes the requirement schemas (`spec/requirements.schema.ts`), check that the
reader still gives valid requirements. Remove the reader only when no repository of the fork holds
a package with `usedByWorkflows`.
