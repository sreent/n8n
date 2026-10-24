# AI gateway checks on your server

Fork document (not in upstream n8n). Git keeps the versions of these checks, and pull requests
review their changes. The Claude Doc [AI gateway checks on your
server](https://claude.ai/artifact/2t9jmL4C4VLQnAWRUH4BvW) has the same checks. Tick the items in
the doc, not in this file. When you change the checks in one of them, change the other in the same
way.

## Before you start

These checks take about 30 minutes on the server that runs `deploy/`, with version
`2.45.0-7c9d2ab9d3`. Run the nodes as a member, not as the admin, so that the budgets and the tab
**Usage** show a normal user.

- [ ] In `deploy/.env`, set `N8N_IMAGE=ghcr.io/sreent/n8n:2.45.0-7c9d2ab9d3` and
  `N8N_RUNNERS_IMAGE=ghcr.io/sreent/n8n-runners:2.45.0-7c9d2ab9d3`.
- [ ] In `deploy/`, run `docker compose pull`, then `docker compose up -d`. The first start runs the
  database migrations of the new version.
- [ ] `docker compose logs -f n8n` shows no migration error, and n8n opens in the browser.
- [ ] Open **Settings > Usage and plan**. It says "Fork features are on". Gateway credits need the
  fork switch.
- [ ] As the owner or an admin, open **Settings > Gateway credits admin** and turn on **Turn on
  Gateway credits**.
- [ ] On the tab **Budgets**, set a small monthly budget, for example $5, so that a mistake costs
  little.

| Check | Credential type in n8n | What the credential needs |
| --- | --- | --- |
| Azure OpenAI | Azure OpenAI | A resource with a deployment named like a model, for example `gpt-4o-mini` |
| Vertex AI, open models, Document AI | Google Service Account | A project with the Vertex AI API, the Document AI API and the Cloud Vision API on, and the roles Vertex AI User and Document AI API User |
| Read Text with an API key | Google Cloud OCR API | An API key that can call the Cloud Vision API |
| Running the nodes | (a user) | A member account |

## Azure OpenAI

Pass: a member runs an OpenAI Chat Model node with Gateway credits, and the call runs on your Azure
deployment with a cost on the tab **Usage**.

- [ ] As the admin, create an Azure OpenAI credential with the API key and the resource name (or the
  endpoint).
- [ ] On the tab **Providers**, pick that credential for **OpenAI**. Enter the name of your
  deployment in **Deployments**, and save.
- [ ] On the tab **Prices**, check the price of the deployment. A deployment named like a model, for
  example `gpt-4o-mini`, has the list price. For another name, set a price with the provider OpenAI
  and the deployment name as the model.
- [ ] As the member, add an AI Agent with an OpenAI Chat Model node. Pick **Use Gateway credits** as
  the credential and your deployment as the model. Send one short message.
- [ ] The answer comes. On the tab **Usage**, one new row has the provider OpenAI, your deployment
  as the model, input and output tokens, and a cost, with no mark **Estimate**.
- [ ] Send one more message with streaming on in the chat. Its row also has tokens and a cost,
  because the gateway asks Azure for the usage of a stream.

## Vertex AI

Pass: the Gemini nodes run on Vertex AI with the service account, and an open model of the Model
Garden answers through the OpenAI nodes.

Gemini models:

- [ ] As the admin, create a Google Service Account credential with the e-mail and the private key
  of the service account. Its region is the default location.
- [ ] On the tab **Providers**, pick the service account for **Google Gemini**. Leave **Project ID**
  and **Location** empty, or set them (for example `global` or `europe-west4`), and save.
- [ ] As the member, run a Google Gemini Chat Model node with **Use Gateway credits** and
  `gemini-2.5-flash`. The answer comes, and the tab **Usage** has a row for `gemini-2.5-flash` with
  a cost.
- [ ] In the Google Gemini node, the document and image analysis does not offer **Use Gateway
  credits**. That is expected: Vertex AI has no File API.

Open models:

- [ ] In the Model Garden of the project, turn on an open model, for example Llama 3.3 70B
  (`meta/llama-3.3-70b-instruct-maas`), in a region that serves it.
- [ ] On the tab **Providers**, in the section **Open models of Vertex AI** of OpenAI, pick the
  service account and the location of the model, and save.
- [ ] On the tab **Prices**, set a price for the provider OpenAI and the model
  `meta/llama-3.3-70b-instruct-maas`. The list prices have no open models.
- [ ] As the member, run an OpenAI Chat Model node with **Use Gateway credits**, this model and
  **Use Responses API** off. The answer comes, and the tab **Usage** has a row for the model.
- [ ] With **Use Responses API** on, the call fails with a message that tells you to turn it off.
  That is expected.

## Google Cloud OCR

Pass: the node reads text through the gateway, first with the admin's API key (Read Text only), then
with the service account (also Process Document). The tab **Usage** counts pages and images, not
tokens.

With an API key:

- [ ] As the admin, create a Google Cloud OCR API credential with the Vision API key. On the tab
  **Providers**, pick it for **Google Cloud OCR**, and save.
- [ ] As the member, add a Google Cloud OCR node with the authentication **API Key**, **Use Gateway
  credits**, the operation **Read Text**, and an image as the binary input. The output has the text.
- [ ] The tab **Usage** has a row with the model `vision-ocr` and 1 as the input.
- [ ] Read a PDF of 6 to 10 pages. The node sends two requests, so the tab **Usage** has two rows: 5
  pages and the rest.
- [ ] Pick the operation **Process Document**. **Use Gateway credits** is not offered, because
  Document AI takes no API keys.
- [ ] Set **Input Type** to **Image URL** with a `gs://` URI. The call fails: the gateway reads only
  the content of a file or a public URL.

With the service account:

- [ ] On the tab **Providers**, pick the service account for **Google Cloud OCR**, and save.
- [ ] As the member, run **Process Document** with a PDF and the processor
  `projects/<project>/locations/<location>/processors/<ID>`. The output has the text, the page count
  and the entities.
- [ ] The tab **Usage** has a row with the model `document-ai/<ID>` and the page count as the input.

## Estimates

Pass: a call that you stop gets a row with the mark **Estimate**, and with the switch off it gets no
row.

- [ ] On the tab **Prices**, the switch **Estimate the usage of calls without usage** is on.
- [ ] As the member, ask an OpenAI Chat Model node for a long answer (for example 800 words), run
  the workflow, and click **Stop** after 2 or 3 seconds.
- [ ] The tab **Usage** has a row with the mark **Estimate**. Its output tokens are about a quarter
  of the characters that arrived before the stop.
- [ ] If the row has no mark, the stop came after the end of the answer. Ask for a longer answer and
  stop sooner.
- [ ] Turn the switch off, and stop a long answer again. The tab **Usage** shows no new row.
- [ ] Turn the switch on again.

## Document AI prices

Pass: a processor with its own price costs that price, and another processor costs the price of
`document-ai` ($1.50 for 1,000 pages).

- [ ] On the tab **Prices**, pick the provider **Google Cloud OCR**. A hint about `document-ai/`
  shows under the form.
- [ ] Set a price for `document-ai/<ID of an expensive processor>`, for example a Form Parser: input
  `30000` ($30 for 1,000 pages), output `0`.
- [ ] Run **Process Document** with that processor. The cost on the tab **Usage** is the page count
  × $0.03.
- [ ] Run **Process Document** with a processor that has no price of its own. The cost is the page
  count × $0.0015.
- [ ] For the safe setup, set the price of `document-ai` to the price of your most expensive
  processor, and give the cheaper processors their own prices.

## Processors of Document AI

Pass: the gateway serves only the processors in the list, and a call of another processor fails with
no new row on the tab **Usage**.

- [ ] On the tab **Providers**, next to the service account of **Google Cloud OCR**, enter one
  processor in **Processors of Document AI**, for example
  `projects/<project>/locations/<location>/processors/<ID>`, and save. A prediction endpoint from
  the Google Cloud console also works.
- [ ] Run **Process Document** with that processor. The text comes, as before.
- [ ] Run **Process Document** with another processor. The node fails with "Gateway credits don't
  serve this processor of Document AI", and the tab **Usage** shows no new row.
- [ ] Replace the entry with `projects/<project>`, and save. All processors of the project work
  again.
- [ ] If a call fails while its project is in the list, compare the project in the node with the
  list: one has the project ID and the other has the project number. Use the same form in both, or
  add both.
- [ ] Keep a list for the safe setup, or empty the field to serve all processors of the service
  account.

## AI features of the fork

Gateway credits are one of the enterprise features that the fork switch turns on for all users. The
[adoption guide](../FORK-ADOPTION.md) lists these AI features:

| Feature | Who sets it up, and where | Also needs |
| --- | --- | --- |
| Gateway credits: AI nodes without an API key of the user | An admin on **Settings > Gateway credits admin**. Users pick **Use Gateway credits** on an AI node | A credential of each provider |
| Evaluations without a limit of workflows | Builders, on the tab **Evaluations** of a workflow | `deploy/` turns on the collections and the evaluations of configs and agents, with 5 parallel cases |
| The n8n Assistant with a model of your own | An admin, with the settings `N8N_INSTANCE_AI_*` |  |

The fork does not have the chat of the AI assistant and of the AI builder, or AI credits, because
they need a service of n8n. Gateway credits use the accounts of your organisation with the AI
providers.

- [ ] As the member, open the tab **Evaluations** of a workflow. It shows the evaluations, not the
  paywall "Evaluations are off".

## When a check fails

The node shows the error of the gateway. Find the text in the table. For more details, run
`docker compose logs -f n8n` in `deploy/` and do the call again: the gateway writes a warning when
it cannot reach the provider, cannot sign in to Google Cloud, or records an estimate.

| What you see | What to check |
| --- | --- |
| Gateway credits are off. | The switch at the top of **Settings > Gateway credits admin** is on. `deploy/.env` does not set `N8N_AI_GATEWAY_ENABLED` or `N8N_FORK_FEATURES_ENABLED` to `false`. |
| Gateway credits have no credential for … | On the tab **Providers**, pick a credential for that provider, and save. |
| The model … has no price in Gateway credits. | On the tab **Prices**, set a price for that provider and model. For Azure, the model is the name of the deployment. |
| The Gateway credits of this instance are spent, or a monthly budget or limit of Gateway credits is spent | The tab **Overview** shows what is left. Raise the budget or the limit on the tab **Budgets**, or add a top-up. |
| Gateway credits couldn't sign in to Google Cloud with the credential of the admin. | The e-mail and the private key of the Google Service Account credential. The key is still active in Google Cloud. |
| Gateway credits need the project of Google Cloud for Vertex AI. | Set **Project ID** next to the service account on the tab **Providers**. |
| The open models of Vertex AI support only Chat Completions. | Turn off **Use Responses API** on the OpenAI Chat Model node. |
| Document AI takes no API keys. | Pick a service account for **Google Cloud OCR** on the tab **Providers**. |
| Gateway credits don't serve this processor of Document AI. | Add the processor, its location or its project to **Processors of Document AI** on the tab **Providers**. Name the project as the node does: with its ID or with its number. |
| Gateway credits read only the content of a file or a public URL, not a file of Cloud Storage. | Send the file as binary data or as an `https` URL, not as a `gs://` URI. |
| Gateway credits couldn't reach the provider. | The log has the cause. Check the resource name or the endpoint of the credential, and the network of the server. |
| An error of Google with the code 403 | The API is on in the project, and the service account has the role Vertex AI User or Document AI API User. |
| An error of Azure with the code 404 | The deployment name on the tab **Providers** is the same as in Azure, and the deployment supports the API that the node calls. |
| No new row on the tab **Usage** | The call stopped before the provider answered, or the switch of the estimates is off and the answer had no usage. |
