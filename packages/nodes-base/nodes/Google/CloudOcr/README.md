# Google Cloud OCR

Fork node (not in upstream n8n): `n8n-nodes-base.googleCloudOcr`. It reads the text of images and
documents with the OCR of Google Cloud. The repository owner chose it on 2026-10-15, with the AI
gateway of the fork (`packages/cli/src/modules/ai-gateway`).

Sources: the public documentation of the
[Cloud Vision API](https://cloud.google.com/vision/docs/ocr) (`images:annotate`, `files:annotate`)
and of [Document AI](https://cloud.google.com/document-ai/docs/send-request)
(`processors/<id>:process`), and the ordinary Google nodes of n8n.

## Operations

- **Read Text** (Cloud Vision API): the text of an image (a binary file, a public URL or a
  `gs://` URI of Cloud Storage), or of a PDF, TIFF or GIF file. The node reads a file 5 pages at a
  time (the most of one request of `files:annotate`): the first request leaves out the pages, so
  that the API gives the page count, and the next requests ask for the next pages up to the option
  **Max Pages** (default 20). The text type is **Document (Dense Text)**
  (`DOCUMENT_TEXT_DETECTION`, for scans) or **Text in Images (Sparse Text)** (`TEXT_DETECTION`, for
  photos). The option **Language Hints** gives the languages of the text, for example `en,de`. The
  output has `text`, `pageCount`, the text of each page (`pages`) and the language of an image.
- **Process Document** (Document AI): a binary file through a processor, for example the Document
  OCR, the Form Parser or an invoice processor. The processor is its resource name
  (`projects/<project>/locations/<location>/processors/<id>`, with an optional
  `/processorVersions/<id>`). The output has `text`, `pageCount` and the `entities` (type, text,
  confidence and normalized value).
- The option **Include Full Response** adds the full answer of the API.
- The node is also a tool of an AI agent (`usableAsTool`), as the ordinary Google nodes are. The
  agent can fill the parameters, for example the **Image URL** of **Read Text**. The tool variant
  offers **Use Gateway credits** too, because the editor compares node types without the suffix
  `Tool`.

## Authentication

- **API Key** (default): the credential type `googleCloudOcrApi` (fork) with an API key of the
  Cloud Vision API. Document AI takes no API keys, so **Process Document** fails with an API key of
  Google. The credential has a URL field: the AI gateway of the fork replaces it, so the option
  **Use Gateway credits** works for this node. With the gateway, the node sends both operations to
  the URL of the credential, and the gateway calls Google with the credential of the admin. The
  gateway reads only a binary file or a public URL: it refuses a Cloud Storage URI (`gs://`). An
  admin can limit the processors of Document AI that the gateway serves.
- **Service Account**: the ordinary credential type `googleApi`. The token has the scope
  `cloud-platform`, which both APIs take.

## Files

- `GoogleCloudOcr.node.ts`: the node and the two operations.
- `GoogleCloudOcr.node.json`: the codex of the node (its categories and documentation links).
- `GenericFunctions.ts`: the requests to the two APIs with the credential of the node.
- `googleCloudOcr.svg`: the icon of the fork.
- `test/GoogleCloudOcr.node.test.ts`: the operations, the paging of a PDF, the hosts of the two
  APIs, the URL of the gateway and the errors.
- `packages/nodes-base/credentials/GoogleCloudOcrApi.credentials.ts`: the credential type.

## Upstream updates

The node and its credential type are registered in `packages/nodes-base/package.json`. When an
upstream update changes the lists of that file, keep the two lines of the fork.
