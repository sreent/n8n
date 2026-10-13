# The fork's AI workflow builder package

Fork document (not in upstream n8n). Read it with [FORK.md](../../../FORK.md).

This package replaces the enterprise package `packages/@n8n/ai-workflow-builder.ee`, with the same
package name `@n8n/ai-workflow-builder`. It has only the parts that the n8n server uses without a
service of n8n: the parts that the MCP tools of the workflow builder and the builder sessions use.
The owner chose to rebuild these local parts on 2026-10-12. The chat of the AI builder needs a
service of n8n, so the fork does not have it. Ordinary code and its tests do not change: they
import the same names from the same package name.

## Exports

| Export | Users | What it does |
| --- | --- | --- |
| The tool constants (`CODE_BUILDER_*_TOOL`, `MCP_*_TOOL`) | The MCP tools in `cli/src/modules/mcp` | The name and the title of each tool. |
| `SDK_IMPORT_STATEMENT` | The SDK reference of the MCP tools | The import line of the 24 functions of the Workflow SDK. |
| `stripImportStatements` | The validate and create tools | Removes the import lines from workflow code. |
| `ParseValidateHandler` | The validate, create and update tools | Turns workflow code into workflow JSON, and checks a workflow. |
| `getWarningKey`, `ValidationWarning` | The update tool | Compares the warnings before and after an update. |
| `WorkflowCodeParseError` | The hint of the MCP tools (by its name) | The error of code that does not parse. |
| `isLangchainMessagesArray`, `ISessionStorage`, `StoredSession`, `LangchainMessage` | The repository of the module `workflow-builder` | The types of a stored chat session. |
| `createPassthroughSsrfGuard` | `WorkflowBuilderService` of cli | A guard that allows each address, when the SSRF protection is off. |
| `AiWorkflowBuilderService`, `ChatPayload`, `ChatStreamChunk`, `ResourceLocatorCallbackFactory` | `WorkflowBuilderService` of cli | A stand-in for the chat. See below. |

## Behaviour

- **Parse and validate.** `parseAndValidate(code)` gives the code to `parseWorkflowCodeToBuilder` of
  the Workflow SDK, gives the nodes stable IDs (`regenerateNodeIds`), and makes the workflow JSON
  with the layout of the SDK (`toJSON({ tidyUp: true })`). Then it runs the graph checks of the
  builder and `validateWorkflow` of the SDK on that JSON, with the node types of the server. The
  warnings keep the order of the checks, once for each key of `getWarningKey`, and have only
  `code`, `message` and `nodeName`. Each error, also an error of the node types, becomes a
  `WorkflowCodeParseError` with the text "Failed to parse generated workflow code: " before its
  message.
- **Validate JSON.** `validateJSON(workflow)` runs the same checks on the workflow JSON as it is.
  A workflow without nodes gives no warnings. Errors are thrown as they are.
- **Parameter schemas.** The schema checks of the SDK use the folders of the node definitions that
  the node catalog of the server sets (`setSchemaBaseDirs`). The handler does not change them.
- **Import lines.** `stripImportStatements` removes each whole line with an import statement, the
  first empty line that they leave, and the outer whitespace. Imports in comments and strings,
  re-exports and dynamic imports stay.

## The chat stand-in

The ordinary `WorkflowBuilderService` of cli still makes an `AiWorkflowBuilderService`, and the REST
routes of the chat stay behind the licence feature `feat:aiBuilder`. The stand-in takes the same
arguments and does nothing with them:

- `chat` and `getBuilderInstanceCredits` fail with the `UserError` "The AI workflow builder chat is
  not available in this n8n."
- `getSessions` gives `{ sessions: [] }`, `clearSession` does nothing, and `truncateMessagesAfter`
  gives `false`.
- `updateNodeTypes` does nothing.

## Differences from the original

1. **No chat.** See above. The original asked a service of n8n or a language model.
2. **No sample data.** The handler does not make pin data. The MCP tools always set
   `generatePinData: false`, and the option stays for them.
3. **Fewer exports.** The original package had 34 run-time exports. The fork package has 19 of
   them. It leaves out the prompts (`ADDITIONAL_FUNCTIONS`, `EXPRESSION_REFERENCE`,
   `WORKFLOW_PATTERNS`, `WORKFLOW_RULES`), the agent classes (`AssistantHandler`,
   `CodeBuilderAgent`, `CodeWorkflowBuilder`), the LangChain tool factories
   (`createCodeBuilderGetTool`, `createCodeBuilderSearchTool`, `createGetSuggestedNodesTool`),
   `resolveConnections`, `WorkflowState` and the recommendation categories (`categories`,
   `RecommendationCategory`, `RecommendationCategoryDescription`). Ordinary code uses none of them.
   The SDK reference text is in `@n8n/workflow-sdk`, and the node search is in
   `@n8n/ai-utilities`.
4. **The pairwise evaluation of the n8n Assistant.** The development script
   `instance-ai/evaluations/cli/pairwise.ts` (`pnpm eval:pairwise`) imports the evaluation code of
   the enterprise package, so it does not run in the fork. The build, the type check and the lint
   leave it out, as upstream does.

## Sources

- The ordinary users of the package: the MCP tools, `WorkflowBuilderService` of cli and its tests,
  the AI controller and its tests, and the repository of the module `workflow-builder`.
- The ordinary code of `@n8n/workflow-sdk` (the parser, the builder, the validators) and the
  ordinary parse helper of the n8n Assistant evaluations (`parse-seed-workflow.ts`).
- The behaviour of the original package, recorded black-box: the names and the kinds of its
  exports, the values of its constants, and the golden test below. The enterprise files were not
  read.

## Tests

- `packages/cli/src/services/__tests__/golden/ai-workflow-builder.golden.test.ts`: the constants,
  `stripImportStatements` on 19 inputs, `getWarningKey`, `parseAndValidate` on 34 code samples and
  `validateJSON` on 15 workflows, each without and with the node definitions of the server, a
  handler without node types, `isLangchainMessagesArray` and the passthrough guard. The node types
  come from the built descriptions of `n8n-nodes-base` and `@n8n/n8n-nodes-langchain`, and an
  unknown type throws, as on the server. The SDK gives random webhook IDs and random names of
  sticky notes; the test replaces them with labels.
- `src/__tests__/ai-workflow-builder.test.ts`: the unit tests of this package, the chat stand-in
  too.

The snapshot was recorded against the enterprise package, twice with the same result. The fork
package gives the same snapshot. The fork no longer has the enterprise package. To record the
snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`: copy the folder `__tests__/golden` into
`packages/cli/src/services/__tests__/` there, build `@n8n/ai-workflow-builder`, and run the test
with `--update=all`. `subject.ts` imports the package by its name, so it needs no change.

## Clean-room record

- I did not open a file of the enterprise package. I deleted the package by its folder name.
- A probe of the exports told classes from functions by the first 6 characters of the function
  text (the word `class`). It printed only the kind of each export. Later probes did not read the
  function text.
- `git` shows `tsconfig.build.json` of this package as a rename of the file of the enterprise
  package, because the two files are alike. The file is a copy of `tsconfig.build.json` of
  `@n8n/backend-network`, a common template of the backend packages. I did not compare it with the
  enterprise file.
