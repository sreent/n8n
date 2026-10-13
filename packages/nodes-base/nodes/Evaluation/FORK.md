# The fork's Evaluation nodes

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md).

The Evaluation Trigger node gives the rows of a test dataset to a workflow, and the Evaluation
node writes the results of each row back. They are part of the evaluations that the owner chose
to rebuild on 2026-10-12. The fork files replace the enterprise files of the nodes, with the same
class names, node type names, versions and parameters, so saved workflows keep working.

| Fork file | Enterprise file that it replaces |
| --- | --- |
| `Evaluation/Evaluation.node.ts` | `Evaluation/Evaluation.node.ee.ts` |
| `Evaluation/Evaluation.node.json` | `Evaluation/Evaluation.node.ee.json` |
| `Evaluation/CannedMetricPrompts.ts` | `Evaluation/CannedMetricPrompts.ee.ts` |
| `EvaluationTrigger/EvaluationTrigger.node.ts` | `EvaluationTrigger/EvaluationTrigger.node.ee.ts` |
| `EvaluationTrigger/EvaluationTrigger.node.json` | `EvaluationTrigger/EvaluationTrigger.node.ee.json` |
| `common/descriptions.ts` | (new: the Google authentication field of both nodes) |

The parameters, the metric handlers and the helpers of the nodes are ordinary code and stay:
`Evaluation/Description.node.ts`, `utils/` and `methods/`.

## Behaviour

### The Evaluation node (versions 4.6, 4.7 and 4.8)

- **Set Inputs** and **Set Outputs** work only in an execution that an Evaluation Trigger started.
  Otherwise they add a hint and pass the items on. Set Outputs writes the outputs to the row of the
  dataset: to a Data table, or to a Google Sheet. Version 4.8 uses a Data table by default, older
  versions a Google Sheet.
- **Set Metrics** gives the metrics of each item: custom metrics, or a built-in metric
  (correctness and helpfulness, which a connected language model scores; string similarity;
  categorization; the tools used). Version 4.6 has custom metrics only.
- **Check If Evaluating** sends the items to the output "Evaluation" when an Evaluation Trigger
  started the execution, and to the output "Normal" in all other cases.
- The inputs and outputs of the node depend on the operation: a metric that a model scores adds
  the input "Model", and Check If Evaluating has two outputs.

### The Evaluation Trigger node (versions 4.6 and 4.7)

- Each run gives one row of the dataset, with `row_number` and `_rowsLeft`: the number of rows
  that come after it. The next run gives the next row. A run after the last row, or after a row
  with no rows left, starts again at the first row. Version 4.7 uses a Data table by default,
  version 4.6 a Google Sheet.
- **Data table.** The trigger reads the first row with an ID higher than the ID of the previous
  row (`row_id`), with the conditions of the node. `row_number` counts from 0. With a limit,
  `_rowsLeft` stops at the limit.
- **Google Sheet.** Row 1 is the header, so the first data row is row 2. The trigger reads the
  next row after `row_number`. With filters, it reads the next matching row. Without a limit,
  `_rowsLeft` counts the rows up to row 1000. With a limit, it counts the rows up to row
  `limit + 1`.
- **The rows for the test runner** (`customOperations.dataset.getRows`): all rows at once. A Data
  table gives up to 1000 rows (or the limit) in one request. A Google Sheet gives the rows up to
  row 1000 (or row `limit + 1`). With filters, it gives the first 999 matches (as many as rows 2 to
  1000 hold), or the first matches up to the limit. A match after row 1000 counts too.
- A dataset without rows, and a filter that matches no row, give the error "No row found".

### The canned prompts

The correctness and helpfulness metrics have default prompts. The fork wrote its own prompts:
the texts are not the texts of the enterprise file. They keep the variables in braces that the
ordinary metric handlers fill in: `{actual_answer}` and `{expected_answer}` for correctness,
`{user_query}` and `{actual_answer}` for helpfulness. A workflow that changed a prompt keeps its
own text. A workflow that kept the default prompt uses the fork prompt.

### The codex

The codex files of the fork come from the public documentation: the category "Core Nodes", the
links to the pages of the nodes, and the aliases of the trigger. They have no subcategories. The
description of the trigger has its own codex, and the node loader uses it before the codex file.
So only the codex file of the Evaluation node has an effect.

## Differences from the original

1. **The default prompts** of the correctness and helpfulness metrics have other texts (see
   above).
2. **An unknown operation** of the Evaluation node gives a `NodeOperationError`. The original gave
   a plain `Error`. The UI offers only the four operations. The lint rules of the nodes require a
   `NodeOperationError` in `execute`.
3. **The codex** of the fork has no subcategories, and the fork wrote its aliases of the
   Evaluation node (see above).
4. **A Google Sheet filter that matches no row** gives the error "No row found", as an empty
   dataset does. The original failed with a `TypeError` in this case.

## Clean-room sources

- The ordinary files of the nodes: `Evaluation/Description.node.ts`, `utils/evaluationUtils.ts`,
  `utils/evaluationTriggerUtils.ts`, `utils/metricHandlers.ts`, `methods/`, and their ordinary
  tests in `test/`.
- The ordinary helpers of the Data table and Google Sheets nodes, and the node loader of
  `n8n-core`.
- The public documentation of the nodes:
  [Evaluation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.evaluation/) and
  [Evaluation Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.evaluationtrigger/).
- The behaviour of the original files, recorded black-box by the golden test below. The
  enterprise files were not read.

## The golden test

`test/Evaluation.golden.test.ts` records the descriptions of the two nodes, and the results of the
nodes for a matrix of parameters and versions, with mocked Data table and Google Sheets calls. It
records the calls that reach the Data table and the Google Sheet, not the reads of the
parameters. The snapshot does not hold the texts of the canned prompts: it shows their names
only. The snapshot was recorded against the enterprise files. The fork files give the same
snapshot, except the outcomes of differences 2 and 4 above.

To record the snapshot again after an upstream update, use a checkout of the upstream commit in
`scripts/sync-upstream.base`. Copy the golden test and its snapshot into the same folder there,
point the imports at the `.ee` files, and run the test with `-u`.
